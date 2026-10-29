/**
 * dsh-whale-chat 宿主入口（鲸聊）。
 *
 * 职责：
 *   1. 挂一条 prefix 路由 `/dsh-whale-chat`，内部按 pathname 分发（API / 静态素材 / 自检页）；
 *   2. 起一个 30 秒 tick 的调度器，决定“现在该不该自己出门逛一圈”，以及碎碎念；
 *   3. 所有定时器/异步任务都自己吞异常 —— DSH 规定同步回调抛错会终止整个宿主机进程。
 *
 * 契约见 SPEC §4；本文件不实现业务细节，只做分发与调度（business 在 config/persona/llm/chat/roam/http）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLUGIN_NAME,
  dataPaths,
  localDay,
  mergeAndValidate,
  readConfig,
  writeConfig,
} from './config.js'
import { buildSystemPrompt } from './persona.js'
import { configuredModel, currentModel, generateText } from './llm.js'
import { clearMemory, generateChat, memoryCount, mergeHistory, readHistory } from './chat.js'
import {
  afterQuietDate,
  clearMessages,
  generateWhisper,
  isQuiet,
  isRoamInFlight,
  isoLocal,
  jitterIntervalMs,
  markRead,
  messagesAfter,
  messagesAsHistory,
  nextMorningDate,
  nextRoamDate,
  readMessages,
  readState,
  rollDay,
  runRoam,
  writeState,
} from './roam.js'
import {
  BadRequestError,
  contentTypeOf,
  createTrustFence,
  isAllowedAssetPath,
  json,
  readJsonBody,
  resolveAsset,
  sendFile,
  sendHtml,
  sendText,
} from './http.js'
import { selfcheckHtml } from './selfcheck.js'

/** 插件行 id（必须与 cordis.patch.yml 的 id/name 一致） */
export const name = PLUGIN_NAME

/** 需要的宿主服务：路由 / 信任栅栏 / 模型调用 / 当前对话模型 */
export const inject = ['webServer', 'connection', 'llm', 'agentDefaultModel']

/** 路由前缀（客户端与 E2E 都按它拼地址） */
export const ROUTE_PREFIX = '/dsh-whale-chat'

/** 调度器 tick 间隔（SPEC §5.3） */
export const TICK_MS = 30_000

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 包根（lib 的上一级） */
const PACKAGE_ROOT = path.resolve(HERE, '..')
/** 素材根：webm / font / icon 都在包内 assets/ 下 */
const ASSETS_ROOT = path.join(PACKAGE_ROOT, 'assets')

/** 版本号（读 package.json，失败回 0.1.0） */
export const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.1.0'
  } catch {
    return '0.1.0'
  }
})()

/** API 路由表（精确路径 → 方法 → 处理器 key） */
const API_ROUTES = {
  '/api/settings': { GET: 'settings:get', POST: 'settings:post' },
  '/api/status': { GET: 'status:get' },
  '/api/history': { GET: 'history:get' },
  '/api/history/clear': { POST: 'history:clear' },
  '/api/chat': { POST: 'chat:post' },
  '/api/messages': { GET: 'messages:get' },
  '/api/messages/read': { POST: 'messages:read' },
  '/api/roam': { POST: 'roam:post' },
  '/api/whisper': { POST: 'whisper:post' },
  '/api/selftest/chat': { POST: 'selftest:chat' },
}

/**
 * 纯函数式路由分类（供单测直接验证契约）：
 * @returns {{status:200,key:string} | {status:404} | {status:405,allow:string[]}}
 */
export function classifyApi(method, rest) {
  const routes = API_ROUTES[rest]
  if (!routes) return { status: 404 }
  const verb = String(method || 'GET').toUpperCase()
  if (!routes[verb]) return { status: 405, allow: Object.keys(routes) }
  return { status: 200, key: routes[verb] }
}

