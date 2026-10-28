/**
 * 配置模块：默认值、深合并、白名单校验、原子读写、数据目录路径。
 *
 * 为什么把这些收敛在一个模块里：
 *   - 宿主侧所有文件（config/memory/messages/state）都在同一个数据目录，路径只该算一次；
 *   - 原子写（tmp + rename）是硬要求（SPEC §2），只写一份实现，别让每个模块各抄一遍；
 *   - 校验分两种口径：POST /api/settings 用**严格**口径（越界直接 400，告诉用户哪里不对），
 *     读盘用**宽松**口径（用户手改坏了也不该让整个插件起不来，能修就修、修不了回默认）。
 *
 * 本模块不依赖 DSH 运行时，纯 node 内置模块，可被 node:test 直接加载。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 插件名（路由前缀、日志、数据目录名都用它） */
export const PLUGIN_NAME = 'dsh-whale-chat'

/** 配置版本：结构不兼容时才 +1 */
export const CONFIG_VERSION = 1

/** 默认上网来源（SPEC §3；全部可被用户改掉） */
export const DEFAULT_SOURCES = [
  {
    name: 'B 站热门',
    url: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    type: 'json',
  },
  { name: 'V2EX 热帖', url: 'https://www.v2ex.com/api/topics/hot.json', type: 'json' },
  { name: '知乎日报', url: 'https://news-at.zhihu.com/api/4/news/latest', type: 'json' },
  { name: '少数派', url: 'https://sspai.com/feed', type: 'rss' },
  // 2026-10-28：36 氪官方 /feed 已退化成反爬 HTML（text/html、无 <rss>），解析不出条目，
  // 默认源改成 Solidot（奇客资讯）——开箱即用优先，用户仍可在设置里自己加回 36 氪。
  { name: 'Solidot（奇客资讯）', url: 'https://www.solidot.org/index.rss', type: 'rss' },
  { name: 'IT 之家', url: 'https://www.ithome.com/rss/', type: 'rss' },
  {
    name: '中文维基随机',
    url: 'https://zh.wikipedia.org/api/rest_v1/page/random/summary',
    type: 'json',
  },
]

/**
 * 内置默认配置（SPEC §3 的快照；唯一有意偏差：默认来源里的「36 氪」换成
 * 「Solidot（奇客资讯）」——36 氪官方 RSS 已失效，而默认源必须开箱即用。
 * 另外新增 roam.allowFakeIp，见该字段注释。）
 */
export const DEFAULTS = {
  version: CONFIG_VERSION,
  persona: {
    name: '小鲸',
    ownerTitle: '主人',
    selfClaim: '我',
    text: '',
  },
  chat: {
    memoryRounds: 5,
    provider: '',
    model: '',
    temperature: 1,
  },
  appearance: {
    enabled: true,
    size: 320,
    corner: 'bottom-right',
    marginX: 24,
    marginY: 96,
    bubbleSeconds: 14,
    fontFamily: 'candy',
    clickSound: false,
  },
  roam: {
    enabled: true,
    intervalMin: 90,
    maxPerDay: 6,
    quiet: { enabled: true, start: '23:00', end: '08:00' },
    includeLink: true,
    charLimit: 3000,
    reportFailure: true,
    // 代理/虚拟网卡会把域名解析到 RFC2544 保留段（198.18.0.0/15，fake-IP）；
    // 默认允许这一段，否则这类网络环境下 6/7 个默认来源会被 SSRF 拦死。
    // 只放行解析结果，不影响其它私网/保留段，也不放行字面量 IP。
    allowFakeIp: true,
    sources: DEFAULT_SOURCES,
  },
  whisper: {
    enabled: false,
    intervalMin: 60,
    quietSameAsRoam: true,
  },
}

/** 深拷贝一份默认配置（调用方可以随便改，不会污染 DEFAULTS） */
export function defaultConfig() {
  return structuredClone(DEFAULTS)
}

/** 只认这些顶层键：其余字段一律丢弃（SPEC §3 白名单） */
export const KNOWN_TOP_KEYS = ['version', 'persona', 'chat', 'appearance', 'roam', 'whisper']

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 深合并：普通对象递归合并，数组/标量整体替换。
 * `undefined` 视为“没提供”，不覆盖 base 里的值——这样 POST 只改一个字段时不会把别的抹空。
 */
export function deepMerge(base, over) {
  const out = structuredClone(base)
  if (!isPlainObject(over)) return out
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue
    if (isPlainObject(value)) {
      out[key] = isPlainObject(out[key]) ? deepMerge(out[key], value) : structuredClone(value)
    } else if (Array.isArray(value)) {
      out[key] = structuredClone(value)
    } else {
      out[key] = value
    }
  }
  return out
}

