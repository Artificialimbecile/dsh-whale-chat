/**
 * llm.js 单测：候选链去重、配置模型解析、无正文原因、正文收集、错误文案映射。
 * （真正的 llm.stream 需要 DSH 运行时，不在这里测；本文件只测纯函数。）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PET_CALL_IDENTITY,
  collectText,
  configuredModel,
  currentModel,
  failureMessage,
  modelCandidates,
  modelLabel,
  noTextReason,
} from '../lib/llm.js'

const ctxOf = (selection) => ({ agentDefaultModel: { currentSelection: () => selection } })

test('configuredModel：都填 → 选择；只填一半 → undefined；空白 → undefined', () => {
  assert.deepEqual(configuredModel({ provider: ' deepseek-account ', model: ' deepseek-flash ' }), {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  assert.equal(configuredModel({ provider: 'p', model: '' }), undefined)
  assert.equal(configuredModel({ provider: '', model: 'm' }), undefined)
  assert.equal(configuredModel({}), undefined)
  assert.equal(configuredModel(null), undefined)
})

test('currentModel：拿不到/抛错 → undefined', () => {
  assert.deepEqual(currentModel(ctxOf({ provider: 'p', model: 'm' })), { provider: 'p', model: 'm' })
  assert.equal(currentModel(ctxOf(null)), undefined)
  assert.equal(currentModel({}), undefined)
  assert.equal(
    currentModel({
      agentDefaultModel: {
        currentSelection() {
          throw new Error('boom')
        },
      },
    }),
    undefined,
  )
})

test('modelCandidates：配置优先、当前兜底、同项去重', () => {
  const preferred = { provider: 'paid', model: 'fast' }
  const current = { provider: 'deepseek-account', model: 'deepseek-flash' }
  assert.deepEqual(modelCandidates(ctxOf(current), preferred), [preferred, current])
  assert.deepEqual(modelCandidates(ctxOf(preferred), preferred), [preferred], '同一个选择只留一次')
  assert.deepEqual(modelCandidates(ctxOf(current), undefined), [current])
  assert.deepEqual(modelCandidates(ctxOf(null), undefined), [])
  assert.equal(modelLabel(preferred), 'paid/fast')
})

test('noTextReason：按流终止原因给中文解释', () => {
  assert.equal(noTextReason({ kind: 'aborted' }), '生成已取消')
  assert.equal(noTextReason({ kind: 'max-tokens' }), '输出达到上限，未产出正文')
  assert.equal(noTextReason({ kind: 'stop' }), '模型未返回文本')
  assert.equal(noTextReason(null), '模型未返回文本')
  assert.equal(noTextReason({ kind: 'error', failure: { message: '额度不足' } }), '额度不足')
  assert.equal(noTextReason({ kind: 'error', failure: { code: 'AUTH' } }), 'AUTH')
  assert.equal(noTextReason({ kind: 'error', failure: {} }), '未提供失败原因')
})

test('collectText：只拼 text 块并 trim', () => {
  assert.equal(collectText([{ type: 'text', text: ' 你好' }, { type: 'reasoning', text: '想' }, { type: 'text', text: '呀 ' }]), '你好呀')
  assert.equal(collectText([]), '')
  assert.equal(collectText(null), '')
  assert.equal(collectText([{ type: 'text' }]), '')
})

test('failureMessage：机器 reason → 人话', () => {
  assert.equal(failureMessage({ reason: 'no-model' }), '当前对话未配置模型')
  assert.match(failureMessage({ reason: 'llm-unavailable', message: '没有可用的模型服务' }), /LLM 服务不可用/)
  assert.match(failureMessage({ reason: 'timeout', message: '60 秒内没有回复' }), /等太久/)
  assert.match(failureMessage({ reason: 'empty', message: '额度不足' }), /额度不足/)
  assert.match(failureMessage({ reason: 'generate-error', message: '连接被重置' }), /生成失败/)
})

test('调用身份常量', () => {
  assert.equal(PET_CALL_IDENTITY, 'dsh-whale-chat')
})