/** 安全取整数查询参数 */
function intParam(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

/** 组 runtime 快照（SPEC §4.1）；读盘失败时退回空状态，绝不抛 */
export function buildRuntime(ctx, config, paths) {
  const now = new Date()
  let state
  try {
    state = readState(paths.state)
  } catch {
    state = { roam: { day: '', count: 0, lastAt: null, nextAt: null, lastError: null, lastSource: null, running: false } }
  }
  const todayCount = state.roam.day === localDay(now) ? state.roam.count : 0
  let unread = 0
  try {
    unread = readMessages(paths.messages).items.filter((item) => !item.readAt).length
  } catch {
    unread = 0
  }
  let counts = 0
  try {
    counts = memoryCount(paths.memory)
  } catch {
    counts = 0
  }
  const current = currentModel(ctx) || null
  const preferred = configuredModel(config && config.chat) || null
  return {
    version: VERSION,
    model: current,
    chatModel: preferred || current,
    memoryCount: counts,
    unread,
    roam: {
      enabled: Boolean(config && config.roam && config.roam.enabled),
      running: state.roam.running === true,
      todayCount,
      maxPerDay: config && config.roam ? config.roam.maxPerDay : 0,
      lastAt: state.roam.lastAt,
      nextAt: state.roam.nextAt,
      lastSource: state.roam.lastSource,
      lastError: state.roam.lastError,
    },
    dataDir: paths.dataDir,
  }
}

// ---------------------------------------------------------------------------
// 调度：下一次上网时间 / 今日次数 / 安静时段
// ---------------------------------------------------------------------------

/** roam 调度相关的配置键（保存设置时只有这些变了才重算 nextAt，拖桌宠改外观不会打乱上网节奏） */
function scheduleSignature(config) {
  const roam = config && config.roam ? config.roam : {}
  return JSON.stringify({
    enabled: roam.enabled,
    intervalMin: roam.intervalMin,
    maxPerDay: roam.maxPerDay,
    quiet: roam.quiet,
  })
}

/** 算出“下一次该出门”的时刻（安静时段 → 时段结束后；否则 now + 抖动间隔） */
function planNextRoamAt(config, now) {
  const roam = config && config.roam ? config.roam : {}
  if (!roam.enabled) return null
  if (isQuiet(roam.quiet, now)) return afterQuietDate(roam.quiet, now)
  return nextRoamDate(now, roam.intervalMin)
}

/** 每次 roam 结束（成功/失败都算）后重算 nextAt 并写 state（SPEC §5.3 第 5 条） */
export function rescheduleAfterRoam(paths, config, now = new Date()) {
  const state = readState(paths.state)
  rollDay(state, now)
  state.roam.running = false
  const next = planNextRoamAt(config, now)
  state.roam.nextAt = next ? isoLocal(next) : null
  writeState(paths.state, state)
  return state
}

/** 首次安装/状态缺失时先排一个“未来”的上网时间，避免一装好就立刻联网 */
export function ensureInitialSchedule(paths, config = readConfig(paths.config), now = new Date()) {
  const state = readState(paths.state)
  rollDay(state, now)
  state.roam.running = false
  if (!config.roam.enabled) {
    state.roam.nextAt = null
  } else if (!state.roam.nextAt) {
    state.roam.nextAt = isoLocal(nextRoamDate(now, config.roam.intervalMin))
  }
  writeState(paths.state, state)
  return state
}

/**
 * 30 秒 tick：全部同步读写 + 异步任务自己 catch，外层再包一层 try/catch。
 * whisper 的下次时间放在内存里（state.json 只存 roam，SPEC §2）。
 */
export function tick(ctx, paths, tickState = {}, now = new Date()) {
  const config = readConfig(paths.config)
  const state = readState(paths.state)
  rollDay(state, now)

  if (!config.roam.enabled) {
    if (state.roam.running || state.roam.nextAt !== null) {
      state.roam.running = false
      state.roam.nextAt = null
      writeState(paths.state, state)
    }
  } else if (!state.roam.running && !isRoamInFlight()) {
    if (isQuiet(config.roam.quiet, now)) {
      // 安静时段：不打扰，顺延到时段结束后 1–3 分钟
      const next = afterQuietDate(config.roam.quiet, now)
      if (state.roam.nextAt !== isoLocal(next)) {
        state.roam.nextAt = isoLocal(next)
        writeState(paths.state, state)
      }
    } else if (state.roam.count >= config.roam.maxPerDay) {
      // 今天逛够了：顺延到次日 09:00 左右
      const next = nextMorningDate(now)
      state.roam.nextAt = isoLocal(next)
      writeState(paths.state, state)
    } else {
      const nextAt = state.roam.nextAt ? new Date(state.roam.nextAt).getTime() : 0
      if (!state.roam.nextAt || !Number.isFinite(nextAt) || nextAt <= now.getTime()) {
        // 20% 概率“这次不想逛”（模拟真人，别太机械）—— 顺延，不算一次
        if (Math.random() < 0.2) {
          state.roam.nextAt = isoLocal(nextRoamDate(now, config.roam.intervalMin))
          writeState(paths.state, state)
          console.log('[dsh-whale-chat] 到点了，但这次不想出门，再等等')
        } else {
          // 先占位写 running=true，防止下一次 tick 重复触发；runRoam 内部也会写状态
          state.roam.running = true
          state.roam.nextAt = isoLocal(nextRoamDate(now, config.roam.intervalMin))
          writeState(paths.state, state)
          runRoam(ctx, { config, paths, now })
            .then(() => {
              try {
                rescheduleAfterRoam(paths, config, new Date())
              } catch (error) {
                console.log(`[dsh-whale-chat] 重算下次上网时间失败：${error instanceof Error ? error.message : String(error)}`)
              }
            })
            .catch((error) => {
              // runRoam 自己已经吞了异常；这里只防“连 then 都炸”的极端情况
              console.log(`[dsh-whale-chat] 上网任务异常：${error instanceof Error ? error.message : String(error)}`)
              try {
                rescheduleAfterRoam(paths, config, new Date())
              } catch {
                /* 忽略 */
              }
            })
        }
      }
    }
  }

  // 碎碎念（默认关）：安静时段不念；时段结束后重新开始计时
  if (!config.whisper || config.whisper.enabled !== true) {
    tickState.whisperNextAt = 0
    return
  }
  const quiet = config.whisper.quietSameAsRoam ? config.roam.quiet : null
  if (isQuiet(quiet, now)) {
    tickState.whisperNextAt = 0
    return
  }
  const due = Number(tickState.whisperNextAt) || 0
  if (due === 0) {
    tickState.whisperNextAt = now.getTime() + jitterIntervalMs(config.whisper.intervalMin)
    return
  }
  if (now.getTime() < due) return
  tickState.whisperNextAt = now.getTime() + jitterIntervalMs(config.whisper.intervalMin)
  generateWhisper(ctx, { config, paths, now }).catch((error) => {
    console.log(`[dsh-whale-chat] 碎碎念任务异常：${error instanceof Error ? error.message : String(error)}`)
  })
}

// ---------------------------------------------------------------------------
// 路由实现
// ---------------------------------------------------------------------------

/** 不读 body 的接口也要把请求流排空：否则 keep-alive 连接上可能残留未消费数据 */
function drainRequest(req) {
  try {
    if (req && typeof req.resume === 'function') req.resume()
  } catch {
    /* 忽略 */
  }
}

/** 静态素材：路径穿越/扩展名不在白名单/文件不存在 → 404（绝不返回包外文件） */
function serveAsset(res, rel) {
  if (!isAllowedAssetPath(rel)) {
    sendText(res, 404, 'not found')
    return
  }
  const file = resolveAsset(ASSETS_ROOT, rel)
  if (!file) {
    sendText(res, 400, 'bad asset path')
    return
  }
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    sendText(res, 404, 'not found')
    return
  }
  const type = contentTypeOf(file)
  if (!stat.isFile() || !type) {
    sendText(res, 404, 'not found')
    return
  }
  sendFile(res, file, type)
}