/** 顶层白名单过滤（未知顶层键丢弃；值原样保留，交给校验器处理） */
export function pickKnownTop(input) {
  if (!isPlainObject(input)) return {}
  const out = {}
  for (const key of KNOWN_TOP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key]
  }
  return out
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** DSH 数据根：环境变量优先，其次 ~/.dsh（与 SPEC §2 一致） */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 插件数据目录 `<DSH_HOME>/dsh-whale-chat/` */
export function dataDir() {
  return path.join(dshHome(), PLUGIN_NAME)
}

/** 四个数据文件的绝对路径（GET /api/settings 的 `paths` 与各模块共用这一份） */
export function dataPaths() {
  const dir = dataDir()
  return {
    dataDir: dir,
    config: path.join(dir, 'config.json'),
    memory: path.join(dir, 'memory.json'),
    messages: path.join(dir, 'messages.json'),
    state: path.join(dir, 'state.json'),
  }
}

/** 本地日期 `YYYY-MM-DD`（每日次数、安静时段都按本地时区算，不用 UTC） */
export function localDay(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// ---------------------------------------------------------------------------
// 原子读写
// ---------------------------------------------------------------------------

/** 原子写 JSON：先写 `<file>.tmp`，再 rename 顶替。失败时清掉 tmp，绝不留下半个文件。 */
export function atomicWriteJson(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* tmp 可能根本没建出来，忽略 */
    }
    throw error
  }
  return file
}

/** 读 JSON；文件不存在/解析失败/类型不符一律回落 fallback（SPEC §2：读失败绝不抛到 apply 外） */
export function readJsonFile(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 配置非法（严格口径下抛出，外层折成 400 {ok:false,error}） */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * 校验口径：
 *   strict=true  → 第一个问题就抛 ConfigError（POST /api/settings 用，返回 400 说清哪个字段不对）；
 *   strict=false → 记录问题、按 fallback 修正（读盘用，用户手改坏了也尽量救回来）。
 */
class Issues {
  constructor(strict) {
    this.strict = strict
    this.list = []
  }

  fail(message, fallback) {
    if (this.strict) throw new ConfigError(message)
    this.list.push(message)
    return fallback
  }
}

function readText(issues, label, value, { min = 0, max = Infinity, fallback = '' } = {}) {
  if (typeof value !== 'string') {
    return issues.fail(`${label} 需要是字符串`, fallback)
  }
  const text = value.trim()
  const length = text.length
  if (length < min || length > max) {
    const range = min === max ? `${min}` : `${min}–${max}`
    return issues.fail(`${label} 需要 ${range} 个字`, fallback)
  }
  return text
}

function readNumber(issues, label, value, { min = -Infinity, max = Infinity, integer = false, fallback = 0 } = {}) {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') {
    return issues.fail(`${label} 需要是数字`, fallback)
  }
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return issues.fail(`${label} 需要是数字`, fallback)
  if (integer && !Number.isInteger(n)) {
    return issues.fail(`${label} 需要是整数`, Math.min(max, Math.max(min, Math.round(n))))
  }
  if (n < min || n > max) {
    const fixed = Math.min(max, Math.max(min, integer ? Math.round(n) : n))
    return issues.fail(`${label} 需要在 ${min}–${max} 之间`, fixed)
  }
  return n
}

function readBool(issues, label, value, fallback) {
  if (typeof value !== 'boolean') return issues.fail(`${label} 需要是 true 或 false`, fallback)
  return value
}

function readEnum(issues, label, value, allowed, fallback) {
  if (!allowed.includes(value)) {
    return issues.fail(`${label} 只能是 ${allowed.join(' / ')}`, fallback)
  }
  return value
}

/** `HH:MM`（24 小时制）；跨午夜由调度侧处理，这里只管格式 */
function readTimeOfDay(issues, label, value, fallback) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) {
    return issues.fail(`${label} 需要是 HH:MM 格式（例如 23:00）`, fallback)
  }
  return value.trim()
}

/** 来源 URL 的语法校验（真正的 SSRF 防护在 roam.js 抓取前做，这里只挡明显不是网址的值） */
function readHttpUrl(issues, label, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return issues.fail(`${label} 需要是网址`, '')
  }
  const text = value.trim()
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return issues.fail(`${label} 不是合法的网址：${text.slice(0, 80)}`, '')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return issues.fail(`${label} 只支持 http/https`, '')
  }
  if (!parsed.hostname) return issues.fail(`${label} 缺少主机名`, '')
  return parsed.toString()
}

