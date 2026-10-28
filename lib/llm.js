/**
 * LLM 调用模块：模型候选链、一次流式生成的收集、无正文原因、reasoning off 探测。
 *
 * 与 dsh-pet 的 chat.ts / model-selection.ts / llm-call.ts 同构（那是权威写法），差异：
 *   - `@deepseek-ai/dsh-llm` 用**动态 import**：宿主运行时能解析 bare import；而单测在包目录里
 *     `node --test` 跑，解析不到 DSH 的私有包。动态 import 让本模块在两种环境都能被加载，
 *     只有真正调模型时才需要 DSH 运行时（调用失败也有结构化原因，不会拖垮宿主）。
 *
 * 硬约束：这里抛出的任何异常都必须被调用方（以及本模块自己）接住 —— 宿主里未捕获异常会终止进程。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 调用身份（sessionId）：适配器据此生成服务商需要的载体，值只需稳定，不要求是真实会话 id */
export const PET_CALL_IDENTITY = 'dsh-whale-chat'

/** 单次生成超时：对话与转述都是闲聊级任务，60s 足够（SPEC §5.2） */
export const DEFAULT_TIMEOUT_MS = 60_000

/** DSH 的 LLM 统一抽象层包名 */
const LLM_PACKAGE = '@deepseek-ai/dsh-llm'

/**
 * 兜底：从宿主安装位置找 dsh-llm 的 ESM 入口。
 *
 * 为什么需要：DSH 对 `link:` 安装的插件有「链接目录」解析规则——只有在插件（或某一层祖先）
 * 的 package.json 的 `peerDependencies` 里声明过 @deepseek-ai/*，才会映射到宿主安装的包；
 * 否则 native 解析会报 ERR_MODULE_NOT_FOUND。开发期常用 link 安装，所以这里从
 * ① Electron 桌面安装（<exe>/resources/app.asar/dsh/node_modules）
 * ② 宿主入口脚本（CLI/worker）向上的最近 node_modules
 * 里直接找入口，仍然用动态 import 加载（同一文件 URL 命中 Node 模块缓存，不会加载出第二份）。
 * 正常情况（声明了 peerDependencies，或非 link 安装）永远走不到这条路。
 */
function findHostLlmEntry() {
  const manifestPath = path.join(LLM_PACKAGE, 'package.json')
  const roots = []
  const addRoot = (dir) => {
    if (!dir) return
    const nodeModules = path.basename(dir) === 'node_modules' ? dir : path.join(dir, 'node_modules')
    if (!roots.includes(nodeModules)) roots.push(nodeModules)
  }
  try {
    addRoot(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules'))
  } catch {
    /* 忽略 */
  }
  let args = []
  try {
    args = Array.isArray(process.argv) ? process.argv.slice(1) : []
  } catch {
    args = []
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || !path.isAbsolute(arg)) continue
    let dir = path.dirname(arg)
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(dir, 'node_modules')
      if (existsSync(path.join(candidate, manifestPath))) {
        if (!roots.includes(candidate)) roots.push(candidate)
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const root of roots) {
    if (!existsSync(path.join(root, manifestPath))) continue
    try {
      const manifest = JSON.parse(readFileSync(path.join(root, manifestPath), 'utf8'))
      const exportsField = manifest && manifest.exports ? manifest.exports['.'] : undefined
      const relative =
        typeof exportsField === 'string'
          ? exportsField
          : exportsField && typeof exportsField.default === 'string'
            ? exportsField.default
            : typeof manifest.main === 'string'
              ? manifest.main
              : './lib/index.js'
      const entry = path.resolve(root, LLM_PACKAGE, relative)
      if (existsSync(entry)) return entry
    } catch {
      /* 读不出来就试下一个候选 */
    }
  }
  return null
}

/** 懒加载 dsh-llm：成功缓存；失败清空缓存（下次还能重试，不把一次偶发失败钉死） */
let llmApiPromise = null
export function loadLlmApi() {
  if (!llmApiPromise) {
    llmApiPromise = import(LLM_PACKAGE)
      .catch((importError) => {
        const entry = findHostLlmEntry()
        if (!entry) throw importError
        console.log(`[dsh-whale-chat] 按包名加载 dsh-llm 失败，改用宿主安装位置：${entry}`)
        return import(pathToFileURL(entry).href)
      })
      .catch((error) => {
        llmApiPromise = null
        throw error
      })
  }
  return llmApiPromise
}

/** 取错误文案（截断，避免把整段堆栈/网页内容写进响应） */
function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return text.trim().slice(0, 300) || '原因不明'
}

