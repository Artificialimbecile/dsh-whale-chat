/**
 * roam.js 单测：SSRF 判定、抓取、JSON/RSS/HTML 抽取、来源选取、
 * 消息队列 id/已读、调度时间计算、失败降级文案。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  afterQuietDate,
  assertPublicUrl,
  decodeEntities,
  detectSourceType,
  emptyMessages,
  enqueueMessage,
  extractHtml,
  extractJson,
  extractRss,
  fetchSource,
  generateWhisper,
  isBlockedHostname,
  isPublicIp,
  isQuiet,
  isoLocal,
  jitterIntervalMs,
  markRead,
  messagesAfter,
  nextMorningDate,
  parseSource,
  pickSource,
  readMessages,
  renderExtracted,
  runRoam,
  shortReason,
  stripHtml,
  unreadCount,
} from '../lib/roam.js'
import { defaultConfig } from '../lib/config.js'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whale-roam-'))
const tempFile = (name = 'data.json') => path.join(tempDir(), name)
/** 公网解析器：不需要联网 */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
const jsonHeaders = { get: () => 'application/json' }
const noCall = () => {
  throw new Error('不应该走到 fetch')
}

// ---------------------------------------------------------------------------
// SSRF
// ---------------------------------------------------------------------------

test('isPublicIp：公网通过，回环/私网/链路本地/保留段拒绝', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPublicIp(ip), true, `${ip} 应是公网`)
  }
  for (const ip of [
    '127.0.0.1',
    '127.1.2.3',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '198.18.0.1',
    '192.0.2.5',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.8',
    'not-an-ip',
    '',
  ]) {
    assert.equal(isPublicIp(ip), false, `${ip} 应被拒绝`)
  }
})

test('isPublicIp：allowFakeIp 只额外放行 IPv4 的 198.18.0.0/15', () => {
  const allow = { allowFakeIp: true }
  assert.equal(isPublicIp('198.18.0.164', allow), true)
  assert.equal(isPublicIp('198.19.255.254', allow), true, '198.18.0.0/15 覆盖 198.19.x')
  assert.equal(isPublicIp('198.18.0.164'), false, '默认（strict）仍拒绝')
  assert.equal(isPublicIp('198.51.100.5', allow), false, '198/8 里其它保留段（文档示例）仍然拒绝')
  assert.equal(isPublicIp('10.0.0.1', allow), false)
  assert.equal(isPublicIp('100.64.0.1', allow), false)
  assert.equal(isPublicIp('127.0.0.1', allow), false)
  assert.equal(isPublicIp('169.254.169.254', allow), false)
  assert.equal(isPublicIp('::ffff:198.18.0.164', allow), false, 'IPv6 内嵌 IPv4 不享受 fake-IP 放行')
  assert.equal(isPublicIp('8.8.8.8', allow), true)
})

test('isBlockedHostname：localhost / .local / .internal / 裸 IP 域名', () => {
  assert.equal(isBlockedHostname('localhost'), true)
  assert.equal(isBlockedHostname('LOCALHOST.'), true)
  assert.equal(isBlockedHostname('foo.local'), true)
  assert.equal(isBlockedHostname('metadata.google.internal'), true)
  assert.equal(isBlockedHostname('router.lan'), true)
  assert.equal(isBlockedHostname('example.com'), false)
})

test('assertPublicUrl：公网通过（域名解析到公网）', async () => {
  const url = await assertPublicUrl('https://example.com/a?b=1', { lookup: publicLookup })
  assert.equal(url.hostname, 'example.com')
  const ipUrl = await assertPublicUrl('http://8.8.8.8/x', { lookup: noCall })
  assert.equal(ipUrl.hostname, '8.8.8.8')
})

test('assertPublicUrl：回环/内网/非法协议/内网域名 → 中文原因', async () => {
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1:8080/', { lookup: noCall }), /内网地址/)
  await assert.rejects(() => assertPublicUrl('http://[::1]/', { lookup: noCall }), /内网地址/)
  await assert.rejects(() => assertPublicUrl('http://localhost/', { lookup: noCall }), /内网地址/)
  await assert.rejects(() => assertPublicUrl('http://printer.local/', { lookup: noCall }), /内网地址/)
  await assert.rejects(() => assertPublicUrl('ftp://example.com/x', { lookup: noCall }), /http\/https/)
  await assert.rejects(() => assertPublicUrl('not a url', { lookup: noCall }), /合法的网址/)
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data', { lookup: noCall }), /内网地址/)
})

