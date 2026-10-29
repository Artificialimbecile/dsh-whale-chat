/**
 * chat.js 单测：记忆规范化/上限/截取、历史接口、清空、失败不写记忆。
 * （成功生成需要 DSH 的 llm 服务，这里只测失败路径，验证“失败绝不污染记忆”。）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MEMORY_LIMIT,
  appendMessages,
  clearMemory,
  emptyMemory,
  generateChat,
  historySlice,
  memoryCount,
  mergeHistory,
  normalizeMemory,
  readHistory,
  readMemory,
  writeMemory,
} from '../lib/chat.js'
import { defaultConfig } from '../lib/config.js'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whale-chat-'))
const tempFile = (name = 'memory.json') => path.join(tempDir(), name)

test('normalizeMemory：坏条目丢弃、字段补全', () => {
  const memory = normalizeMemory({
    messages: [
      { role: 'user', content: '你好', ts: 1, kind: 'chat' },
      { role: 'system', content: '不合法角色', ts: 2 },
      { role: 'assistant', content: '', ts: 3 },
      null,
      { role: 'assistant', content: '在呢', ts: 4 },
    ],
  })
  assert.equal(memory.messages.length, 2)
  assert.deepEqual(memory.messages[1], { role: 'assistant', content: '在呢', ts: 4, kind: 'chat' })
  assert.deepEqual(normalizeMemory(null), emptyMemory())
})

test('writeMemory / readMemory：原子往返', () => {
  const file = tempFile()
  writeMemory(file, { messages: [{ role: 'user', content: '在吗', ts: 10, kind: 'chat' }] })
  assert.equal(fs.existsSync(file + '.tmp'), false)
  const memory = readMemory(file)
  assert.equal(memory.messages.length, 1)
  assert.equal(memory.messages[0].content, '在吗')
})

test('appendMessages：超过 1000 条从头丢', () => {
  const file = tempFile()
  const entries = Array.from({ length: MEMORY_LIMIT + 5 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${i} 条`,
    ts: i,
    kind: 'chat',
  }))
  const result = appendMessages(file, entries)
  assert.equal(result.count, MEMORY_LIMIT)
  const memory = readMemory(file)
  assert.equal(memory.messages.length, MEMORY_LIMIT)
  assert.equal(memory.messages[0].content, '第 5 条')
  assert.equal(memory.messages[MEMORY_LIMIT - 1].content, `第 ${MEMORY_LIMIT + 4} 条`)
})

test('historySlice：取最近 N 轮、从 user 开头、轮数 0 为空', () => {
  const messages = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ]
  assert.deepEqual(historySlice(messages, 1).map((m) => m.content), ['u3'])
  assert.deepEqual(historySlice(messages, 2).map((m) => m.content), ['u2', 'a2', 'u3'])
  assert.deepEqual(historySlice(messages, 0), [])
  // 截断点落在 assistant 上时，把它丢掉（保证从 user 开头）
  assert.deepEqual(historySlice(messages.slice(1), 2).map((m) => m.content), ['u2', 'a2', 'u3'])
})

test('readHistory：limit 夹取、时间正序', () => {
  const file = tempFile()
  appendMessages(
    file,
    Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `第 ${i} 条`, ts: i, kind: 'chat' })),
  )
  const history = readHistory(file, 50)
  assert.equal(history.length, 50)
  assert.equal(history[0].content, '第 10 条')
  assert.equal(history[49].content, '第 59 条')
  assert.deepEqual(Object.keys(history[0]).sort(), ['content', 'kind', 'role', 'ts'])
  assert.equal(readHistory(file, 0).length, 1, 'limit 下限 1')
  assert.equal(readHistory(file, 9999).length, 60, 'limit 上限 200，但只有 60 条')
})

test('mergeHistory：聊天与主动消息按时间合并、尾部截取、脏数据丢弃', () => {
  const chat = [
    { role: 'user', content: '早', ts: 100 },
    { role: 'assistant', content: '早呀', ts: 200 },
    { role: 'user', content: '晚上好', ts: 400 },
  ]
  const proactive = [
    {
      role: 'assistant',
      content: '上网看到新闻',
      ts: 300,
      kind: 'roam',
      source: { name: 'Solidot', url: 'https://www.solidot.org/' },
      id: 'p1',
    },
    { role: 'assistant', content: '随口一句', ts: 400, kind: 'whisper', id: 'p2' },
  ]
  const merged = mergeHistory(chat, proactive, 50)
  assert.deepEqual(
    merged.map((m) => m.content),
    ['早', '早呀', '上网看到新闻', '晚上好', '随口一句'],
    '按 ts 正序；同 ts 时聊天在前、主动消息在后',
  )
  assert.equal(merged[2].source.url, 'https://www.solidot.org/')
  assert.deepEqual(mergeHistory(chat, proactive, 2).map((m) => m.content), ['晚上好', '随口一句'], 'limit 取尾部')
  assert.deepEqual(mergeHistory([{ content: '' }], null, 10), [], '空内容/非数组不炸')
})

test('clearMemory：返回清掉的条数、文件清空', () => {
  const file = tempFile()
  appendMessages(file, [
    { role: 'user', content: 'a', ts: 1 },
    { role: 'assistant', content: 'b', ts: 2 },
  ])
  assert.equal(memoryCount(file), 2)
  assert.equal(clearMemory(file), 2)
  assert.equal(memoryCount(file), 0)
  assert.deepEqual(readMemory(file), emptyMemory())
})

test('generateChat：没有可用模型/LLM 时返回结构化失败，且不写记忆', async () => {
  const file = tempFile('memory.json')
  const config = defaultConfig()

  const noModel = await generateChat({ agentDefaultModel: { currentSelection: () => null } }, config, {
    text: '在吗',
    memoryFile: file,
  })
  assert.equal(noModel.ok, false)
  assert.equal(noModel.reason, 'no-model')
  assert.match(noModel.error, /未配置模型/)
  assert.equal(fs.existsSync(file), false, '失败不写记忆')

  const noLlm = await generateChat(
    { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, llm: undefined },
    config,
    { text: '在吗', memoryFile: file },
  )
  assert.equal(noLlm.ok, false)
  assert.equal(noLlm.reason, 'llm-unavailable')
  assert.equal(fs.existsSync(file), false)

  const emptyText = await generateChat(
    { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    config,
    { text: '   ', memoryFile: file },
  )
  assert.equal(emptyText.ok, false)
  assert.equal(emptyText.reason, 'bad-input')
  assert.equal(fs.existsSync(file), false)
})

test('generateChat：已有记忆不会因失败被改写', async () => {
  const file = tempFile('memory.json')
  writeMemory(file, { messages: [{ role: 'user', content: '旧消息', ts: 1, kind: 'chat' }] })
  const before = fs.readFileSync(file, 'utf8')
  const config = defaultConfig()
  const result = await generateChat({ agentDefaultModel: { currentSelection: () => null } }, config, {
    text: '新消息',
    memoryFile: file,
  })
  assert.equal(result.ok, false)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})
