/**
 * 随机上网（roam）+ 碎碎念 + 主动消息队列 + 调度状态。
 *
 * 一次 roam 的链路（SPEC §5.3）：
 *   随机挑来源 → SSRF 校验 → 抓取（15s / 2MB）→ 校验重定向后的最终地址 → 解析（json/rss/html）
 *   → 拼成 ≤ charLimit 的纯文本 → 让模型用人设口吻转述 → 入 messages.json。
 *
 * 安全要点（都在这里，index.js 不重复实现）：
 *   - 只允许 http/https，`dns.lookup(host,{all:true})` 的**每一个**解析结果都必须在公网段；
 *   - 重定向后 `response.url` 再查一遍（防止 302 到 127.0.0.1 / 169.254.169.254）；
 *   - 手动读流、边读边计数，超过 2MB 立刻 cancel，避免被超大响应拖死宿主。
 *
 * 失败绝不抛到定时器外：runRoam 内部全部 try/catch，返回结构化中文原因，必要时入队一条降级消息
 * （每天最多一条，免得不联网时屏幕上刷满“没连上”）。
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import net from 'node:net'
import {
  atomicWriteJson,
  localDay,
  readJsonFile,
} from './config.js'
import { buildRoamPrompt, buildSystemPrompt, buildWhisperPrompt } from './persona.js'
import { configuredModel, generateText } from './llm.js'

/** 抓取超时（SPEC §5.3） */
export const FETCH_TIMEOUT_MS = 15_000
/** 响应体上限 2MB（SPEC §5.3） */
export const MAX_BODY_BYTES = 2 * 1024 * 1024
/** 主动消息队列上限（SPEC §2） */
export const MESSAGE_LIMIT = 200
/**
 * 用户代理：真实浏览器 UA。
 *
 * 这里**不要**追加 `dsh-whale-chat/0.1.0` 之类的产品标识：B 站 ranking 接口会针对
 * 非纯浏览器 UA 稳定返回 HTTP 200 + `{"code":-352}`（实测 39B，解析 0 条），
 * 去掉后缀后同网络同 URL 返回 150KB 正常数据。所以统一用普通 Chrome UA，不做按源特例。
 */
export const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36'

/** 面向用户的上网/碎碎念错误（message 已经是中文，可直接展示） */
export class RoamError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'RoamError'
    if (options.cause) this.cause = options.cause
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? '')
}

// ---------------------------------------------------------------------------
// SSRF 防护
// ---------------------------------------------------------------------------

/** 本机/内网常用主机名：即使 DNS 解析看起来正常也不放行 */
const BLOCKED_HOST_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
])
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.test']

/** RFC2544 保留段：本地代理的 fake-IP DNS 常用它把域名「藏」起来（198.18.0.0/15） */
const FAKE_IP_BASE = '198.18.0.0'
const FAKE_IP_PREFIX = 15

/** 被 SSRF 拦住时的可操作提示（写进 error 与日志，用户能自己解决） */
const BLOCKED_HINT = '如果你在用代理/虚拟网卡，可在设置里打开「允许代理 fake-IP」'
const BLOCKED_REASON = '抓取被拒绝：目标是内网地址'

/** 构造「地址被拒」的 RoamError：带具体地址与可操作提示，便于用户/日志定位 */
function blockedAddressError(detail) {
  const suffix = detail ? `（${detail}；${BLOCKED_HINT}）` : `（${BLOCKED_HINT}）`
  return new RoamError(BLOCKED_REASON + suffix)
}

/** IPv4 保留/内网段（[网络地址, 前缀长度]） */
const BLOCKED_V4 = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私网
  ['100.64.0.0', 10], // 运营商级 NAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地（含云厂商 metadata）
  ['172.16.0.0', 12], // 私网
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // 文档示例
  ['192.88.99.0', 24], // 6to4 中继
  ['192.168.0.0', 16], // 私网
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // 文档示例
  ['203.0.113.0', 24], // 文档示例
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留
  ['255.255.255.255', 32],
]

function ipv4ToInt(ip) {
  const text = String(ip ?? '')
  const parts = text.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value >>> 0
}

function v4InCidr(ipInt, base, prefix) {
  const baseInt = ipv4ToInt(base)
  if (ipInt === null || baseInt === null || prefix < 0 || prefix > 32) return false
  if (prefix === 0) return true
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0
}

