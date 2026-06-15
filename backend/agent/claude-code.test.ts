import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeCodeAgent, type SdkQuery } from './claude-code'

test('ask 累积 assistant text blocks,yield 完整回答', async () => {
  const fakeQuery: SdkQuery = async function* () {
    yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: '晴，' }, { type: 'text', text: '22度' }] } }
    yield { type: 'result', subtype: 'success' }
  }
  const agent = new ClaudeCodeAgent({ query: fakeQuery })
  const out: string[] = []
  for await (const c of agent.ask('天气', { turnId: 'g:1' })) out.push(c)
  expect(out).toEqual(['晴，22度'])
})

test('记住 session_id,第二轮带 resume + bypassPermissions', async () => {
  const seen: Record<string, unknown>[] = []
  const fakeQuery: SdkQuery = async function* (p) {
    seen.push(p.options)
    yield { type: 'assistant', session_id: 'sess-X', message: { content: [{ type: 'text', text: 'hi' }] } }
    yield { type: 'result', subtype: 'success' }
  }
  const agent = new ClaudeCodeAgent({ query: fakeQuery })
  for await (const _ of agent.ask('a', { turnId: 'g:1' })) { void _ }
  for await (const _ of agent.ask('b', { turnId: 'g:2' })) { void _ }
  expect(seen[0].resume).toBeUndefined()      // 第一轮无 resume
  expect(seen[1].resume).toBe('sess-X')        // 第二轮续上一轮 session
  expect(seen[1].permissionMode).toBe('bypassPermissions')
})

test('systemPromptAppend + maxTurns 传进 options', async () => {
  let opts: Record<string, unknown> = {}
  const fakeQuery: SdkQuery = async function* (p) {
    opts = p.options
    yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'ok' }] } }
  }
  const agent = new ClaudeCodeAgent({ query: fakeQuery, systemPromptAppend: '你是 Rode', maxTurns: 12 })
  for await (const _ of agent.ask('hi', { turnId: 'g:1' })) { void _ }
  expect(opts.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: '你是 Rode' })
  expect(opts.maxTurns).toBe(12)
})

test('currentModel 捕获 SDK 真实模型', async () => {
  const fakeQuery: SdkQuery = async function* () {
    yield { type: 'assistant', session_id: 's', message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hi' }] } }
  }
  const agent = new ClaudeCodeAgent({ query: fakeQuery })
  expect(agent.currentModel()).toBeUndefined()
  for await (const _ of agent.ask('hi', { turnId: 'g:1' })) { void _ }
  expect(agent.currentModel()).toBe('claude-sonnet-4-5')
})

test('sessionFile：落盘 sessionId，新实例(模拟重启)恢复并带 resume', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rode-sess-')), 'session-id')
  const q1: SdkQuery = async function* () {
    yield { type: 'assistant', session_id: 'sess-persist', message: { content: [{ type: 'text', text: 'hi' }] } }
  }
  const a1 = new ClaudeCodeAgent({ query: q1, sessionFile: file })
  for await (const _ of a1.ask('a', { turnId: 'g:1' })) { void _ }
  expect(readFileSync(file, 'utf8')).toBe('sess-persist') // 已落盘

  // 新实例 = 进程重启：应从盘上恢复 sessionId，下一轮带 resume
  let opts: Record<string, unknown> = {}
  const q2: SdkQuery = async function* (p) {
    opts = p.options
    yield { type: 'assistant', session_id: 'sess-persist', message: { content: [{ type: 'text', text: 'ok' }] } }
  }
  const a2 = new ClaudeCodeAgent({ query: q2, sessionFile: file })
  for await (const _ of a2.ask('b', { turnId: 'g:2' })) { void _ }
  expect(opts.resume).toBe('sess-persist') // 重启后仍续上下文
})

test('resume 失效兜底：第一轮(带 resume)抛错则清 session 重来一轮(无 resume)', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rode-sess-')), 'session-id')
  writeFileSync(file, 'stale-session') // 预置一个已失效的 session
  const calls: (string | undefined)[] = []
  const q: SdkQuery = async function* (p) {
    calls.push(p.options.resume as string | undefined)
    if (p.options.resume) throw new Error('session not found') // 旧 session 已被 SDK 清掉
    yield { type: 'assistant', session_id: 'fresh', message: { content: [{ type: 'text', text: '重来的答案' }] } }
  }
  const agent = new ClaudeCodeAgent({ query: q, sessionFile: file })
  const out: string[] = []
  for await (const c of agent.ask('hi', { turnId: 'g:1' })) out.push(c)
  expect(calls).toEqual(['stale-session', undefined]) // 先带 resume 失败，再无 resume 重试
  expect(out).toEqual(['重来的答案'])                  // 兜底成功，没把助手卡死
  expect(readFileSync(file, 'utf8')).toBe('fresh')     // 新 session 已落盘
})

test('有图片时 prompt 带 Read 提示', async () => {
  let gotPrompt = ''
  const fakeQuery: SdkQuery = async function* (p) {
    gotPrompt = p.prompt
    yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'ok' }] } }
  }
  const agent = new ClaudeCodeAgent({ query: fakeQuery })
  for await (const _ of agent.ask('这是啥', { turnId: 'g:1', imagePath: '/tmp/x.jpg' })) { void _ }
  expect(gotPrompt).toContain('/tmp/x.jpg')
  expect(gotPrompt).toContain('Read')
})