test('assertPublicUrl：域名解析到内网/解析失败 → 拒绝', async () => {
  await assert.rejects(
    () => assertPublicUrl('https://evil.example/', { lookup: async () => [{ address: '10.0.0.5', family: 4 }] }),
    /内网地址/,
  )
  await assert.rejects(
    () =>
      assertPublicUrl('https://mixed.example/', {
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      }),
    /内网地址/,
    '只要有一个解析结果在内网就拒绝',
  )
  await assert.rejects(
    () =>
      assertPublicUrl('https://nx.example/', {
        lookup: async () => {
          throw new Error('ENOTFOUND')
        },
      }),
    /域名解析失败/,
  )
  await assert.rejects(() => assertPublicUrl('https://empty.example/', { lookup: async () => [] }), /没有解析到/)
})

test('assertPublicUrl：allowFakeIp 只放行解析结果里的 fake-IP，字面量仍拒绝', async () => {
  const fakeLookup = async () => [{ address: '198.18.0.164', family: 4 }]
  const url = await assertPublicUrl('https://www.v2ex.com/api/topics/hot.json', {
    lookup: fakeLookup,
    allowFakeIp: true,
  })
  assert.equal(url.hostname, 'www.v2ex.com')

  // 默认（严格）拒绝，并在错误里给出可操作提示
  try {
    await assertPublicUrl('https://www.v2ex.com/api/topics/hot.json', { lookup: fakeLookup })
    assert.fail('不该通过')
  } catch (error) {
    assert.match(error.message, /内网地址/)
    assert.match(error.message, /198\.18\.0\.164/, '错误里带具体解析地址，便于排障')
    assert.match(error.message, /允许代理 fake-IP/, '错误里带可操作提示')
  }

  // 字面量 IP 永远按严格规则（fake-IP 放行只针对 DNS 解析结果）
  await assert.rejects(
    () => assertPublicUrl('http://198.18.5.5/', { lookup: noCall, allowFakeIp: true }),
    /内网地址/,
  )

  // 解析结果里只要有一条真内网，即使开了 allowFakeIp 也拒绝
  await assert.rejects(
    () =>
      assertPublicUrl('https://mixed.example/', {
        lookup: async () => [
          { address: '198.18.0.1', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
        allowFakeIp: true,
      }),
    /内网地址/,
  )
})

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

test('fetchSource：正常抓取（限时/UA/自定义 fetch）', async () => {
  let seenUrl = ''
  let seenOptions = null
  const fetchImpl = async (url, options) => {
    seenUrl = url
    seenOptions = options
    return {
      ok: true,
      status: 200,
      url,
      headers: jsonHeaders,
      text: async () => '{"ok":true}',
    }
  }
  const result = await fetchSource(
    { name: '测试源', url: 'https://example.com/feed', type: 'json' },
    { fetchImpl, lookup: publicLookup },
  )
  assert.equal(result.body, '{"ok":true}')
  assert.equal(result.contentType, 'application/json')
  assert.equal(seenUrl, 'https://example.com/feed')
  // B 站等站点会针对带产品标识的 UA 做风控（-352）：这里必须是纯浏览器 UA
  assert.match(seenOptions.headers['user-agent'], /^Mozilla\/5\.0 .*Chrome\/\d+/)
  assert.ok(!seenOptions.headers['user-agent'].includes('dsh-whale-chat'), 'UA 不能带插件标识')
  assert.equal(seenOptions.headers.accept, '*/*')
  assert.ok(seenOptions.signal instanceof AbortSignal)
  assert.equal(seenOptions.redirect, 'follow')
})

test('fetchSource：内网地址在 fetch 之前就拒绝', async () => {
  await assert.rejects(
    () => fetchSource({ name: '坏源', url: 'http://127.0.0.1/x' }, { fetchImpl: noCall, lookup: noCall }),
    /内网地址/,
  )
})

test('fetchSource：allowFakeIp 透传给 SSRF 校验（关闭时 fetch 前就拒绝）', async () => {
  let called = 0
  const fetchImpl = async (url) => {
    called += 1
    return { ok: true, status: 200, url, headers: jsonHeaders, text: async () => '{"a":1}' }
  }
  const fakeLookup = async () => [{ address: '198.18.0.164', family: 4 }]
  const source = { name: '代理源', url: 'https://www.v2ex.com/api/topics/hot.json' }

  await assert.rejects(() => fetchSource(source, { fetchImpl, lookup: fakeLookup }), /内网地址/)
  assert.equal(called, 0, '关闭 allowFakeIp 时不该发起 fetch')

  const result = await fetchSource(source, { fetchImpl, lookup: fakeLookup, allowFakeIp: true })
  assert.equal(result.body, '{"a":1}')
  assert.equal(called, 1)
})

test('fetchSource：重定向后的最终地址也校验（302 去内网 → 拒绝）', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: 'http://10.0.0.9/internal',
    headers: jsonHeaders,
    body: { cancel: async () => {} },
    text: async () => 'x',
  })
  await assert.rejects(
    () => fetchSource({ name: '源', url: 'https://example.com/' }, { fetchImpl, lookup: publicLookup }),
    /内网地址/,
  )
})