function bytesToIpv4(bytes, offset) {
  if (!bytes || bytes.length < offset + 4) return ''
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`
}

/** 把 IPv6 文本规范成纯十六进制分组（含末尾 IPv4 的写法先转成两组十六进制） */
function normalizeIpv6(text) {
  let value = String(text ?? '')
    .toLowerCase()
    .split('%')[0]
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    const v4 = ipv4ToInt(value.slice(lastColon + 1))
    if (v4 === null) return null
    const high = ((v4 >>> 16) & 0xffff).toString(16)
    const low = (v4 & 0xffff).toString(16)
    value = value.slice(0, lastColon + 1) + high + ':' + low
  }
  return value
}

/** IPv6 → 16 字节数组；格式不对返回 null */
export function ipv6ToBytes(ip) {
  const text = normalizeIpv6(ip)
  if (!text || !/^[0-9a-f:]+$/.test(text)) return null
  const halves = text.split('::')
  if (halves.length > 2) return null
  const toBytes = (part) => {
    if (part === '') return []
    const out = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      const value = parseInt(group, 16)
      out.push((value >> 8) & 255, value & 255)
    }
    return out
  }
  const head = toBytes(halves[0])
  const tail = halves.length === 2 ? toBytes(halves[1]) : []
  if (!head || !tail) return null
  if (halves.length === 2) {
    const missing = 16 - head.length - tail.length
    if (missing < 0) return null
    return [...head, ...new Array(missing).fill(0), ...tail]
  }
  return head.length === 16 ? head : null
}

function isPublicIpv4(ip, options = {}) {
  const value = ipv4ToInt(ip)
  if (value === null) return false
  // 唯一放行口：allowFakeIp 时把 RFC2544 段当成「代理伪造地址」放行（只对这 15 位前缀）
  if (options.allowFakeIp === true && v4InCidr(value, FAKE_IP_BASE, FAKE_IP_PREFIX)) return true
  return !BLOCKED_V4.some(([base, prefix]) => v4InCidr(value, base, prefix))
}

function isPublicIpv6(ip) {
  const bytes = ipv6ToBytes(ip)
  if (!bytes) return false
  if (bytes.every((b) => b === 0)) return false // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return false // ::1
  const [b0, b1] = bytes
  if ((b0 & 0xfe) === 0xfc) return false // fc00::/7 唯一本地
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return false // fe80::/10 链路本地
  if (b0 === 0xff) return false // ff00::/8 组播
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false // 2001:db8::/32 文档
  // IPv4 映射 / 兼容 / NAT64 / 6to4：嵌入的 IPv4 若在内网，整段拒绝
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpv4(bytesToIpv4(bytes, 12))
  }
  if (bytes.slice(0, 12).every((b) => b === 0)) return isPublicIpv4(bytesToIpv4(bytes, 12))
  if (b0 === 0x00 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isPublicIpv4(bytesToIpv4(bytes, 12))
  }
  if (b0 === 0x20 && b1 === 0x02) return isPublicIpv4(bytesToIpv4(bytes, 2))
  return true
}

/**
 * 单个 IP 是否是可抓取的公网地址（IPv4/IPv6 都查；非法字符串一律 false）。
 * @param {{allowFakeIp?:boolean}} [options] allowFakeIp=true 时额外放行 IPv4 的 198.18.0.0/15
 *   （本地代理 fake-IP DNS 的占位地址）。IPv6 与其内嵌 IPv4 不享受这个放行。
 */
export function isPublicIp(ip, options = {}) {
  const family = net.isIP(String(ip ?? ''))
  if (family === 4) return isPublicIpv4(ip, { allowFakeIp: options.allowFakeIp === true })
  if (family === 6) return isPublicIpv6(ip)
  return false
}

/** 主机名是否属于本机/内网专用名 */
export function isBlockedHostname(hostname) {
  const host = String(hostname ?? '')
    .toLowerCase()
    .replace(/\.$/, '')
  if (!host) return true
  if (BLOCKED_HOST_NAMES.has(host)) return true
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
}

/**
 * 校验目标 URL 是否允许抓取。
 * 只允许 http/https；主机名是 IP 直接按段判断；是域名则解析全部 A/AAAA 记录，任一内网即拒绝。
 *
 * `allowFakeIp` 只影响**域名解析结果**里的 198.18.0.0/15（代理 fake-IP 占位地址）；
 * URL 里直接写 198.18.x 字面量仍然按原规则拒绝 —— 否则任何人都能用一个字面量绕过 SSRF 检查。
 *
 * @param {string} rawUrl
 * @param {{lookup?: Function, allowFakeIp?: boolean}} [options]
 *   lookup：注入解析器（单测用；生产用 node:dns/promises）；
 *   allowFakeIp：放行 RFC2544 fake-IP 解析结果（默认 false，严格按 SPEC）
 * @returns {Promise<URL>} 通过时返回解析后的 URL 对象
 * @throws {RoamError} 中文原因
 */
export async function assertPublicUrl(rawUrl, options = {}) {
  const lookup = typeof options.lookup === 'function' ? options.lookup : dnsLookup
  const allowFakeIp = options.allowFakeIp === true
  let url
  try {
    url = new URL(String(rawUrl ?? ''))
  } catch {
    throw new RoamError('地址不是合法的网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RoamError('抓取被拒绝：只允许 http/https 地址')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!hostname) throw new RoamError('地址缺少主机名')
  if (isBlockedHostname(hostname)) {
    throw blockedAddressError(hostname)
  }
  if (net.isIP(hostname)) {
    // 字面 IP 永远走严格判定（fake-IP 放行只针对 DNS 解析结果）
    if (!isPublicIp(hostname)) throw blockedAddressError(hostname)
    return url
  }
  let addresses
  try {
    addresses = await lookup(hostname, { all: true })
  } catch (error) {
    throw new RoamError(`抓取被拒绝：域名解析失败（${errorText(error)}）`, { cause: error })
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new RoamError('抓取被拒绝：域名没有解析到任何地址')
  }
  for (const entry of addresses) {
    const address = typeof entry === 'string' ? entry : entry && entry.address
    if (!isPublicIp(address, { allowFakeIp })) {
      throw blockedAddressError(`${hostname} → ${address}`)
    }
  }
  return url
}

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

function describeFetchError(error, timeoutMs) {
  const name = error && typeof error.name === 'string' ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `抓取失败：等了 ${Math.round(timeoutMs / 1000)} 秒还没连上`
  }
  return `抓取失败：网络连不上（${errorText(error).slice(0, 120)}）`
}

/** 读响应体，最多 maxBytes；超限立刻 cancel（绝不让超大响应拖死宿主） */
async function readBodyCapped(response, maxBytes) {
  const body = response.body
  if (!body || typeof body.getReader !== 'function') {
    if (typeof response.text === 'function') {
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new RoamError('内容太大：超过 2MB，先不看了')
      }
      return String(text).replace(/^\uFEFF/, '')
    }
    throw new RoamError('抓取失败：响应没有内容')
  }
  const reader = body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > maxBytes) {
        try {
          await reader.cancel('too large')
        } catch {
          /* 已取消 */
        }
        throw new RoamError('内容太大：超过 2MB，先不看了')
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } finally {
    try {
      reader.releaseLock?.()
    } catch {
      /* 某些实现不支持 releaseLock，忽略 */
    }
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks)).replace(/^\uFEFF/, '')
}

/**
 * 抓一个来源（完整版：SSRF 校验 → fetch → 校验最终地址 → 限流读取）。
 * fetchImpl / lookup / allowFakeIp 可注入，单测不需要真的联网。
 *
 * @returns {Promise<{url:string, body:string, contentType:string}>}
 */
export async function fetchSource(source, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : FETCH_TIMEOUT_MS
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_BODY_BYTES
  const allowFakeIp = options.allowFakeIp === true
  if (!source || typeof source.url !== 'string' || source.url.trim() === '') {
    throw new RoamError('这个来源还没填网址')
  }
  if (typeof fetchImpl !== 'function') throw new RoamError('当前环境没有 fetch，抓不了网页')

  const target = await assertPublicUrl(source.url, { lookup: options.lookup, allowFakeIp })
  let response
  try {
    response = await fetchImpl(target.toString(), {
      headers: { 'user-agent': FETCH_UA, accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
  } catch (error) {
    throw new RoamError(describeFetchError(error, timeoutMs), { cause: error })
  }
  if (!response) throw new RoamError('抓取失败：对方没有响应')

  // 重定向后的最终地址也要过一遍 SSRF（可能被 302 带去内网）
  const finalUrl = typeof response.url === 'string' && response.url ? response.url : target.toString()
  try {
    await assertPublicUrl(finalUrl, { lookup: options.lookup, allowFakeIp })
  } catch (error) {
    try {
      await response.body?.cancel?.()
    } catch {
      /* 忽略 */
    }
    throw error
  }

  if (response.ok === false) {
    try {
      await response.body?.cancel?.()
    } catch {
      /* 忽略 */
    }
    throw new RoamError(`抓取失败：对方返回 HTTP ${response.status ?? '未知'}`)
  }

  const body = await readBodyCapped(response, maxBytes)
  const contentType = typeof response.headers?.get === 'function' ? response.headers.get('content-type') || '' : ''
  return { url: finalUrl, body, contentType }
}

// ---------------------------------------------------------------------------
// 解析（json / rss / html）
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
}

/** 反转义常见 HTML/XML 实体（含数字实体）；不解码也不影响展示，主要让中文内容干净些 */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    const lower = body.toLowerCase()
    if (lower.startsWith('#x')) {
      const code = parseInt(lower.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (lower.startsWith('#')) {
      const code = parseInt(lower.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : whole
  })
}

/** 去标签 + 解实体 + 收空白，得到纯文本 */
export function stripHtml(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function truncate(text, max) {
  const value = String(text ?? '').trim()
  if (!Number.isFinite(max) || value.length <= max) return value
  return value.slice(0, max) + '…'
}

/** 取第一个非空字符串字段（支持嵌套对象/数组取第一个字符串） */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item.trim()) return item
    }
  }
  return ''
}

function itemTitleOf(item) {
  if (!item || typeof item !== 'object') return ''
  return stripHtml(
    firstText(
      item.title,
      item.name,
      item.question && item.question.title,
      item.headline,
      item.story_title,
      typeof item.text === 'string' ? item.text : '',
    ),
  ).trim()
}

function itemDetailOf(item) {
  if (!item || typeof item !== 'object') return ''
  return stripHtml(
    firstText(
      item.desc,
      item.description,
      item.excerpt,
      item.summary,
      item.reason,
      item.content,
      item.node && item.node.title,
      item.owner && item.owner.name,
      item.author,
      item.hint,
    ),
  ).trim()
}

function itemUrlOf(item, baseUrl) {
  if (!item || typeof item !== 'object') return ''
  const raw = firstText(
    item.url,
    item.link,
    item.short_link_v2,
    item.short_url,
    item.absolute_url,
    item.web_url,
    item.content_urls && item.content_urls.desktop && item.content_urls.desktop.page,
    item.content_urls && item.content_urls.mobile && item.content_urls.mobile.page,
  )
  if (!raw) return ''
  try {
    return new URL(raw, baseUrl || undefined).toString()
  } catch {
    return ''
  }
}

/** 在 JSON 树里 BFS 找第一个“像列表”的数组（元素多为带标题的对象） */
function findItemArray(root) {
  const queue = [{ value: root, depth: 0 }]
  let fallback = null
  while (queue.length > 0) {
    const { value, depth } = queue.shift()
    if (!value || typeof value !== 'object' || depth > 5) continue
    if (Array.isArray(value)) {
      const objects = value.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      if (objects.length > 0) {
        const good = objects.filter((item) => itemTitleOf(item) !== '')
        if (good.length >= Math.max(1, Math.ceil(objects.length * 0.5))) return value
        if (!fallback) fallback = value
      }
      continue
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 })
    }
  }
  return fallback ?? []
}

/** JSON 抽取：兼容 B 站热门 / V2EX / 知乎日报 / 维基随机摘要等常见形状（先找 title，再找列表） */
export function extractJson(body, options = {}) {
  let data
  try {
    data = JSON.parse(String(body ?? ''))
  } catch {
    throw new RoamError('返回的不是合法 JSON')
  }
  const root = data && typeof data === 'object' ? data : {}
  const title = stripHtml(
    firstText(
      root.title,
      root.name,
      root.question && root.question.title,
      root.data && root.data.title,
      root.query && root.query.title,
    ),
  ).trim()
  const summary = truncate(
    stripHtml(
      firstText(
        root.extract,
        root.description,
        root.summary,
        root.abstract,
        root.content,
        root.data && root.data.description,
        root.data && root.data.summary,
      ),
    ),
    4000,
  )
  const list = Array.isArray(data) ? data : findItemArray(data)
  const items = []
  for (const item of list.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue
    const itemTitle = itemTitleOf(item)
    if (!itemTitle) continue
    items.push({
      title: truncate(itemTitle, 200),
      detail: truncate(itemDetailOf(item), 400),
      url: itemUrlOf(item, options.baseUrl),
    })
  }
  return { title: truncate(title, 200), summary, items }
}

function matchTag(xml, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)
  if (!match) return ''
  return match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim()
}

function atomLink(block) {
  const match = /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block)
  return match ? match[1] : ''
}

/** RSS / Atom 抽取（正则实现：不引 XML 依赖，够读标题/摘要/链接） */
export function extractRss(body) {
  const xml = String(body ?? '')
  if (!/<(rss|feed|rdf:RDF)\b/i.test(xml)) throw new RoamError('看起来不是 RSS 内容')
  const feedTitle = stripHtml(matchTag(xml, 'title')).trim()
  const blocks = [
    ...Array.from(xml.matchAll(/<item\b[^>]*>[\s\S]*?<\/item>/gi), (m) => m[0]),
    ...Array.from(xml.matchAll(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi), (m) => m[0]),
  ]
  const items = []
  for (const block of blocks.slice(0, 20)) {
    const title = stripHtml(matchTag(block, 'title')).trim()
    if (!title) continue
    const detail = stripHtml(
      matchTag(block, 'description') || matchTag(block, 'summary') || matchTag(block, 'content'),
    ).trim()
    const link = matchTag(block, 'link') || atomLink(block)
    items.push({ title: truncate(title, 200), detail: truncate(detail, 400), url: link.trim() })
  }
  return { title: truncate(feedTitle, 200), summary: '', items }
}

function metaContent(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${key}["']`, 'i'),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match) return match[1]
  }
  return ''
}

