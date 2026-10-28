/**
 * http.js 单测：静态路径防穿越、扩展名白名单、请求体读取、可信栅栏（含 fail-closed）。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import {
  BadRequestError,
  contentTypeOf,
  createTrustFence,
  isAllowedAssetPath,
  isLoopbackRequest,
  json,
  readBody,
  readJsonBody,
  resolveAsset,
} from '../lib/http.js'

const ASSETS = path.resolve('assets')

function fakeRes() {
  return {
    statusCode: 200,
    headers: null,
    body: '',
    writableEnded: false,
    destroyed: false,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
      return this
    },
    end(body) {
      this.body = body
      this.writableEnded = true
      return this
    },
  }
}

function fakeReq({ host = '127.0.0.1:53999', method = 'GET' } = {}) {
  return { headers: { host }, method }
}

test('resolveAsset：assets 目录内可解析，穿越返回 undefined', () => {
  const inside = resolveAsset(ASSETS, 'webm/待机呼吸休闲.webm')
  assert.equal(inside, path.join(ASSETS, 'webm', '待机呼吸休闲.webm'))
  assert.equal(resolveAsset(ASSETS, '../package.json'), undefined)
  assert.equal(resolveAsset(ASSETS, 'webm/../../package.json'), undefined)
  assert.equal(resolveAsset(ASSETS, ''), undefined)
})

test('isAllowedAssetPath：扩展名白名单 + 拒绝 .. 与 NUL', () => {
  assert.equal(isAllowedAssetPath('webm/待机呼吸休闲.webm'), true)
  assert.equal(isAllowedAssetPath('font/candy.ttf'), true)
  assert.equal(isAllowedAssetPath('icon.png'), true)
  assert.equal(isAllowedAssetPath('manifest.json'), true)
  assert.equal(isAllowedAssetPath('../../config.json'), false)
  assert.equal(isAllowedAssetPath('webm/../../../package.json'), false)
  assert.equal(isAllowedAssetPath('lib/index.js'), false)
  assert.equal(isAllowedAssetPath('evil.js'), false)
  assert.equal(isAllowedAssetPath('a\0b.webm'), false)
})

test('contentTypeOf：常见类型', () => {
  assert.equal(contentTypeOf('a.webm'), 'video/webm')
  assert.equal(contentTypeOf('candy.ttf'), 'font/ttf')
  assert.equal(contentTypeOf('icon.PNG'), 'image/png')
  assert.equal(contentTypeOf('x.exe'), undefined)
})

test('readBody / readJsonBody：正常、非法 JSON、空体', async () => {
  assert.equal(await readBody(Readable.from([Buffer.from('hello')])), 'hello')
  assert.deepEqual(await readJsonBody(Readable.from([Buffer.from('{"a":1}')])), { a: 1 })
  assert.deepEqual(await readJsonBody(Readable.from([Buffer.from('  ')])), {})
  await assert.rejects(() => readJsonBody(Readable.from([Buffer.from('{oops')])), BadRequestError)
})

test('readBody：超过上限 → BadRequestError', async () => {
  await assert.rejects(() => readBody(Readable.from([Buffer.alloc(32)]), 16), /太大了/)
})

test('json：统一 Content-Type 与 no-store', () => {
  const res = fakeRes()
  json(res, 200, { ok: true })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(res.body), { ok: true })
})

test('isLoopbackRequest：回环 Host 识别', () => {
  assert.equal(isLoopbackRequest(fakeReq({ host: '127.0.0.1:53999' })), true)
  assert.equal(isLoopbackRequest(fakeReq({ host: 'localhost:80' })), true)
  assert.equal(isLoopbackRequest(fakeReq({ host: '[::1]:53999' })), true)
  assert.equal(isLoopbackRequest(fakeReq({ host: '192.168.1.2:53999' })), false)
  assert.equal(isLoopbackRequest({ headers: {} }), false)
})

test('createTrustFence：回环 + 栅栏放行 → false', () => {
  const fence = createTrustFence({
    get: () => ({ isTrusted: () => true, requestRejection: () => null }),
  })
  const res = fakeRes()
  assert.equal(fence.reject(fakeReq(), res), false)
  assert.equal(res.writableEnded, false)
})

test('createTrustFence：栅栏返回状态码 → 拒绝并写回状态码', () => {
  const fence = createTrustFence({
    get: () => ({ isTrusted: () => true, requestRejection: () => 401 }),
  })
  const res = fakeRes()
  assert.equal(fence.reject(fakeReq(), res), true)
  assert.equal(res.statusCode, 401)
  assert.equal(res.writableEnded, true)
})

test('createTrustFence：非回环且不可信 → 403', () => {
  const fence = createTrustFence({ get: () => ({ isTrusted: () => false, requestRejection: () => true }) })
  const res = fakeRes()
  assert.equal(fence.reject(fakeReq({ host: 'evil.example.com' }), res), true)
  assert.equal(res.statusCode, 403)
  assert.match(JSON.parse(res.body).error, /不受信任/)
})

test('createTrustFence：connection 缺失 → fail-closed 503', () => {
  const fence = createTrustFence({ get: () => undefined })
  const res = fakeRes()
  assert.equal(fence.reject(fakeReq(), res), true)
  assert.equal(res.statusCode, 503)
  assert.match(JSON.parse(res.body).error, /信任栅栏不可用/)
})

test('createTrustFence：requestRejection 抛错 → fail-closed 503', () => {
  const fence = createTrustFence({
    get: () => ({
      isTrusted: () => true,
      requestRejection: () => {
        throw new Error('boom')
      },
    }),
  })
  const res = fakeRes()
  assert.equal(fence.reject(fakeReq(), res), true)
  assert.equal(res.statusCode, 503)
})