test('fetchSource：HTTP 错误 → 结构化中文原因', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    url: 'https://example.com/',
    headers: jsonHeaders,
    body: { cancel: async () => {} },
  })
  await assert.rejects(
    () => fetchSource({ name: '源', url: 'https://example.com/' }, { fetchImpl, lookup: publicLookup }),
    /HTTP 500/,
  )
})

test('fetchSource：响应超过 2MB → 拒绝并 cancel', async () => {
  let cancelled = false
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: 'https://example.com/',
    headers: jsonHeaders,
    body: {
      getReader() {
        return {
          read: async () => ({ done: false, value: new Uint8Array(1024 * 1024) }),
          cancel: async () => {
            cancelled = true
          },
          releaseLock() {},
        }
      },
    },
  })
  await assert.rejects(
    () => fetchSource({ name: '源', url: 'https://example.com/' }, { fetchImpl, lookup: publicLookup }),
    /2MB/,
  )
  assert.equal(cancelled, true)
})

// ---------------------------------------------------------------------------
// 抽取
// ---------------------------------------------------------------------------

test('stripHtml / decodeEntities', () => {
  assert.equal(stripHtml('<p>你好&amp;世界</p><script>bad()</script>'), '你好&世界')
  assert.equal(decodeEntities('&#20320;&#x597d;&nbsp;'), '你好 ')
})

test('extractJson：B 站热门形状（data.list）', () => {
  const parsed = extractJson(
    JSON.stringify({
      code: 0,
      data: {
        list: [
          { title: '视频甲', desc: '描述甲', short_link_v2: 'https://b23.tv/abc', owner: { name: 'UP主' } },
          { title: '视频乙', desc: '描述乙' },
        ],
      },
    }),
  )
  assert.equal(parsed.items.length, 2)
  assert.equal(parsed.items[0].title, '视频甲')
  assert.match(parsed.items[0].detail, /描述甲/)
  assert.equal(parsed.items[0].url, 'https://b23.tv/abc')
})

test('extractJson：V2EX 顶层数组', () => {
  const parsed = extractJson(
    JSON.stringify([
      { title: '话题一', content: '内容一', url: 'https://www.v2ex.com/t/1' },
      { title: '话题二' },
    ]),
  )
  assert.deepEqual(parsed.items.map((item) => item.title), ['话题一', '话题二'])
  assert.equal(parsed.items[0].url, 'https://www.v2ex.com/t/1')
})

test('extractJson：知乎日报 stories', () => {
  const parsed = extractJson(
    JSON.stringify({ date: '20261028', stories: [{ title: '日报甲', url: 'https://daily.zhihu.com/story/1' }] }),
  )
  assert.equal(parsed.items[0].title, '日报甲')
})

test('extractJson：维基随机摘要（title + extract，无列表）', () => {
  const parsed = extractJson(
    JSON.stringify({
      title: '鲸',
      extract: '鲸是海洋哺乳动物。',
      content_urls: { desktop: { page: 'https://zh.wikipedia.org/wiki/鲸' } },
    }),
  )
  assert.equal(parsed.title, '鲸')
  assert.equal(parsed.summary, '鲸是海洋哺乳动物。')
  assert.deepEqual(parsed.items, [])
})