/** HTML 抽取：标题 + meta 摘要，正文取段落，条目取 h2/h3（够模型说人话） */
export function extractHtml(body, options = {}) {
  const html = String(body ?? '')
  const title = stripHtml(matchTag(html, 'title') || matchTag(html, 'h1') || metaContent(html, 'og:title')).trim()
  const description = stripHtml(metaContent(html, 'description') || metaContent(html, 'og:description')).trim()
  const region = (() => {
    const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)
    if (article) return article[1]
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)
    if (main) return main[1]
    return html
  })()
  const paragraphs = Array.from(region.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi), (m) => stripHtml(m[1]).trim())
    .filter((text) => text.length >= 12)
    .slice(0, 20)
  const bodyText = paragraphs.join('\n')
  const summary = truncate(description || bodyText, 4000)
  const headings = Array.from(region.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi), (m) => stripHtml(m[1]).trim())
    .filter(Boolean)
    .slice(0, 12)
  const items = headings.map((heading) => ({ title: truncate(heading, 200), detail: '', url: '' }))
  return { title: truncate(title, 200), summary, items }
}

/** 按内容自动判断来源类型（用户没填 type 时用） */
export function detectSourceType(body) {
  const text = String(body ?? '').trim()
  if (text.startsWith('{') || text.startsWith('[')) return 'json'
  if (/<(rss|feed|rdf:RDF)\b/i.test(text)) return 'rss'
  return 'html'
}

