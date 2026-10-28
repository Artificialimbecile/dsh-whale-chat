/**
 * 极简 HTTP 工具：JSON/文本/文件响应、请求体读取、静态资源路径校验、DSH 可信栅栏。
 *
 * 可信栅栏（SPEC §4）：DSH 的 Web 端口是回环地址，但浏览器里任何一个网页都能向回环发请求，
 * 所以 `/api/*` 必须先过 `connection.requestRejection(req)`；`connection` 不可用时按 fail-closed
 * 拒绝（503），绝不因为“拿不到安全组件”就放行。静态资源与自检页不含敏感数据，放行。
 */
import path from 'node:path'
import { createReadStream, fstatSync } from 'node:fs'

/** 扩展名 → Content-Type（只放行这些，够 webm/字体/图片/清单用） */
export const MIME = {
  '.webm': 'video/webm',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

/** 静态资源允许的扩展名白名单（不允许 .js/.html/.md 等，减少暴露面） */
export const ASSET_EXTENSIONS = ['.webm', '.ttf', '.woff', '.woff2', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.json']

/** 请求体不合法（外层折成 400） */
export class BadRequestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BadRequestError'
  }
}

/** 发 JSON（统一 no-store：设置/状态/消息都是会变的数据，浏览器不许缓存） */
export function json(res, status, obj, headers = {}) {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

/** 发纯文本（错误兜底用） */
export function sendText(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(body)
}

/** 发 HTML（自检页） */
export function sendHtml(res, status, html, headers = {}) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(html)
}

/**
 * 流式发文件。Content-Length 取**正在读的那个 fd** 的 fstat：
 * 先 stat 再另开流的话，文件在中间被替换/截断会声明一个永远发不完的响应（浏览器卡死）。
 */
export function sendFile(res, file, contentType) {
  const stream = createReadStream(file)
  stream.once('open', (fd) => {
    if (res.destroyed || res.writableEnded) {
      stream.destroy()
      return
    }
    try {
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': fstatSync(fd).size,
        'cache-control': 'public, max-age=3600',
      })
    } catch {
      // fstat 失败：不发长度头，交给 Node chunked 收尾（长度天然一致）
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'public, max-age=3600' })
    }
    stream.pipe(res)
  })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
}

/** 按扩展名取 Content-Type；不在白名单 → undefined */
export function contentTypeOf(file) {
  const ext = path.extname(String(file ?? '')).toLowerCase()
  return MIME[ext]
}

/**
 * 把 URL 里的相对路径解析到 assets 根目录内；穿越（`..%2F`、绝对路径）→ undefined。
 * @returns {string|undefined} 规范化后的绝对文件路径
 */
export function resolveAsset(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return undefined
  const candidate = path.normalize(path.join(root, rel))
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined
  if (candidate === root) return undefined
  return candidate
}

/** 静态资源相对路径是否合法（扩展名白名单 + 不含 NUL） */
export function isAllowedAssetPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false
  if (rel.includes('\0')) return false
  if (rel.split('/').some((segment) => segment === '..')) return false
  const ext = path.extname(rel).toLowerCase()
  return ASSET_EXTENSIONS.includes(ext)
}

/** 读请求体（文本），超过 limit 字节直接拒绝并销毁连接 */
export function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new BadRequestError(`请求内容太大了（上限 ${Math.round(limit / 1024)}KB）`))
        try {
          req.destroy()
        } catch {
          /* 忽略 */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => reject(error))
  })
}

/**
 * 读并解析 JSON 请求体。
 * 空体返回 {}；解析失败抛 BadRequestError（外层统一 400，别让 JSON.parse 抛到宿主）。
 */
export async function readJsonBody(req, limit = 256 * 1024) {
  let raw = ''
  try {
    raw = await readBody(req, limit)
  } catch (error) {
    if (error instanceof BadRequestError) throw error
    throw new BadRequestError('读取请求内容失败')
  }
  if (!raw.trim()) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BadRequestError('请求内容不是合法 JSON')
  }
  return parsed && typeof parsed === 'object' ? parsed : {}
}

/** 是否回环 Host（快速通道；不等于放行 —— 后面 requestRejection 仍会校验登录态） */
export function isLoopbackRequest(req) {
  const host = String(req?.headers?.host ?? '').toLowerCase()
  const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/** 从 ctx 里取 connection 服务（不同 DSH 版本写法略有差异，两个都试） */
function connectionOf(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const service = ctx.get('connection')
      if (service) return service
    }
  } catch {
    /* 忽略 */
  }
  try {
    return ctx ? ctx.connection : undefined
  } catch {
    return undefined
  }
}

/**
 * 创建可信栅栏。
 * @returns {{ isTrusted(req:object):boolean, reject(req:object,res:object):boolean }}
 *   reject 返回 true 表示“已经拒绝并写回响应，调用方直接 return”。
 */
export function createTrustFence(ctx) {
  let warnedMissingConnection = false

  function isTrusted(req) {
    if (isLoopbackRequest(req)) return true
    try {
      const connection = connectionOf(ctx)
      if (connection && typeof connection.isTrusted === 'function') return connection.isTrusted(req) === true
    } catch {
      /* 拿不到判断结果 → 不可信 */
    }
    return false
  }

  function reject(req, res) {
    if (!isTrusted(req)) {
      json(res, 403, { ok: false, error: '不受信任的访问来源' })
      return true
    }
    try {
      const connection = connectionOf(ctx)
      if (!connection || typeof connection.requestRejection !== 'function') {
        if (!warnedMissingConnection) {
          warnedMissingConnection = true
          console.warn('[dsh-whale-chat] 信任栅栏不可用：connection 服务缺失 → 按 fail-closed 拒绝')
        }
        json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问' })
        return true
      }
      const code = connection.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      if (res.writableEnded || res.destroyed) return true
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问' })
      return true
    }
  }

  return { isTrusted, reject }
}