/** 来源清单：最多 30 项，每项必须有 name / http(s) url / 合法 type */
function readSources(issues, value) {
  if (!Array.isArray(value)) {
    return issues.fail('roam.sources 需要是数组', structuredClone(DEFAULT_SOURCES))
  }
  if (value.length > 30) issues.fail('roam.sources 最多 30 项', undefined)
  const out = []
  for (let i = 0; i < Math.min(value.length, 30); i += 1) {
    const item = value[i]
    const label = `roam.sources[${i}]`
    if (!isPlainObject(item)) {
      issues.fail(`${label} 需要是 {name,url,type} 对象`, undefined)
      continue
    }
    const name = readText(issues, `${label}.name`, item.name, { min: 1, max: 40, fallback: '' })
    const url = readHttpUrl(issues, `${label}.url`, item.url)
    const type = readEnum(issues, `${label}.type`, item.type ?? 'auto', ['auto', 'json', 'rss', 'html'], 'auto')
    if (name && url) out.push({ name, url, type })
  }
  return out
}

/** 把（已深合并的）原始对象校验成一份干净配置；未知子键在这一步自然丢弃 */
function buildConfig(src, issues) {
  const p = isPlainObject(src.persona) ? src.persona : {}
  const c = isPlainObject(src.chat) ? src.chat : {}
  const a = isPlainObject(src.appearance) ? src.appearance : {}
  const r = isPlainObject(src.roam) ? src.roam : {}
  const q = isPlainObject(r.quiet) ? r.quiet : {}
  const w = isPlainObject(src.whisper) ? src.whisper : {}

  let provider = readText(issues, 'chat.provider', c.provider, { min: 0, max: 200, fallback: '' })
  let model = readText(issues, 'chat.model', c.model, { min: 0, max: 200, fallback: '' })
  // 只填一半 = 不知道用户想用哪个模型，严格口径直接拒绝；宽松口径清空（等价于“跟随当前对话”）
  if (Boolean(provider) !== Boolean(model)) {
    issues.fail('chat.provider 与 chat.model 需要同时留空或同时填写', undefined)
    provider = ''
    model = ''
  }

  return {
    version: CONFIG_VERSION,
    persona: {
      name: readText(issues, 'persona.name', p.name, { min: 1, max: 20, fallback: DEFAULTS.persona.name }),
      ownerTitle: readText(issues, 'persona.ownerTitle', p.ownerTitle, {
        min: 1,
        max: 20,
        fallback: DEFAULTS.persona.ownerTitle,
      }),
      selfClaim: readText(issues, 'persona.selfClaim', p.selfClaim, {
        min: 1,
        max: 10,
        fallback: DEFAULTS.persona.selfClaim,
      }),
      // 人设正文允许空串（空 = 用内置默认人设）
      text: readText(issues, 'persona.text', p.text, { min: 0, max: 20000, fallback: '' }),
    },
    chat: {
      memoryRounds: readNumber(issues, 'chat.memoryRounds', c.memoryRounds, {
        min: 0,
        max: 50,
        integer: true,
        fallback: DEFAULTS.chat.memoryRounds,
      }),
      provider,
      model,
      temperature: readNumber(issues, 'chat.temperature', c.temperature, {
        min: 0,
        max: 2,
        fallback: DEFAULTS.chat.temperature,
      }),
    },
    appearance: {
      enabled: readBool(issues, 'appearance.enabled', a.enabled, DEFAULTS.appearance.enabled),
      size: readNumber(issues, 'appearance.size', a.size, {
        min: 160,
        max: 640,
        integer: true,
        fallback: DEFAULTS.appearance.size,
      }),
      corner: readEnum(
        issues,
        'appearance.corner',
        a.corner,
        ['bottom-right', 'bottom-left', 'top-right', 'top-left'],
        DEFAULTS.appearance.corner,
      ),
      marginX: readNumber(issues, 'appearance.marginX', a.marginX, {
        min: 0,
        max: 1000,
        integer: true,
        fallback: DEFAULTS.appearance.marginX,
      }),
      marginY: readNumber(issues, 'appearance.marginY', a.marginY, {
        min: 0,
        max: 1000,
        integer: true,
        fallback: DEFAULTS.appearance.marginY,
      }),
      bubbleSeconds: readNumber(issues, 'appearance.bubbleSeconds', a.bubbleSeconds, {
        min: 4,
        max: 120,
        integer: true,
        fallback: DEFAULTS.appearance.bubbleSeconds,
      }),
      fontFamily: readEnum(issues, 'appearance.fontFamily', a.fontFamily, ['candy', 'system'], DEFAULTS.appearance.fontFamily),
      clickSound: readBool(issues, 'appearance.clickSound', a.clickSound, DEFAULTS.appearance.clickSound),
    },
    roam: {
      enabled: readBool(issues, 'roam.enabled', r.enabled, DEFAULTS.roam.enabled),
      intervalMin: readNumber(issues, 'roam.intervalMin', r.intervalMin, {
        min: 5,
        max: 1440,
        integer: true,
        fallback: DEFAULTS.roam.intervalMin,
      }),
      maxPerDay: readNumber(issues, 'roam.maxPerDay', r.maxPerDay, {
        min: 0,
        max: 24,
        integer: true,
        fallback: DEFAULTS.roam.maxPerDay,
      }),
      quiet: {
        enabled: readBool(issues, 'roam.quiet.enabled', q.enabled, DEFAULTS.roam.quiet.enabled),
        start: readTimeOfDay(issues, 'roam.quiet.start', q.start ?? DEFAULTS.roam.quiet.start, DEFAULTS.roam.quiet.start),
        end: readTimeOfDay(issues, 'roam.quiet.end', q.end ?? DEFAULTS.roam.quiet.end, DEFAULTS.roam.quiet.end),
      },
      includeLink: readBool(issues, 'roam.includeLink', r.includeLink, DEFAULTS.roam.includeLink),
      charLimit: readNumber(issues, 'roam.charLimit', r.charLimit, {
        min: 500,
        max: 8000,
        integer: true,
        fallback: DEFAULTS.roam.charLimit,
      }),
      reportFailure: readBool(issues, 'roam.reportFailure', r.reportFailure, DEFAULTS.roam.reportFailure),
      allowFakeIp: readBool(issues, 'roam.allowFakeIp', r.allowFakeIp, DEFAULTS.roam.allowFakeIp),
      sources: readSources(issues, r.sources ?? DEFAULTS.roam.sources),
    },
    whisper: {
      enabled: readBool(issues, 'whisper.enabled', w.enabled, DEFAULTS.whisper.enabled),
      intervalMin: readNumber(issues, 'whisper.intervalMin', w.intervalMin, {
        min: 5,
        max: 1440,
        integer: true,
        fallback: DEFAULTS.whisper.intervalMin,
      }),
      quietSameAsRoam: readBool(issues, 'whisper.quietSameAsRoam', w.quietSameAsRoam, DEFAULTS.whisper.quietSameAsRoam),
    },
  }
}