/**
 * 解析抓回来的内容。
 * @returns {{title:string, summary:string, items:Array, type:'json'|'rss'|'html'}}
 */
export function parseSource(body, type = 'auto', options = {}) {
  const kind = type === 'auto' || !type ? detectSourceType(body) : type
  try {
    if (kind === 'json') return { ...extractJson(body, options), type: 'json' }
    if (kind === 'rss') return { ...extractRss(body, options), type: 'rss' }
    return { ...extractHtml(body, options), type: 'html' }
  } catch (error) {
    if (error instanceof RoamError) throw error
    throw new RoamError(`网页内容没看懂（${errorText(error).slice(0, 80)}）`, { cause: error })
  }
}

/** 把解析结果拼成送进模型的纯文本，总长 ≤ charLimit */
export function renderExtracted(parsed, charLimit = 3000) {
  const lines = []
  if (parsed && parsed.title) lines.push(`标题：${parsed.title}`)
  if (parsed && parsed.summary) lines.push(`简介：${parsed.summary}`)
  const items = parsed && Array.isArray(parsed.items) ? parsed.items.slice(0, 15) : []
  if (items.length > 0) {
    lines.push('条目：')
    for (const item of items) {
      if (!item || !item.title) continue
      const detail = item.detail ? `：${item.detail}` : ''
      lines.push(`- ${truncate(item.title + detail, 300)}`)
    }
  }
  let text = lines.join('\n').trim()
  const limit = Number.isFinite(charLimit) && charLimit > 0 ? charLimit : 3000
  if (text.length > limit) text = text.slice(0, limit) + '…'
  return text
}