test('extractJson：非法 JSON 抛中文原因', () => {
  assert.throws(() => extractJson('<html>不是 JSON</html>'), /合法 JSON/)
})

test('extractRss：RSS 2.0（CDATA、实体、链接）', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>少数派</title>
<item><title><![CDATA[今天的好东西]]></title><description><![CDATA[<p>一段介绍</p>]]></description><link>https://sspai.com/post/1</link></item>
<item><title>第二篇 &amp; 续</title><description>纯文本</description><link>https://sspai.com/post/2</link></item>
</channel></rss>`
  const parsed = extractRss(xml)
  assert.equal(parsed.title, '少数派')
  assert.deepEqual(parsed.items.map((item) => item.title), ['今天的好东西', '第二篇 & 续'])
  assert.equal(parsed.items[0].detail, '一段介绍')
  assert.equal(parsed.items[1].url, 'https://sspai.com/post/2')
})

test('extractRss：Atom（link href）', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom源</title>
<entry><title>原子条目</title><link href="https://example.com/a"/><summary>摘要内容</summary></entry>
</feed>`
  const parsed = extractRss(xml)
  assert.equal(parsed.title, 'Atom源')
  assert.equal(parsed.items[0].title, '原子条目')
  assert.equal(parsed.items[0].url, 'https://example.com/a')
  assert.equal(parsed.items[0].detail, '摘要内容')
})

test('extractHtml：title / meta description / 段落 / 小标题', () => {
  const html = `<html><head><title>一篇文章</title>
<meta name="description" content="这是摘要"></head><body>
<article><h2>小标题</h2><p>这是第一段正文，足够长可以留下来。</p><p>第二段正文也足够长了。</p></article>
</body></html>`
  const parsed = extractHtml(html)
  assert.equal(parsed.title, '一篇文章')
  assert.equal(parsed.summary, '这是摘要')
  assert.equal(parsed.items[0].title, '小标题')
  assert.match(stripHtml(parsed.summary), /摘要/)
})

test('detectSourceType / parseSource：自动判断类型', () => {
  assert.equal(detectSourceType('  {"a":1}'), 'json')
  assert.equal(detectSourceType('[{"a":1}]'), 'json')
  assert.equal(detectSourceType('<rss><channel></channel></rss>'), 'rss')
  assert.equal(detectSourceType('<html><body>hi</body></html>'), 'html')
  const parsed = parseSource('<html><head><title>T</title></head><body><p>一段正文内容在这里。</p></body></html>')
  assert.equal(parsed.type, 'html')
  assert.equal(parsed.title, 'T')
})

test('renderExtracted：拼接与 charLimit 截断', () => {
  const parsed = {
    title: '标题',
    summary: '简介内容',
    items: [{ title: '条目一', detail: '细节一' }, { title: '条目二', detail: '' }],
  }
  const text = renderExtracted(parsed, 3000)
  assert.match(text, /^标题：标题/)
  assert.match(text, /简介：简介内容/)
  assert.match(text, /- 条目一：细节一/)
  assert.match(text, /- 条目二/)
  const clipped = renderExtracted(parsed, 10)
  assert.ok(clipped.length <= 11, '截断后只多一个省略号')
  assert.ok(clipped.endsWith('…'))
})

// ---------------------------------------------------------------------------
// 来源选取
// ---------------------------------------------------------------------------

test('pickSource：不连续重复、单来源、空清单', () => {
  const sources = [
    { name: 'a', url: 'https://a.example/' },
    { name: 'b', url: 'https://b.example/' },
    { name: 'c', url: 'https://c.example/' },
  ]
  assert.equal(pickSource(sources, 'a', () => 0).name, 'b', '跳过上一次的来源')
  assert.equal(pickSource(sources, 'a', () => 0.999).name, 'c')
  assert.equal(pickSource(sources, 'b', () => 0).name, 'a')
  assert.equal(pickSource([{ name: 'only', url: 'https://o.example/' }], 'only', () => 0.5).name, 'only')
  assert.equal(pickSource([], 'x'), null)
  assert.equal(pickSource([{ name: '坏', url: '' }], 'x'), null)
})

// ---------------------------------------------------------------------------
// 消息队列
// ---------------------------------------------------------------------------