/** 等 promise，但最多等 ms；超时返回结构化失败（不 reject，调用方无需再 catch） */
function withTimeout(promise, ms, timeoutResult) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(timeoutResult), ms)
    if (typeof timer.unref === 'function') timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        resolve({
          ok: false,
          reason: 'internal',
          error: `出错了：${error instanceof Error ? error.message : String(error)}`,
        })
      },
    )
  })
}

/** 处理一次 API 请求（调用前已过可信栅栏） */
async function handleApi(ctx, paths, key, req, res, url) {
  const now = new Date()

  if (key === 'settings:get') {
    const config = readConfig(paths.config)
    json(res, 200, { ok: true, config, runtime: buildRuntime(ctx, config, paths), paths })
    return
  }

  if (key === 'settings:post') {
    const body = await readJsonBody(req)
    const incoming = body && typeof body.config === 'object' && body.config ? body.config : body
    const before = readConfig(paths.config)
    const result = mergeAndValidate(before, incoming)
    if (!result.ok) {
      json(res, 400, { ok: false, error: result.error })
      return
    }
    const config = result.config
    const warnings = []
    if (config.roam.sources.length === 0) warnings.push('上网来源是空的：她暂时没地方可去，可以在「上网逛逛」里加一行')
    if (config.chat.provider && config.chat.model) {
      warnings.push(`对话与碎碎念会优先用 ${config.chat.provider}/${config.chat.model}，不可用时回落到当前对话模型`)
    }
    try {
      writeConfig(config, paths.config)
    } catch (error) {
      json(res, 500, {
        ok: false,
        error: `保存配置失败：${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    // 只有上网调度参数变了才重算 nextAt：设置页拖外观/改人设不该把上网节奏打乱
    try {
      if (scheduleSignature(before) !== scheduleSignature(config)) {
        rescheduleAfterRoam(paths, config, now)
      } else if (!config.roam.enabled) {
        ensureInitialSchedule(paths, config, now)
      }
    } catch (error) {
      console.log(`[dsh-whale-chat] 保存后重算调度失败：${error instanceof Error ? error.message : String(error)}`)
    }
    json(res, 200, {
      ok: true,
      config,
      runtime: buildRuntime(ctx, config, paths),
      ...(warnings.length > 0 ? { warnings } : {}),
    })
    return
  }

  if (key === 'status:get') {
    const config = readConfig(paths.config)
    json(res, 200, { ok: true, runtime: buildRuntime(ctx, config, paths) })
    return
  }

  if (key === 'history:get') {
    const limit = intParam(url.searchParams.get('limit'), 50)
    // 聊天记录 + 主动消息（随机上网带回的、碎碎念、报错）合并成一条时间线，面板才能“保留显示”
    const merged = mergeHistory(readHistory(paths.memory, limit), messagesAsHistory(paths.messages), limit)
    json(res, 200, { ok: true, messages: merged })
    return
  }

  if (key === 'history:clear') {
    drainRequest(req)
    const cleared = clearMemory(paths.memory)
    // 主动消息也清掉：面板里已经和聊天记录混在一起显示，只清聊天会显得“没清干净”
    const clearedProactive = clearMessages(paths.messages)
    console.log(`[dsh-whale-chat] 已清空对话记忆（${cleared} 条）与主动消息（${clearedProactive} 条）`)
    json(res, 200, { ok: true, cleared, clearedProactive })
    return
  }

  if (key === 'chat:post') {
    const body = await readJsonBody(req)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) {
      json(res, 400, { ok: false, error: '说点什么呀，空消息她不知道回什么' })
      return
    }
    if (text.length > 8000) {
      json(res, 400, { ok: false, error: '太长了（上限 8000 字），分几次说吧' })
      return
    }
    const config = readConfig(paths.config)
    const result = await generateChat(ctx, config, { text, memoryFile: paths.memory, now })
    if (!result.ok) {
      console.log(`[dsh-whale-chat] 对话失败：${result.error}`)
      json(res, 200, { ok: false, error: result.error, reason: result.reason })
      return
    }
    json(res, 200, {
      ok: true,
      reply: result.reply,
      model: result.model,
      memoryCount: result.memoryCount,
      ...(result.warning ? { warning: result.warning } : {}),
    })
    return
  }

  if (key === 'messages:get') {
    const afterId = intParam(url.searchParams.get('afterId'), 0)
    const limit = intParam(url.searchParams.get('limit'), 20)
    json(res, 200, { ok: true, ...messagesAfter(paths.messages, afterId, limit) })
    return
  }

  if (key === 'messages:read') {
    const body = await readJsonBody(req)
    const id = Number(body.id)
    if (!Number.isFinite(id)) {
      json(res, 400, { ok: false, error: '需要消息 id（数字）' })
      return
    }
    json(res, 200, { ok: true, unreadCount: markRead(paths.messages, id) })
    return
  }

  if (key === 'roam:post') {
    // body 可选（{force:true}），这里不读它：手动接口本身就是“立刻去”
    drainRequest(req)
    const config = readConfig(paths.config)
    if (isRoamInFlight()) {
      json(res, 200, { ok: false, skipped: 'running', error: '上一次上网还没回来，稍等一下' })
      return
    }
    const result = await withTimeout(
      runRoam(ctx, { config, paths, now }),
      60_000,
      { ok: false, reason: 'timeout', error: '这次上网太久了，先不等了（超过 60 秒）；回来我再告诉你' },
    )
    try {
      rescheduleAfterRoam(paths, config, new Date())
    } catch (error) {
      console.log(`[dsh-whale-chat] 手动上网后重算调度失败：${error instanceof Error ? error.message : String(error)}`)
    }
    json(res, 200, result)
    return
  }

  if (key === 'whisper:post') {
    drainRequest(req)
    const config = readConfig(paths.config)
    // 手动触发：忽略 whisper.enabled（那个开关只管定时任务，用户点了按钮就是明确想听一句）
    const result = await generateWhisper(ctx, { config, paths, now, force: true })
    json(res, 200, result)
    return
  }

  if (key === 'selftest:chat') {
    const body = await readJsonBody(req)
    const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : '在吗'
    const config = readConfig(paths.config)
    const result = await generateText(ctx, {
      system: buildSystemPrompt(config, now),
      userText: text,
      temperature: 1,
      preferred: configuredModel(config.chat),
      timeoutMs: 60_000,
    })
    if (!result.ok) {
      console.log(`[dsh-whale-chat] 自检对话失败：${result.error}`)
      json(res, 200, { ok: false, step: 'generate', error: result.error, reason: result.reason })
      return
    }
    json(res, 200, {
      ok: true,
      step: 'done',
      reply: { role: 'assistant', text: result.text, ts: Date.now() },
      model: result.model,
    })
    return
  }

  json(res, 404, { ok: false, error: '没有这个接口' })
}

/** 创建 prefix 路由 handler（含静态资源、自检页、可信栅栏与统一错误兜底） */
function createHandler(ctx, paths, fence) {
  return async function handle(req, res) {
    try {
      const rawUrl = typeof req.url === 'string' && req.url ? req.url : '/'
      const url = new URL(rawUrl, 'http://localhost')
      let pathname
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        sendText(res, 400, '请求路径不合法')
        return
      }
      if (pathname !== ROUTE_PREFIX && !pathname.startsWith(ROUTE_PREFIX + '/')) {
        json(res, 404, { ok: false, error: '没有这个接口' })
        return
      }
      const rest = pathname.slice(ROUTE_PREFIX.length) || '/'
      const method = String(req.method || 'GET').toUpperCase()

      // 静态素材：/assets/* 是客户端契约；/api/assets/* 是 SPEC 表里的写法，两个都支持
      let assetRel = null
      if (rest.startsWith('/assets/')) assetRel = rest.slice('/assets/'.length)
      else if (rest.startsWith('/api/assets/')) assetRel = rest.slice('/api/assets/'.length)
      if (assetRel !== null) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendText(res, 405, 'method not allowed')
          return
        }
        serveAsset(res, assetRel)
        return
      }

      // 自检页：纯静态 HTML，不含敏感数据，可放行（页面里的 API 调用照样过栅栏）
      if (rest === '/selfcheck' || rest === '/selfcheck/') {
        if (method !== 'GET') {
          json(res, 405, { ok: false, error: '自检页只支持 GET' })
          return
        }
        sendHtml(res, 200, selfcheckHtml({ version: VERSION, dataDir: paths.dataDir, pluginName: PLUGIN_NAME }), {
          'cache-control': 'no-store',
        })
        return
      }

      if (!rest.startsWith('/api/')) {
        json(res, 404, { ok: false, error: '没有这个接口' })
        return
      }

      // 可信栅栏：所有 /api/* 一律先过（fail-closed）
      if (fence.reject(req, res)) return

      const route = classifyApi(method, rest)
      if (route.status === 404) {
        json(res, 404, { ok: false, error: '没有这个接口' })
        return
      }
      if (route.status === 405) {
        json(res, 405, { ok: false, error: `这个接口不支持 ${method}` }, { allow: route.allow.join(', ') })
        return
      }
      await handleApi(ctx, paths, route.key, req, res, url)
    } catch (error) {
      if (error instanceof BadRequestError) {
        json(res, 400, { ok: false, error: error.message })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[dsh-whale-chat] 接口出错：${message.slice(0, 300)}`)
      try {
        if (!res.writableEnded && !res.destroyed) {
          json(res, 500, { ok: false, error: `服务器出错了：${message.slice(0, 200)}` })
        }
      } catch {
        /* 连接已断，忽略 */
      }
    }
  }
}

/**
 * 插件入口。任何启动失败都只记录日志，绝不把异常抛回宿主。
 */
export function apply(ctx) {
  try {
    setup(ctx)
  } catch (error) {
    try {
      console.log(`[dsh-whale-chat] 启动失败：${error instanceof Error ? error.message : String(error)}`)
    } catch {
      /* 连日志都写不了就算了 */
    }
  }
}

function setup(ctx) {
  const paths = dataPaths()
  const tickState = { whisperNextAt: 0 }

  try {
    fs.mkdirSync(paths.dataDir, { recursive: true })
  } catch (error) {
    console.log(`[dsh-whale-chat] 数据目录创建失败（${paths.dataDir}）：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    ensureInitialSchedule(paths)
  } catch (error) {
    console.log(`[dsh-whale-chat] 初始化上网计划失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const fence = createTrustFence(ctx)
  const handle = createHandler(ctx, paths, fence)

  // 路由：一条 prefix 路由 + ctx.effect 清理
  try {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          // handler 本身 async；再兜一层 .catch，确保任何路径上的异常都不会变成未处理拒绝
          Promise.resolve(handle(req, res)).catch((error) => {
            try {
              console.log(`[dsh-whale-chat] 路由未捕获异常：${error instanceof Error ? error.message : String(error)}`)
            } catch {
              /* 忽略 */
            }
          })
        },
      }),
    )
  } catch (error) {
    console.log(`[dsh-whale-chat] 路由注册失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  // 自检页的根路径别名：TESTING 手册里写的是 GET /selfcheck，SPEC §7 写的是
  // GET /dsh-whale-chat/selfcheck —— 两个都提供，避免测试侧因路径写法不同扑空。
  try {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/selfcheck',
        handler: (req, res) => {
          try {
            if (String(req.method || 'GET').toUpperCase() !== 'GET') {
              json(res, 405, { ok: false, error: '自检页只支持 GET' })
              return
            }
            sendHtml(res, 200, selfcheckHtml({ version: VERSION, dataDir: paths.dataDir, pluginName: PLUGIN_NAME }), {
              'cache-control': 'no-store',
            })
          } catch (error) {
            console.log(`[dsh-whale-chat] 自检页出错：${error instanceof Error ? error.message : String(error)}`)
            try {
              sendText(res, 500, '自检页出错')
            } catch {
              /* 忽略 */
            }
          }
        },
      }),
    )
  } catch (error) {
    console.log(`[dsh-whale-chat] /selfcheck 别名注册失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 调度器：30 秒 tick；effect 清理时清定时器
  try {
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          tick(ctx, paths, tickState)
        } catch (error) {
          try {
            console.log(`[dsh-whale-chat] 调度 tick 出错：${error instanceof Error ? error.message : String(error)}`)
          } catch {
            /* 忽略 */
          }
        }
      }, TICK_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return () => {
        try {
          clearInterval(timer)
        } catch {
          /* 忽略 */
        }
      }
    })
  } catch (error) {
    console.log(`[dsh-whale-chat] 调度器启动失败：${error instanceof Error ? error.message : String(error)}`)
  }

  console.log(
    `[dsh-whale-chat] 已挂载：${ROUTE_PREFIX} · 版本 ${VERSION} · 数据目录 ${paths.dataDir}`,
  )
}