/** 随机挑来源：同一来源不连续两次（只有 1 个来源时只能它自己） */
export function pickSource(sources, lastSourceName, random = Math.random) {
  const list = Array.isArray(sources)
    ? sources.filter((item) => item && typeof item.url === 'string' && item.url && typeof item.name === 'string')
    : []
  if (list.length === 0) return null
  const withoutLast = list.length > 1 ? list.filter((item) => item.name !== lastSourceName) : list
  const pool = withoutLast.length > 0 ? withoutLast : list
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))
  return pool[index]
}

// ---------------------------------------------------------------------------
// 主动消息队列（messages.json）
// ---------------------------------------------------------------------------

export function emptyMessages() {
  return { nextId: 1, items: [] }
}

/** 规范化 messages.json：坏条目丢弃、id 去重升序 */
export function normalizeMessages(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  let nextId = Number.isInteger(source.nextId) && source.nextId > 0 ? source.nextId : 1
  const items = []
  const seen = new Set()
  if (Array.isArray(source.items)) {
    for (const item of source.items) {
      if (!item || typeof item !== 'object') continue
      const id = Number.isInteger(item.id) && item.id > 0 ? item.id : nextId
      if (seen.has(id)) continue
      seen.add(id)
      nextId = Math.max(nextId, id + 1)
      const kind = item.kind === 'roam' || item.kind === 'whisper' || item.kind === 'error' ? item.kind : 'roam'
      items.push({
        id,
        kind,
        text: typeof item.text === 'string' ? item.text : '',
        source: item.source && typeof item.source === 'object' && typeof item.source.url === 'string'
          ? { name: String(item.source.name ?? ''), url: item.source.url }
          : null,
        at: typeof item.at === 'string' ? item.at : '',
        readAt: typeof item.readAt === 'string' ? item.readAt : null,
      })
    }
  }
  items.sort((a, b) => a.id - b.id)
  return { nextId, items: items.slice(-MESSAGE_LIMIT) }
}

export function readMessages(file) {
  return normalizeMessages(readJsonFile(file, emptyMessages()))
}

export function writeMessages(file, data) {
  atomicWriteJson(file, normalizeMessages(data))
}

/**
 * 入队一条主动消息。
 * @returns {{id:number,kind:string,text:string,source:object|null,at:string,readAt:null}}
 */
