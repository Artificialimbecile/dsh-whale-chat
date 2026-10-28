/**
 * 对话模块：memory.json 的读写 + 一次对话生成。
 *
 * 存储形状（SPEC §2）：{ messages: [{ role:'user'|'assistant', content, ts, kind }] }，最多 1000 条。
 * 生成失败时**什么都不写**（user 也不写）——记忆里只留真的发生过的对话，否则下一轮模型会看到
 * 一句用户说、她没有回的半截对话，回复会越来越怪。
 *
 * 文件路径一律由调用方传入（index.js 用 config.dataPaths() 算），单测因此不需要碰 DSH_HOME。
 */
import path from 'node:path'
import { atomicWriteJson, readJsonFile } from './config.js'
import { buildSystemPrompt } from './persona.js'
import { configuredModel, generateText } from './llm.js'

/** 记忆上限（SPEC §2） */
export const MEMORY_LIMIT = 1000

/** 空记忆 */
export function emptyMemory() {
  return { messages: [] }
}

/** 把磁盘上的内容规范成 {messages:[...]}：坏条目丢弃，绝不让脏数据进上下文 */
export function normalizeMemory(raw) {
  const messages = []
  if (raw && Array.isArray(raw.messages)) {
    for (const item of raw.messages) {
      if (!item || typeof item !== 'object') continue
      const role = item.role === 'user' || item.role === 'assistant' ? item.role : null
      const content = typeof item.content === 'string' ? item.content : ''
      if (!role || !content) continue
      messages.push({
        role,
        content,
        ts: Number.isFinite(item.ts) ? item.ts : 0,
        kind: typeof item.kind === 'string' && item.kind ? item.kind : 'chat',
      })
    }
  }
  return { messages }
}

/** 读记忆（文件缺失/损坏 → 空记忆） */
export function readMemory(file) {
  return normalizeMemory(readJsonFile(file, emptyMemory()))
}

/** 写记忆（原子写） */
export function writeMemory(file, memory) {
  const clean = normalizeMemory(memory)
  atomicWriteJson(file, clean)
  return clean
}

/**
 * 追加若干条消息并落盘；超过上限时从头丢（保留最近的）。
 * @returns {{messages:Array, count:number}}
 */
export function appendMessages(file, entries) {
  const memory = readMemory(file)
  for (const entry of entries) {
    if (!entry || (entry.role !== 'user' && entry.role !== 'assistant')) continue
    const content = typeof entry.content === 'string' ? entry.content : ''
    if (!content) continue
    memory.messages.push({
      role: entry.role,
      content,
      ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
      kind: typeof entry.kind === 'string' && entry.kind ? entry.kind : 'chat',
    })
  }
  if (memory.messages.length > MEMORY_LIMIT) {
    memory.messages = memory.messages.slice(memory.messages.length - MEMORY_LIMIT)
  }
  writeMemory(file, memory)
  return { messages: memory.messages, count: memory.messages.length }
}

/**
 * 取最近 N 轮历史：一轮 = 一问一答，所以最多 2N 条，且必须从 user 开头
 * （防止截断点落在半轮上，把一条 assistant 回复当成“用户刚说过的话”的上下文）。
 */
export function historySlice(messages, rounds) {
  const list = Array.isArray(messages) ? messages : []
  const limit = Math.max(0, Number.isFinite(rounds) ? Math.floor(rounds) : 0) * 2
  if (limit === 0) return []
  let slice = list.slice(Math.max(0, list.length - limit))
  while (slice.length > 0 && slice[0].role !== 'user') slice = slice.slice(1)
  return slice.map((message) => ({ role: message.role, content: message.content }))
}

/** 历史接口：时间正序取最后 limit 条（limit 1–200，默认 50） */
export function readHistory(file, limit = 50) {
  const memory = readMemory(file)
  const count = Math.min(200, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50))
  const messages = memory.messages.slice(Math.max(0, memory.messages.length - count))
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ts: message.ts,
    kind: message.kind,
  }))
}

/** 清空记忆；返回清掉的条数 */
export function clearMemory(file) {
  const memory = readMemory(file)
  writeMemory(file, emptyMemory())
  return memory.messages.length
}

/** 记忆条数（runtime 快照用） */
export function memoryCount(file) {
  return readMemory(file).messages.length
}

/** user/assistant 成对写入时的最小单位：一轮对话的时间戳（assistant 比 user 大 1ms，保证顺序稳定） */
function nowPair(now) {
  const ts = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now()
  return { userTs: ts, assistantTs: ts + 1 }
}

/**
 * 生成一次对话回复并写入记忆。
 *
 * @param {object} ctx 宿主上下文（llm + agentDefaultModel）
 * @param {object} config 完整配置
 * @param {object} options { text, memoryFile, now }
 * @returns {Promise<
 *   {ok:true, reply:{role:'assistant',text:string,ts:number}, model:{provider,model}, memoryCount:number} |
 *   {ok:false, reason:string, error:string}
 * >}
 */
export async function generateChat(ctx, config, options = {}) {
  const text = typeof options.text === 'string' ? options.text.trim() : ''
  const memoryFile = options.memoryFile || path.join(process.cwd(), 'memory.json')
  const now = options.now instanceof Date ? options.now : new Date()
  if (!text) return { ok: false, reason: 'bad-input', error: '说点什么呀，空消息她不知道回什么' }

  const memory = readMemory(memoryFile)
  const rounds = config?.chat?.memoryRounds ?? 5
  const result = await generateText(ctx, {
    system: buildSystemPrompt(config, now),
    history: historySlice(memory.messages, rounds),
    userText: text,
    temperature: config?.chat?.temperature ?? 1,
    preferred: configuredModel(config?.chat),
    timeoutMs: 60_000,
  })
  if (!result.ok) {
    return { ok: false, reason: result.reason || 'generate-error', error: result.error || '生成失败：原因不明' }
  }

  const { userTs, assistantTs } = nowPair(now)
  const reply = { role: 'assistant', text: result.text, ts: assistantTs }
  try {
    const written = appendMessages(memoryFile, [
      { role: 'user', content: text, ts: userTs, kind: 'chat' },
      { role: 'assistant', content: result.text, ts: assistantTs, kind: 'chat' },
    ])
    return { ok: true, reply, model: result.model, memoryCount: written.count }
  } catch (error) {
    // 模型已经回了，只是记忆没写进去：照样把回复给用户（记忆失败不该让这次对话白费）
    console.log(`[dsh-whale-chat] 写入对话记忆失败：${error instanceof Error ? error.message : String(error)}`)
    return {
      ok: true,
      reply,
      model: result.model,
      memoryCount: memory.messages.length,
      warning: '回复已生成，但记忆没写进磁盘；下次可能接不上这段对话',
    }
  }
}
