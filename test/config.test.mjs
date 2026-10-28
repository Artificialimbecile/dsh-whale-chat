/**
 * config.js 单测：默认值、深合并、白名单、严格/宽松校验、原子读写。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULTS,
  atomicWriteJson,
  dataPaths,
  deepMerge,
  defaultConfig,
  localDay,
  mergeAndValidate,
  pickKnownTop,
  readConfig,
  readJsonFile,
  sanitizeConfig,
  writeConfig,
} from '../lib/config.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whale-config-'))
}

test('默认配置：结构完整、来源 7 个', () => {
  const config = defaultConfig()
  assert.equal(config.version, 1)
  assert.equal(config.persona.name, '小鲸')
  assert.equal(config.persona.ownerTitle, '主人')
  assert.equal(config.chat.memoryRounds, 5)
  assert.equal(config.chat.provider, '')
  assert.equal(config.appearance.corner, 'bottom-right')
  assert.equal(config.roam.intervalMin, 90)
  assert.equal(config.roam.allowFakeIp, true, '默认放行代理 fake-IP 解析结果')
  assert.equal(config.roam.sources.length, 7)
  // 默认源必须开箱即用：36 氪官方 RSS 已失效，默认换成 Solidot
  assert.equal(config.roam.sources.some((source) => source.name.includes('Solidot')), true)
  assert.equal(
    config.roam.sources.some((source) => source.url.includes('solidot.org/index.rss') && source.type === 'rss'),
    true,
  )
  assert.equal(config.roam.sources.some((source) => source.url.includes('36kr.com')), false)
  assert.equal(config.roam.quiet.start, '23:00')
  assert.equal(config.whisper.enabled, false)
  // 返回的是深拷贝：改它不该污染 DEFAULTS
  config.persona.name = '别的小鲸'
  assert.equal(DEFAULTS.persona.name, '小鲸')
})

test('deepMerge：对象递归合并、数组整体替换、undefined 不覆盖', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2], keep: 'x' }
  const merged = deepMerge(base, { a: { c: 3 }, list: [9], ghost: undefined })
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9], keep: 'x' })
  assert.deepEqual(base.list, [1, 2], '不能修改 base')
})

test('pickKnownTop：未知顶层键丢弃', () => {
  const filtered = pickKnownTop({ persona: { name: 'a' }, evil: 1, __proto__: { x: 1 } })
  assert.deepEqual(filtered, { persona: { name: 'a' } })
})

test('mergeAndValidate：部分更新深合并出完整配置', () => {
  const base = defaultConfig()
  const result = mergeAndValidate(base, { appearance: { size: 480, corner: 'top-left' } })
  assert.equal(result.ok, true)
  assert.equal(result.config.appearance.size, 480)
  assert.equal(result.config.appearance.corner, 'top-left')
  assert.equal(result.config.appearance.marginX, 24, '没提供的字段保持原值')
  assert.equal(result.config.persona.name, '小鲸')
})

test('mergeAndValidate：未知子键被丢弃', () => {
  const result = mergeAndValidate(defaultConfig(), {
    persona: { name: '阿鲸', hacker: true },
    appearance: { size: 300, evil: 'x' },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.config.persona).sort(), ['name', 'ownerTitle', 'selfClaim', 'text'])
  assert.equal(result.config.appearance.evil, undefined)
})

test('mergeAndValidate：非法人设名字 → 400 原因', () => {
  const empty = mergeAndValidate(defaultConfig(), { persona: { name: '' } })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /persona\.name/)
  const long = mergeAndValidate(defaultConfig(), { persona: { name: '鲸'.repeat(21) } })
  assert.equal(long.ok, false)
  assert.match(long.error, /1–20/)
})

test('mergeAndValidate：数字越界/非整数/非数字都给理由', () => {
  const tooBig = mergeAndValidate(defaultConfig(), { appearance: { size: 9999 } })
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.error, /appearance\.size/)

  const notInteger = mergeAndValidate(defaultConfig(), { chat: { memoryRounds: 1.5 } })
  assert.equal(notInteger.ok, false)
  assert.match(notInteger.error, /整数/)

  const notNumber = mergeAndValidate(defaultConfig(), { chat: { temperature: 'hot' } })
  assert.equal(notNumber.ok, false)
  assert.match(notNumber.error, /数字/)
})

test('mergeAndValidate：provider/model 只填一半 → 拒绝', () => {
  const providerOnly = mergeAndValidate(defaultConfig(), { chat: { provider: 'deepseek-account' } })
  assert.equal(providerOnly.ok, false)
  assert.match(providerOnly.error, /同时留空或同时填写/)

  const both = mergeAndValidate(defaultConfig(), { chat: { provider: 'p', model: 'm' } })
  assert.equal(both.ok, true)
  assert.equal(both.config.chat.model, 'm')
})

test('mergeAndValidate：来源清单校验（非法 url/type/超 30 项）', () => {
  const badUrl = mergeAndValidate(defaultConfig(), {
    roam: { sources: [{ name: '坏源', url: 'ftp://example.com/x', type: 'json' }] },
  })
  assert.equal(badUrl.ok, false)
  assert.match(badUrl.error, /http\/https/)

  const badType = mergeAndValidate(defaultConfig(), {
    roam: { sources: [{ name: '源', url: 'https://example.com/x', type: 'xml' }] },
  })
  assert.equal(badType.ok, false)
  assert.match(badType.error, /auto \/ json \/ rss \/ html/)

  const emptyName = mergeAndValidate(defaultConfig(), {
    roam: { sources: [{ name: ' ', url: 'https://example.com/x' }] },
  })
  assert.equal(emptyName.ok, false)

  const tooMany = mergeAndValidate(defaultConfig(), {
    roam: { sources: Array.from({ length: 31 }, (_, i) => ({ name: `源${i}`, url: 'https://example.com/', type: 'auto' })) },
  })
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.error, /最多 30 项/)
})

test('roam.allowFakeIp：默认 true、严格校验布尔、宽松口径坏值回落', () => {
  assert.equal(defaultConfig().roam.allowFakeIp, true)

  const off = mergeAndValidate(defaultConfig(), { roam: { allowFakeIp: false } })
  assert.equal(off.ok, true)
  assert.equal(off.config.roam.allowFakeIp, false)

  const bad = mergeAndValidate(defaultConfig(), { roam: { allowFakeIp: 'yes' } })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /roam\.allowFakeIp/)

  assert.equal(sanitizeConfig({ roam: { allowFakeIp: 'yes' } }).config.roam.allowFakeIp, true)
})

test('mergeAndValidate：人设正文允许空串', () => {
  const result = mergeAndValidate(defaultConfig(), { persona: { text: '' } })
  assert.equal(result.ok, true)
  assert.equal(result.config.persona.text, '')
})

test('sanitizeConfig：读盘口径能修就修（越界夹到边界）', () => {
  const { config, warnings } = sanitizeConfig({
    persona: { name: ' 阿鲸 ', selfClaim: '本鲸' },
    appearance: { size: 9999, corner: 'middle', fontFamily: 'comic' },
    roam: { intervalMin: -3, sources: [{ name: 'ok', url: 'https://example.com/', type: 'auto' }, { name: '', url: 'bad' }] },
  })
  assert.ok(warnings.length > 0)
  assert.equal(config.persona.name, '阿鲸', '字符串去首尾空白')
  assert.equal(config.appearance.size, 640, '越界夹到上限')
  assert.equal(config.appearance.corner, 'bottom-right', '非法枚举回落默认')
  assert.equal(config.appearance.fontFamily, 'candy')
  assert.equal(config.roam.intervalMin, 5, '越界夹到下限')
  assert.equal(config.roam.sources.length, 1, '坏来源项被丢弃')
})

test('readConfig：文件缺失/损坏/非对象 → 默认配置', () => {
  const dir = tempDir()
  const file = path.join(dir, 'config.json')
  assert.equal(readConfig(file).persona.name, '小鲸')

  fs.writeFileSync(file, 'not json', 'utf8')
  assert.equal(readConfig(file).persona.name, '小鲸')

  fs.writeFileSync(file, '[1,2,3]', 'utf8')
  assert.equal(readConfig(file).persona.name, '小鲸')
})

test('readConfig：用户文件与默认深合并', () => {
  const dir = tempDir()
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ persona: { name: '泡泡' }, roam: { intervalMin: 30 } }), 'utf8')
  const config = readConfig(file)
  assert.equal(config.persona.name, '泡泡')
  assert.equal(config.persona.ownerTitle, '主人')
  assert.equal(config.roam.intervalMin, 30)
  assert.equal(config.roam.maxPerDay, 6)
})

test('writeConfig：原子写（无 tmp 残留、能读回）', () => {
  const dir = tempDir()
  const file = path.join(dir, 'nested', 'config.json')
  const config = defaultConfig()
  config.persona.name = '原子鲸'
  writeConfig(config, file)
  assert.equal(fs.existsSync(file), true)
  assert.equal(fs.existsSync(file + '.tmp'), false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).persona.name, '原子鲸')
})

test('atomicWriteJson：写失败不留下半个文件', () => {
  const dir = tempDir()
  const target = path.join(dir, 'x.json')
  // 目标是已存在的目录 → rename 会失败；此时 tmp 应被清理
  fs.mkdirSync(target)
  assert.throws(() => atomicWriteJson(target, { a: 1 }))
  assert.deepEqual(fs.readdirSync(dir), ['x.json'])
})

test('readJsonFile：坏文件回落 fallback', () => {
  const dir = tempDir()
  assert.deepEqual(readJsonFile(path.join(dir, 'none.json'), { fallback: true }), { fallback: true })
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops', 'utf8')
  assert.deepEqual(readJsonFile(path.join(dir, 'bad.json'), []), [])
})

test('dataPaths / localDay', () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(tempDir(), 'dsh-home')
  try {
    const paths = dataPaths()
    assert.equal(paths.dataDir, path.join(process.env.DSH_HOME, 'dsh-whale-chat'))
    assert.equal(paths.config, path.join(paths.dataDir, 'config.json'))
    assert.equal(paths.memory, path.join(paths.dataDir, 'memory.json'))
    assert.equal(paths.messages, path.join(paths.dataDir, 'messages.json'))
    assert.equal(paths.state, path.join(paths.dataDir, 'state.json'))
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
  assert.equal(localDay(new Date(2026, 9, 28, 23, 59)), '2026-10-28')
  assert.equal(localDay(new Date(2026, 0, 2, 0, 0)), '2026-01-02')
})