export function enqueueMessage(file, message = {}) {
  const data = readMessages(file)
  let nextId = data.nextId
  for (const item of data.items) nextId = Math.max(nextId, item.id + 1)
  const kind = message.kind === 'whisper' || message.kind === 'error' ? message.kind : 'roam'
  const entry = {
    id: nextId,
    kind,
    text: typeof message.text === 'string' ? message.text : '',
    source: message.source && typeof message.source === 'object' && typeof message.source.url === 'string'
      ? { name: String(message.source.name ?? ''), url: message.source.url }
      : null,
    at: typeof message.at === 'string' && message.at ? message.at : isoLocal(new Date()),
    readAt: null,
  }
  data.nextId = nextId + 1
  data.items.push(entry)
  if (data.items.length > MESSAGE_LIMIT) data.items = data.items.slice(-MESSAGE_LIMIT)
  writeMessages(file, data)
  return entry
}

/** 增量取消息：id > afterId，升序，最多 20 条 */
export function messagesAfter(file, afterId = 0, limit = 20) {
  const data = readMessages(file)
  const after = Number.isFinite(Number(afterId)) ? Number(afterId) : 0
  const count = Math.min(20, Math.max(1, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 20))
  const items = data.items.filter((item) => item.id > after).slice(0, count)
  const unreadCount = data.items.filter((item) => !item.readAt).length
  const maxId = data.items.reduce((max, item) => Math.max(max, item.id), 0)
  return { items, cursor: maxId, unreadCount }
}

/** 标记 id ≤ 给定值的消息已读；返回剩余未读数 */
export function markRead(file, id) {
  const data = readMessages(file)
  const target = Number.isFinite(Number(id)) ? Number(id) : 0
  const readAt = isoLocal(new Date())
  for (const item of data.items) {
    if (!item.readAt && item.id <= target) item.readAt = readAt
  }
  writeMessages(file, data)
  return data.items.filter((item) => !item.readAt).length
}

/** 未读数 */
export function unreadCount(file) {
  return readMessages(file).items.filter((item) => !item.readAt).length
}

/** 今天是否已经报过“没连上”（每天最多一条） */
function errorReportedToday(data, now) {
  const today = localDay(now)
  return data.items.some((item) => {
    if (item.kind !== 'error' || !item.at) return false
    const at = new Date(item.at)
    return !Number.isNaN(at.getTime()) && localDay(at) === today
  })
}

// ---------------------------------------------------------------------------
// 调度状态（state.json）与时间计算
// ---------------------------------------------------------------------------

export function emptyState() {
  return {
    roam: { day: '', count: 0, lastAt: null, nextAt: null, lastError: null, lastSource: null, running: false },
  }
}

/** 规范 state.json（缺字段补默认，坏值丢弃） */
export function normalizeState(raw) {
  const source = raw && typeof raw === 'object' && raw.roam && typeof raw.roam === 'object' ? raw.roam : {}
  return {
    roam: {
      day: typeof source.day === 'string' ? source.day : '',
      count: Number.isFinite(source.count) ? Math.max(0, Math.floor(source.count)) : 0,
      lastAt: typeof source.lastAt === 'string' ? source.lastAt : null,
      nextAt: typeof source.nextAt === 'string' ? source.nextAt : null,
      lastError: typeof source.lastError === 'string' ? source.lastError : null,
      lastSource: typeof source.lastSource === 'string' ? source.lastSource : null,
      running: source.running === true,
    },
  }
}

export function readState(file) {
  return normalizeState(readJsonFile(file, emptyState()))
}

export function writeState(file, state) {
  atomicWriteJson(file, normalizeState(state))
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 带本地时区偏移的 ISO 字符串（runtime 里给人看，比 UTC 的 Z 直观） */
export function isoLocal(date = new Date()) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  )
}

/** 基础间隔 × 0.75~1.25 的随机抖动（对应 SPEC §3 intervalMin 说明） */
export function jitterIntervalMs(intervalMin, random = Math.random) {
  const base = Number.isFinite(Number(intervalMin)) && Number(intervalMin) > 0 ? Number(intervalMin) : 90
  const factor = 0.75 + Math.min(1, Math.max(0, Number(random()) || 0)) * 0.5
  return Math.round(base * factor * 60_000)
}

/** 现在 + 一个抖动间隔，得到下次上网时间 */
export function nextRoamDate(now, intervalMin, random = Math.random) {
  return new Date(now.getTime() + jitterIntervalMs(intervalMin, random))
}

function parseHm(text, fallbackMinutes) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? '').trim())
  if (!match) return fallbackMinutes
  return Number(match[1]) * 60 + Number(match[2])
}

/** 是否处于安静时段（支持跨午夜，例如 23:00–08:00） */
export function isQuiet(quiet, now = new Date()) {
  if (!quiet || quiet.enabled !== true) return false
  const start = parseHm(quiet.start, 23 * 60)
  const end = parseHm(quiet.end, 8 * 60)
  if (start === end) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end
}