/** 安全地把一个选择对象规范成 {provider,model}；缺一半/类型不对 → undefined */
function asModelRef(selection) {
  if (!selection || typeof selection !== 'object') return undefined
  const provider = typeof selection.provider === 'string' ? selection.provider.trim() : ''
  const model = typeof selection.model === 'string' ? selection.model.trim() : ''
  return provider && model ? { provider, model } : undefined
}

/** 配置里指定给本插件单独用的模型（chat.provider + chat.model）；都空 = 跟随当前对话 */
export function configuredModel(chatConfig) {
  return asModelRef(chatConfig)
}

/** 当前对话的模型（agentDefaultModel.currentSelection）；未配置 / 抛错 → undefined */
export function currentModel(ctx) {
  try {
    return asModelRef(ctx?.agentDefaultModel?.currentSelection?.())
  } catch {
    return undefined
  }
}

/**
 * 候选链：配置的模型优先，其次当前对话的模型；同一个 provider/model 只留一次。
 * 返回空数组 = 两个来源都拿不到 → 生成侧报「当前对话未配置模型」。
 */
export function modelCandidates(ctx, preferred) {
  const out = []
  const push = (model) => {
    if (!model) return
    if (out.some((item) => item.provider === model.provider && item.model === model.model)) return
    out.push(model)
  }
  push(asModelRef(preferred))
  push(currentModel(ctx))
  return out
}

/** 报错/日志用的选择标签：provider/model */
export function modelLabel(model) {
  return model ? `${model.provider}/${model.model}` : '（未配置模型）'
}

/** 没有正文时，按流终止原因给出要展示的中文原因（与 dsh-pet llm-call.ts 同源） */
export function noTextReason(finish) {
  const { kind, failure } = finish ?? {}
  if (kind === 'aborted') return '生成已取消'
  if (kind === 'max-tokens') return '输出达到上限，未产出正文'
  if (kind !== 'error') return '模型未返回文本'
  const message = failure && typeof failure.message === 'string' ? failure.message.trim() : ''
  if (message) return message
  const code = failure && typeof failure.code === 'string' ? failure.code.trim() : ''
  if (code) return code
  return '未提供失败原因'
}

/** 从 BlockAssembler.blocks() 里拼出正文（只取 text 块，trim 掉首尾空白） */
export function collectText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('').trim()
}

/**
 * 当前 provider/model 是否声明支持 reasoning effort（含 "off"）。
 * 无 reasoning 元数据的模型显式传 off 会被 dsh-llm 判为 UNSUPPORTED_REASONING_EFFORT 并折叠成空流，
 * 所以只有模型确实声明支持时才传；查询能力缺失/失败一律保守返回 false（= 不传）。
 */
export async function supportsReasoningOff(ctx, provider, model) {
  const llm = ctx?.llm
  if (!llm || typeof llm.resolveModelInfo !== 'function') return false
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return info?.reasoning?.efforts?.some((effort) => effort?.id === 'off') ?? false
  } catch {
    return false
  }
}

/** 失败结果 → 面向用户的中文错误（reason 给机器读，error 给人看） */
export function failureMessage(result) {
  const reason = result?.reason
  const message = result?.message || '原因不明'
  if (reason === 'no-model') return '当前对话未配置模型'
  if (reason === 'llm-unavailable') return `LLM 服务不可用：${message}`
  if (reason === 'timeout') return `等它回复等太久了：${message}`
  if (reason === 'empty') return `模型没有给出正文（${message}）`
  return `生成失败：${message}`
}

/**
 * 用候选链里的一个确定选择跑一次生成（失败原样返回结构化原因，不吞）。
 * @returns {Promise<{ok:true,text:string,model:{provider,model}} | {ok:false,reason:string,message:string,model?:object}>}
 */