/**
 * 严格校验：把 incoming 深合并到 base 上，返回最终完整配置。
 * @returns {{ok:true, config:object, warnings:string[]} | {ok:false, error:string}}
 */
export function mergeAndValidate(base, incoming) {
  const merged = deepMerge(isPlainObject(base) ? base : defaultConfig(), pickKnownTop(incoming))
  const issues = new Issues(true)
  try {
    return { ok: true, config: buildConfig(merged, issues), warnings: [] }
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, error: error.message }
    throw error
  }
}

/**
 * 宽松校验（读盘用）：能修就修，修不了回默认；返回配置与修过哪些地方（供日志/排障）。
 * @returns {{config:object, warnings:string[]}}
 */
export function sanitizeConfig(input) {
  const merged = deepMerge(defaultConfig(), pickKnownTop(input))
  const issues = new Issues(false)
  try {
    return { config: buildConfig(merged, issues), warnings: issues.list }
  } catch {
    // 理论上不会走到（非严格模式不抛），兜底：任何意外都回默认，绝不让插件起不来
    return { config: defaultConfig(), warnings: ['配置读取失败，已回落到默认配置'] }
  }
}

/** 读配置：文件缺失/损坏/非法都回落到默认（SPEC §3） */
let warnedInvalidConfig = false
export function readConfig(file = dataPaths().config) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return defaultConfig()
  }
  if (!isPlainObject(parsed)) return defaultConfig()
  try {
    const { config, warnings } = sanitizeConfig(parsed)
    // 只提醒一次：状态接口每 12 秒读一次配置，手改坏一个字段会刷屏
    if (warnings.length > 0 && !warnedInvalidConfig) {
      warnedInvalidConfig = true
      console.log('[dsh-whale-chat] 配置里有不合规字段，已自动修正：' + warnings.slice(0, 3).join('；'))
    }
    return config
  } catch {
    return defaultConfig()
  }
}

/** 写配置（原子写）；返回写入的绝对路径 */
export function writeConfig(config, file = dataPaths().config) {
  return atomicWriteJson(file, config)
}