/** 安静时段结束后 1–3 分钟的随机时刻（跨午夜也能算对） */
export function afterQuietDate(quiet, now = new Date(), random = Math.random) {
  const end = parseHm(quiet && quiet.end, 8 * 60)
  const extra = 1 + Math.floor(Math.min(0.999, Math.max(0, Number(random()) || 0)) * 3)
  const target = new Date(now.getTime())
  target.setSeconds(0, 0)
  target.setHours(Math.floor(end / 60), end % 60, 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  target.setMinutes(target.getMinutes() + extra)
  return target
}

/** 次日 09:00 左右（每天次数用完后的顺延点） */
export function nextMorningDate(now = new Date(), random = Math.random) {
  const target = new Date(now.getTime())
  target.setDate(target.getDate() + 1)
  target.setHours(9, Math.floor(Math.min(0.999, Math.max(0, Number(random()) || 0)) * 30), 0, 0)
  return target
}

/** 每个新的一天重置今日次数；返回规范化后的 state（就地修改并写盘由调用方决定） */
export function rollDay(state, now = new Date()) {
  const today = localDay(now)
  if (state.roam.day !== today) {
    state.roam.day = today
    state.roam.count = 0
  }
  return state
}

// ---------------------------------------------------------------------------
// 失败降级文案
// ---------------------------------------------------------------------------

/** 把技术错误翻译成一句人话（别把 DNS/堆栈/HTTP 码直接甩给用户） */
export function shortReason(error) {
  const text = errorText(error)
  if (/2MB|太大/.test(text)) return '那边内容太大了，我搬不回来'
  // 只认具体地址：被拒消息里统一带「fake-IP」提示，不能用 fake-ip 字样判断，否则普通内网也误判
  if (/198\.18\.\d+\.\d+/.test(text)) {
    return '网络代理把地址隐藏了，换个来源试试（可在设置里打开「允许代理 fake-IP」）'
  }
  if (/内网|拒绝/.test(text)) {
    return '那个地址我进不去（如果你在用代理/虚拟网卡，可在设置里打开「允许代理 fake-IP」）'
  }
  if (/域名解析|没有解析/.test(text)) return '那个网址找不到'
  if (/HTTP\s*5\d\d/.test(text)) return '那边服务器好像有点问题'
  if (/HTTP\s*4\d\d/.test(text)) return '那个页面不让我看'
  if (/没连上|网络|超时|没动静|秒/.test(text)) return '网络好像不太通'
  if (/JSON|解析|没看懂|没抓到|不是 RSS/.test(text)) return '网页内容太乱，我没看懂'
  if (/模型|LLM|生成|脑子/.test(text)) return '我脑子卡住了，没想好怎么说'
  if (/来源|网址/.test(text)) return '我还没找到可以逛的地方'
  return '没连上'
}

// ---------------------------------------------------------------------------
// 对外动作：一次上网、一次碎碎念
// ---------------------------------------------------------------------------

/** 同一时刻只允许一次 roam（定时器与手动点击可能撞车） */
let roamInFlight = false

export function isRoamInFlight() {
  return roamInFlight
}

/**
 * 完整跑一次上网。
 *
 * @param {object} ctx 宿主上下文（llm + agentDefaultModel）
 * @param {object} options
 * @param {object} options.config 完整配置
 * @param {object} options.paths config.dataPaths() 的结果
 * @param {Date} [options.now]
 * @param {Function} [options.random] 随机源（测试注入）
 * @param {Function} [options.fetchImpl] fetch 实现（测试注入）
 * @param {Function} [options.lookup] DNS 解析（测试注入）
 * @returns {Promise<{ok:true,item:object,source:object,text:string} | {ok:false,error:string,reason?:string,skipped?:string}>}
 */
export async function runRoam(ctx, options = {}) {
  if (roamInFlight) {
    return { ok: false, skipped: 'running', error: '上一次上网还没回来，稍等一下' }
  }
  roamInFlight = true
  const config = options.config || {}
  const paths = options.paths || {}
  const messagesFile = paths.messages
  const stateFile = paths.state
  const now = options.now instanceof Date ? options.now : new Date()
  const random = typeof options.random === 'function' ? options.random : Math.random
  const sourceLabel = (source) => (source && source.name ? source.name : '某个网页')

  let state = readState(stateFile)
  try {
    rollDay(state, now)
    state.roam.running = true
    writeState(stateFile, state)
  } catch {
    /* 状态写不进去不影响这次上网 */
  }

  let currentSource = null
  try {
    const sources = Array.isArray(config.roam && config.roam.sources) ? config.roam.sources : []
    const source = pickSource(sources, state.roam.lastSource, random)
    if (!source) throw new RoamError('还没有可用的上网来源，先在设置里添加一个吧')
    currentSource = source
    console.log(`[dsh-whale-chat] 出门逛逛：${source.name}`)

    const fetched = await fetchSource(source, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_BODY_BYTES,
      fetchImpl: options.fetchImpl,
      lookup: options.lookup,
      // 默认放行（老配置里没有这个字段时也按 true）；关掉则严格按 SPEC 拒绝 RFC2544
      allowFakeIp: !(config.roam && config.roam.allowFakeIp === false),
    })
    const parsed = parseSource(fetched.body, source.type, { baseUrl: fetched.url })
    const charLimit = config.roam && Number.isFinite(config.roam.charLimit) ? config.roam.charLimit : 3000
    const extracted = renderExtracted(parsed, charLimit)
    if (!extracted) throw new RoamError('那个网页上没抓到什么内容')

    const ownerTitle = (config.persona && config.persona.ownerTitle) || '主人'
    const result = await generateText(ctx, {
      system: buildSystemPrompt(config, now),
      userText: buildRoamPrompt({ sourceName: source.name, ownerTitle, extracted }),
      temperature: 1,
      preferred: configuredModel(config.chat),
      timeoutMs: 60_000,
    })
    if (!result.ok) throw new RoamError(result.error || '转述失败')

    const item = enqueueMessage(messagesFile, {
      kind: 'roam',
      text: result.text,
      source: { name: source.name, url: source.url },
      at: isoLocal(now),
    })
    const after = readState(stateFile)
    rollDay(after, now)
    after.roam.running = false
    after.roam.count += 1
    after.roam.lastAt = isoLocal(now)
    after.roam.lastSource = source.name
    after.roam.lastError = null
    try {
      writeState(stateFile, after)
    } catch {
      /* 状态写失败不影响消息 */
    }
    console.log(`[dsh-whale-chat] 逛回来了：${source.name}（消息 #${item.id}）`)
    return { ok: true, item, source: { name: source.name, url: source.url }, text: result.text }
  } catch (error) {
    const reason = error instanceof RoamError ? error.message : errorText(error)
    const friendly = shortReason(error)
    console.log(`[dsh-whale-chat] 上网失败（${sourceLabel(currentSource)}）：${reason}`)
    try {
      const after = readState(stateFile)
      rollDay(after, now)
      after.roam.running = false
      after.roam.lastError = friendly
      writeState(stateFile, after)
    } catch {
      /* 忽略 */
    }
    // 失败降级：每天最多一条“没连上”，语气像人，不报技术栈
    try {
      if (config.roam && config.roam.reportFailure !== false) {
        const data = readMessages(messagesFile)
        if (!errorReportedToday(data, now)) {
          enqueueMessage(messagesFile, {
            kind: 'error',
            text: `我刚才想上网看看，结果没连上……${friendly}`,
            source: null,
            at: isoLocal(now),
          })
        }
      }
    } catch {
      /* 降级消息写失败就算了，绝不能因此抛出去 */
    }
    return { ok: false, error: friendly, reason: 'roam-failed' }
  } finally {
    roamInFlight = false
    try {
      const after = readState(stateFile)
      if (after.roam.running) {
        after.roam.running = false
        writeState(stateFile, after)
      }
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 生成一句碎碎念并入队（SPEC §5.4）。
 * @param {object} [options.force] true = 手动触发（设置页按钮），忽略 whisper.enabled（自动开关只管定时任务）
 * @returns {Promise<{ok:true,item:object} | {ok:false,error:string,reason:string}>}
 */
export async function generateWhisper(ctx, options = {}) {
  const config = options.config || {}
  const paths = options.paths || {}
  const now = options.now instanceof Date ? options.now : new Date()
  if (options.force !== true && (!config.whisper || config.whisper.enabled !== true)) {
    return { ok: false, reason: 'disabled', error: '主动碎碎念还没打开，在设置里打开就行' }
  }
  const ownerTitle = (config.persona && config.persona.ownerTitle) || '主人'
  const result = await generateText(ctx, {
    system: buildSystemPrompt(config, now),
    userText: buildWhisperPrompt({ ownerTitle }),
    temperature: 1,
    preferred: configuredModel(config.chat),
    timeoutMs: 60_000,
  })
  if (!result.ok) {
    console.log(`[dsh-whale-chat] 碎碎念生成失败：${result.error || result.reason}`)
    return { ok: false, reason: result.reason || 'generate-error', error: result.error || '生成失败：原因不明' }
  }
  let text = result.text.replace(/\s+/g, ' ').trim()
  if (text.length > 40) text = text.slice(0, 39) + '…'
  if (!text) return { ok: false, reason: 'empty', error: '模型这次什么都没说出来' }
  try {
    const item = enqueueMessage(paths.messages, { kind: 'whisper', text, source: null, at: isoLocal(now) })
    return { ok: true, item }
  } catch (error) {
    return { ok: false, reason: 'io-error', error: `碎碎念没存下来：${errorText(error).slice(0, 120)}` }
  }
}
