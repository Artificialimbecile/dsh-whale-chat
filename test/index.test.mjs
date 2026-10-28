/**
 * index.js 单测：路由分类（§4 路径/方法契约）、runtime 快照、调度计划（nextAt/安静时段/每日上限）。
 * 不启动真实宿主，也不触发真实联网。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ROUTE_PREFIX,
  VERSION,
  buildRuntime,
  classifyApi,
  ensureInitialSchedule,
  inject,
  name,
  rescheduleAfterRoam,
  tick,
} from '../lib/index.js'
import { defaultConfig, writeConfig } from '../lib/config.js'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whale-index-'))

function tempPaths() {
  const dir = tempDir()
  return {
    dataDir: dir,
    config: path.join(dir, 'config.json'),
    memory: path.join(dir, 'memory.json'),
    messages: path.join(dir, 'messages.json'),
    state: path.join(dir, 'state.json'),
  }
}

function readStateFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const ctxWith = (selection) => ({ agentDefaultModel: { currentSelection: () => selection } })

test('插件入口：name / inject / 路由前缀', () => {
  assert.equal(name, 'dsh-whale-chat')
  assert.deepEqual(inject, ['webServer', 'connection', 'llm', 'agentDefaultModel'])
  assert.equal(ROUTE_PREFIX, '/dsh-whale-chat')
  assert.equal(VERSION, '0.1.0')
})

test('classifyApi：SPEC §4 路径/方法', () => {
  assert.deepEqual(classifyApi('GET', '/api/settings'), { status: 200, key: 'settings:get' })
  assert.deepEqual(classifyApi('post', '/api/settings'), { status: 200, key: 'settings:post' })
  assert.deepEqual(classifyApi('GET', '/api/status'), { status: 200, key: 'status:get' })
  assert.deepEqual(classifyApi('GET', '/api/history'), { status: 200, key: 'history:get' })
  assert.deepEqual(classifyApi('POST', '/api/history/clear'), { status: 200, key: 'history:clear' })
  assert.deepEqual(classifyApi('POST', '/api/chat'), { status: 200, key: 'chat:post' })
  assert.deepEqual(classifyApi('GET', '/api/messages'), { status: 200, key: 'messages:get' })
  assert.deepEqual(classifyApi('POST', '/api/messages/read'), { status: 200, key: 'messages:read' })
  assert.deepEqual(classifyApi('POST', '/api/roam'), { status: 200, key: 'roam:post' })
  assert.deepEqual(classifyApi('POST', '/api/whisper'), { status: 200, key: 'whisper:post' })
  assert.deepEqual(classifyApi('POST', '/api/selftest/chat'), { status: 200, key: 'selftest:chat' })
  assert.deepEqual(classifyApi('GET', '/api/unknown'), { status: 404 })
  const wrong = classifyApi('DELETE', '/api/chat')
  assert.equal(wrong.status, 405)
  assert.deepEqual(wrong.allow, ['POST'])
})

test('buildRuntime：模型/记忆/未读/roam 快照', () => {
  const paths = tempPaths()
  writeConfig(defaultConfig(), paths.config)
  fs.writeFileSync(paths.memory, JSON.stringify({ messages: [{ role: 'user', content: 'a', ts: 1, kind: 'chat' }] }))
  fs.writeFileSync(
    paths.messages,
    JSON.stringify({ nextId: 3, items: [{ id: 1, kind: 'roam', text: 'x', source: null, at: '', readAt: null }] }),
  )
  fs.writeFileSync(
    paths.state,
    JSON.stringify({
      roam: {
        day: new Date().toLocaleDateString('sv-SE'),
        count: 2,
        lastAt: '2026-10-28T21:00:00+08:00',
        nextAt: '2026-10-28T22:20:00+08:00',
        lastSource: 'V2EX 热帖',
        lastError: null,
        running: false,
      },
    }),
  )
  const runtime = buildRuntime(ctxWith({ provider: 'deepseek-account', model: 'deepseek-flash' }), defaultConfig(), paths)
  assert.equal(runtime.version, '0.1.0')
  assert.deepEqual(runtime.model, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.deepEqual(runtime.chatModel, runtime.model, '没单独配模型时跟随当前对话')
  assert.equal(runtime.memoryCount, 1)
  assert.equal(runtime.unread, 1)
  assert.equal(runtime.roam.todayCount, 2)
  assert.equal(runtime.roam.lastSource, 'V2EX 热帖')
  assert.equal(runtime.dataDir, paths.dataDir)
})

test('buildRuntime：无模型 / 单独配模型', () => {
  const paths = tempPaths()
  const config = defaultConfig()
  config.chat.provider = 'cheap'
  config.chat.model = 'cheap-model'
  const runtime = buildRuntime(ctxWith(null), config, paths)
  assert.equal(runtime.model, null)
  assert.deepEqual(runtime.chatModel, { provider: 'cheap', model: 'cheap-model' })
})

test('ensureInitialSchedule：首次安装排到未来，不立刻联网', () => {
  const paths = tempPaths()
  const config = defaultConfig()
  writeConfig(config, paths.config)
  const now = new Date()
  ensureInitialSchedule(paths, config, now)
  const state = readStateFile(paths.state)
  assert.ok(state.roam.nextAt, '写了 nextAt')
  assert.ok(new Date(state.roam.nextAt).getTime() > now.getTime())
  assert.equal(state.roam.running, false)

  const firstNextAt = state.roam.nextAt
  ensureInitialSchedule(paths, config, now)
  assert.equal(readStateFile(paths.state).roam.nextAt, firstNextAt, '已有计划不重算')
})

test('rescheduleAfterRoam：无论成败重算 nextAt、清 running', () => {
  const paths = tempPaths()
  const config = defaultConfig()
  writeConfig(config, paths.config)
  fs.writeFileSync(
    paths.state,
    JSON.stringify({
      roam: { day: '', count: 0, lastAt: null, nextAt: null, lastError: null, lastSource: null, running: true },
    }),
  )
  const now = new Date(2026, 9, 28, 12, 0)
  const state = rescheduleAfterRoam(paths, config, now)
  assert.equal(state.roam.running, false)
  assert.ok(new Date(state.roam.nextAt).getTime() > now.getTime())
  assert.equal(readStateFile(paths.state).roam.nextAt, state.roam.nextAt)
})

test('tick：roam 关闭 → nextAt 清空', () => {
  const paths = tempPaths()
  const config = defaultConfig()
  config.roam.enabled = false
  writeConfig(config, paths.config)
  fs.writeFileSync(
    paths.state,
    JSON.stringify({
      roam: { day: '', count: 0, lastAt: null, nextAt: '2026-10-28T22:00:00+08:00', lastError: null, lastSource: null, running: false },
    }),
  )
  tick({}, paths, {}, new Date(2026, 9, 28, 12, 0))
  assert.equal(readStateFile(paths.state).roam.nextAt, null)
})

test('tick：安静时段 → 顺延到时段结束后（跨午夜）', () => {
  const paths = tempPaths()
  const config = defaultConfig()
  config.roam.quiet = { enabled: true, start: '23:00', end: '08:00' }
  writeConfig(config, paths.config)
  const now = new Date(2026, 9, 28, 23, 30)
  tick({}, paths, {}, now)
  const state = readStateFile(paths.state)
  const nextAt = new Date(state.roam.nextAt)
  assert.equal(nextAt.getDate(), 29)
  assert.equal(nextAt.getHours(), 8)
  assert.ok(nextAt.getTime() > now.getTime())
  assert.equal(state.roam.running, false)
})

test('tick：每天上限用完 → 顺延到次日早上', () => {
  const paths = tempPaths()
  const config = defaultConfig()
  config.roam.maxPerDay = 2
  config.roam.quiet.enabled = false
  writeConfig(config, paths.config)
  fs.writeFileSync(
    paths.state,
    JSON.stringify({
      roam: {
        day: new Date(2026, 9, 28).toLocaleDateString('sv-SE'),
        count: 2,
        lastAt: null,
        nextAt: null,
        lastError: null,
        lastSource: null,
        running: false,
      },
    }),
  )
  tick({}, paths, {}, new Date(2026, 9, 28, 14, 0))
  const nextAt = new Date(readStateFile(paths.state).roam.nextAt)
  assert.equal(nextAt.getDate(), 29)
  assert.equal(nextAt.getHours(), 9)
})

test('tick：不到点不发车（nextAt 在未来）', () => {
  const paths = tempPaths()
  const config = defaultConfig()
  config.roam.quiet.enabled = false
  writeConfig(config, paths.config)
  const now = new Date(2026, 9, 28, 14, 0)
  const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
  fs.writeFileSync(
    paths.state,
    JSON.stringify({
      roam: { day: '2026-10-28', count: 0, lastAt: null, nextAt: future, lastError: null, lastSource: null, running: false },
    }),
  )
  const tickState = { whisperNextAt: 0 }
  tick({}, paths, tickState, now)
  const state = readStateFile(paths.state)
  assert.equal(state.roam.running, false)
  assert.equal(new Date(state.roam.nextAt).getTime(), new Date(future).getTime())
})

test('tick：碎碎念关闭时清空计时；开启时排一个未来时间', () => {
  const paths = tempPaths()
  const config = defaultConfig()
  config.roam.enabled = false
  config.roam.quiet.enabled = false
  writeConfig(config, paths.config)
  const tickState = { whisperNextAt: 123 }
  tick({}, paths, tickState, new Date(2026, 9, 28, 14, 0))
  assert.equal(tickState.whisperNextAt, 0)

  config.whisper.enabled = true
  writeConfig(config, paths.config)
  tick({}, paths, tickState, new Date(2026, 9, 28, 14, 0))
  assert.ok(tickState.whisperNextAt > new Date(2026, 9, 28, 14, 0).getTime())
})