test('消息队列：id 递增、增量读取、limit、已读与未读数', () => {
  const file = tempFile('messages.json')
  assert.deepEqual(readMessages(file), emptyMessages())

  const first = enqueueMessage(file, { kind: 'roam', text: '第一句', source: { name: '源', url: 'https://a.example/' } })
  const second = enqueueMessage(file, { kind: 'whisper', text: '第二句', source: null })
  const third = enqueueMessage(file, { kind: 'error', text: '没连上', source: null })
  assert.deepEqual([first.id, second.id, third.id], [1, 2, 3])
  assert.equal(first.readAt, null)
  assert.equal(second.source, null)

  let page = messagesAfter(file, 0, 20)
  assert.deepEqual(page.items.map((item) => item.id), [1, 2, 3])
  assert.equal(page.cursor, 3)
  assert.equal(page.unreadCount, 3)

  page = messagesAfter(file, 1, 20)
  assert.deepEqual(page.items.map((item) => item.id), [2, 3])

  page = messagesAfter(file, 0, 2)
  assert.deepEqual(page.items.map((item) => item.id), [1, 2], 'limit 生效且按 id 升序')

  assert.equal(markRead(file, 2), 1, '标记 ≤2 的未读后只剩 1 条未读')
  page = messagesAfter(file, 0, 20)
  assert.equal(page.items[0].readAt !== null, true)
  assert.equal(page.unreadCount, 1)
  assert.equal(unreadCount(file), 1)

  markRead(file, 999)
  assert.equal(unreadCount(file), 0)
})

test('消息队列：最多保留 200 条（从头丢）', () => {
  const file = tempFile('messages.json')
  for (let i = 0; i < 205; i += 1) {
    enqueueMessage(file, { kind: 'roam', text: `第 ${i} 条` })
  }
  const data = readMessages(file)
  assert.equal(data.items.length, 200)
  assert.equal(data.items[0].id, 6, '最旧的 5 条被丢掉')
  assert.equal(data.items[199].id, 205)
  assert.equal(data.nextId, 206)
})

// ---------------------------------------------------------------------------
// 调度时间
// ---------------------------------------------------------------------------

test('isQuiet：跨午夜与同日窗口', () => {
  const cross = { enabled: true, start: '23:00', end: '08:00' }
  assert.equal(isQuiet(cross, new Date(2026, 9, 28, 23, 30)), true)
  assert.equal(isQuiet(cross, new Date(2026, 9, 28, 1, 0)), true)
  assert.equal(isQuiet(cross, new Date(2026, 9, 28, 8, 0)), false)
  assert.equal(isQuiet(cross, new Date(2026, 9, 28, 12, 0)), false)
  assert.equal(isQuiet({ ...cross, enabled: false }, new Date(2026, 9, 28, 23, 30)), false)

  const sameDay = { enabled: true, start: '13:00', end: '14:00' }
  assert.equal(isQuiet(sameDay, new Date(2026, 9, 28, 13, 30)), true)
  assert.equal(isQuiet(sameDay, new Date(2026, 9, 28, 14, 0)), false)
  assert.equal(isQuiet({ enabled: true, start: '09:00', end: '09:00' }, new Date(2026, 9, 28, 9, 0)), false)
})

test('afterQuietDate：跨午夜窗口结束后 1–3 分钟', () => {
  const quiet = { enabled: true, start: '23:00', end: '08:00' }
  const late = afterQuietDate(quiet, new Date(2026, 9, 28, 23, 30), () => 0)
  assert.equal(late.getDate(), 29, '23:30 时顺延到次日 08:0x')
  assert.equal(late.getHours(), 8)
  assert.equal(late.getMinutes(), 1)

  const early = afterQuietDate(quiet, new Date(2026, 9, 28, 1, 0), () => 0.999)
  assert.equal(early.getDate(), 28)
  assert.equal(early.getHours(), 8)
  assert.ok(early.getMinutes() >= 1 && early.getMinutes() <= 4)
})