async function generateWith(ctx, llm, api, selection, options) {
  const { BlockAssembler, ReasoningEffortId, createAssistantMessage, createUserMessage } = api
  try {
    const historyMessages = (Array.isArray(options.history) ? options.history : []).map((message) =>
      message.role === 'user'
        ? createUserMessage({
            content: [{ type: 'text', text: String(message.content ?? '') }],
            source: { kind: 'user' },
          })
        : createAssistantMessage({
            content: [{ type: 'text', text: String(message.content ?? '') }],
            source: { provider: selection.provider, model: selection.model },
          }),
    )
    const supportsOff = await supportsReasoningOff(ctx, selection.provider, selection.model)
    const request = {
      provider: selection.provider,
      model: selection.model,
      sessionId: PET_CALL_IDENTITY,
      messages: [
        ...historyMessages,
        createUserMessage({
          content: [{ type: 'text', text: String(options.userText ?? '') }],
          source: { kind: 'user' },
        }),
      ],
      system: options.system ?? '',
      temperature: options.temperature,
      signal: AbortSignal.timeout(options.timeoutMs),
      // 仅模型声明支持时传：闲聊不需要深度思考
      ...(supportsOff ? { reasoningEffort: ReasoningEffortId('off') } : {}),
    }
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of llm.stream(request)) {
        assembler.push(chunk)
      }
    } catch (error) {
      const name = error && typeof error.name === 'string' ? error.name : ''
      const aborted = name === 'TimeoutError' || name === 'AbortError'
      return {
        ok: false,
        reason: aborted ? 'timeout' : 'generate-error',
        message: aborted ? `${Math.round(options.timeoutMs / 1000)} 秒内没有回复` : errorMessage(error),
        model: selection,
      }
    }
    const text = collectText(assembler.blocks())
    if (!text) {
      return { ok: false, reason: 'empty', message: noTextReason(assembler.finish), model: selection }
    }
    return { ok: true, text, model: selection }
  } catch (error) {
    return { ok: false, reason: 'generate-error', message: errorMessage(error), model: selection }
  }
}

/**
 * 生成一段文本：候选链逐个尝试，第一个成功的返回。
 *
 * @param {object} ctx 宿主上下文（需要 llm 与 agentDefaultModel）
 * @param {object} options
 * @param {string} options.system system 提示词（人设）
 * @param {Array<{role:'user'|'assistant',content:string}>} [options.history] 历史（时间正序）
 * @param {string} options.userText 本次指令/用户输入
 * @param {number} [options.temperature] 温度
 * @param {number} [options.timeoutMs] 超时
 * @param {{provider:string,model:string}} [options.preferred] 配置里指定的模型（优先进候选链）
 * @returns {Promise<{ok:true,text:string,model:object} | {ok:false,reason:string,error:string,message:string}>}
 */
export async function generateText(ctx, options = {}) {
  const settings = {
    system: typeof options.system === 'string' ? options.system : '',
    history: Array.isArray(options.history) ? options.history : [],
    userText: typeof options.userText === 'string' ? options.userText : '',
    temperature: Number.isFinite(options.temperature) ? options.temperature : 1,
    timeoutMs: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
  }
  const candidates = modelCandidates(ctx, options.preferred)
  if (candidates.length === 0) {
    const failure = { ok: false, reason: 'no-model', message: '当前对话未配置模型' }
    return { ...failure, error: failureMessage(failure) }
  }
  const llm = ctx?.llm
  if (!llm || typeof llm.stream !== 'function') {
    const failure = { ok: false, reason: 'llm-unavailable', message: '没有可用的模型服务' }
    return { ...failure, error: failureMessage(failure) }
  }
  let api
  try {
    api = await loadLlmApi()
  } catch (error) {
    const failure = { ok: false, reason: 'llm-unavailable', message: `加载模型模块失败（${errorMessage(error)}）` }
    return { ...failure, error: failureMessage(failure) }
  }

  let last = null
  for (let index = 0; index < candidates.length; index += 1) {
    const selection = candidates[index]
    const result = await generateWith(ctx, llm, api, selection, settings)
    if (result.ok) return result
    last = result
    // 回落要留痕：配的模型没生效时能在日志里看到原因（否则“我明明配了 A，怎么还是用 B”没法查）
    if (index + 1 < candidates.length) {
      console.log(
        `[dsh-whale-chat] 用 ${modelLabel(selection)} 生成失败（${result.message}），` +
          `回落到 ${modelLabel(candidates[index + 1])}`,
      )
    }
  }
  return { ...last, error: failureMessage(last) }
}