test('jitterIntervalMs：0.75~1.25 倍', () => {
  assert.equal(jitterIntervalMs(90, () => 0), 90 * 0.75 * 60_000)
  assert.equal(jitterIntervalMs(90, () => 0.5), 90 * 60_000)
  assert.equal(jitterIntervalMs(90, () => 1), 90 * 1.25 * 60_000)
  assert.ok(jitterIntervalMs(90, Math.random) >= 90 * 0.75 * 60_000)
  assert.ok(jitterIntervalMs(90, Math.random) <= 90 * 1.25 * 60_000)
})

test('nextMorningDate / isoLocal', () => {
  const next = nextMorningDate(new Date(2026, 9, 28, 14, 0), () => 0)
  assert.equal(next.getDate(), 29)
  assert.equal(next.getHours(), 9)
  assert.equal(next.getMinutes(), 0)
  assert.match(isoLocal(new Date(2026, 9, 28, 21, 0, 5)), /^2026-10-28T21:00:05[+-]\d{2}:\d{2}$/)
})

test('shortReason：技术错误翻译成人话', () => {
  assert.match(shortReason(new Error('抓取被拒绝：目标是内网地址')), /那个地址我进不去/)
  assert.match(shortReason(new Error('抓取被拒绝：目标是内网地址')), /允许代理 fake-IP/)
  assert.match(
    shortReason(new Error('抓取被拒绝：目标是内网地址（www.v2ex.com → 198.18.0.164；如果你在用代理/虚拟网卡…）')),
    /网络代理把地址隐藏了，换个来源试试/,
  )
  assert.equal(shortReason(new Error('内容太大：超过 2MB，先不看了')), '那边内容太大了，我搬不回来')
  assert.match(shortReason(new Error('抓取失败：等了 15 秒还没连上')), /网络/)
  assert.match(shortReason(new Error('抓取失败：对方返回 HTTP 503')), /服务器/)
  assert.match(shortReason(new Error('模型没有给出正文')), /脑子/)
})

test('runRoam：从 config 读 allowFakeIp（默认放行 fake-IP 解析结果，显式关闭则拦截）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-roam-fakeip-'))
  const paths = {
    dataDir: dir,
    config: path.join(dir, 'config.json'),
    memory: path.join(dir, 'memory.json'),
    messages: path.join(dir, 'messages.json'),
    state: path.join(dir, 'state.json'),
  }
  const fakeLookup = async () => [{ address: '198.18.0.164', family: 4 }]
  const config = defaultConfig()
  config.roam.sources = [{ name: '代理源', url: 'https://www.v2ex.com/api/topics/hot.json', type: 'json' }]
  config.roam.reportFailure = false
  let fetched = []
  const fetchImpl = async (url) => {
    fetched.push(url)
    return {
      ok: true,
      status: 200,
      url,
      headers: jsonHeaders,
      text: async () => JSON.stringify({ data: { list: [{ title: '今天的帖子' }] } }),
    }
  }
  // 没有可用模型：抓取/解析会通过，最后停在 LLM 失败 —— 正好用来验证 allowFakeIp 是否传到抓取层
  const ctx = { agentDefaultModel: { currentSelection: () => null } }

  let result = await runRoam(ctx, { config, paths, lookup: fakeLookup, fetchImpl, now: new Date(2026, 9, 28, 12, 0) })
  assert.equal(result.ok, false)
  assert.equal(fetched.length, 1, '默认 allowFakeIp=true：SSRF 放行并真的抓了')
  assert.equal(fetched[0], 'https://www.v2ex.com/api/topics/hot.json')

  config.roam.allowFakeIp = false
  fetched = []
  result = await runRoam(ctx, { config, paths, lookup: fakeLookup, fetchImpl, now: new Date(2026, 9, 28, 13, 0) })
  assert.equal(result.ok, false)
  assert.equal(fetched.length, 0, '显式关闭后 fake-IP 在抓取前被拒')
  assert.match(result.error, /网络代理|代理/)
})

test('generateWhisper：自动开关关闭且非手动 → 结构化说明（不调模型）', async () => {
  const config = defaultConfig()
  const result = await generateWhisper({}, { config, paths: {}, now: new Date() })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'disabled')
  assert.match(result.error, /还没打开/)
})

test('generateWhisper：手动触发 / 有自动开关但无 LLM → 结构化失败（不崩）', async () => {
  const config = defaultConfig()
  config.whisper.enabled = true
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
  const result = await generateWhisper(ctx, { config, paths: {}, now: new Date() })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'llm-unavailable')
})
