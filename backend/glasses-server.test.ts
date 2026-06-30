import { test, expect } from 'bun:test'
import { createGlassesServer } from './glasses-server'

const fakeStt = { name: 'whispercpp' as const, transcribe: async () => '你好' }
const fakeAgent = { async *ask() { yield '你也好' } }

test('POST 音频 → SSE user/answer/done', async () => {
  const srv = createGlassesServer({ stt: fakeStt, agent: fakeAgent, token: 't', ttlMs: 5000 })
  const fd = new FormData()
  fd.append('audio', new Blob([new Uint8Array([1, 2])], { type: 'audio/wav' }), 'a.wav')
  const res = await srv.handleChat(new Request('http://x/glasses/chat', {
    method: 'POST', headers: { authorization: 'Bearer t' }, body: fd,
  }))
  const txt = await res.text()
  expect(txt).toContain('"type":"user"')
  expect(txt).toContain('你也好')
  expect(txt).toContain('"type":"done"')
})

test('流式:多块 → 多个 answer_delta + 一条终态 answer(完整)', async () => {
  const streamAgent = { async *ask() { yield '晴，'; yield '22度' } }
  const srv = createGlassesServer({ stt: fakeStt, agent: streamAgent, token: 't', ttlMs: 5000 })
  const fd = new FormData()
  fd.append('audio', new Blob([new Uint8Array([1])], { type: 'audio/wav' }), 'a.wav')
  const res = await srv.handleChat(new Request('http://x/glasses/chat', {
    method: 'POST', headers: { authorization: 'Bearer t' }, body: fd,
  }))
  const txt = await res.text()
  const deltas = [...txt.matchAll(/"type":"answer_delta","text":"([^"]*)"/g)].map(m => m[1])
  expect(deltas).toEqual(['晴，', '22度'])          // 逐块下发
  expect(txt).toContain('"type":"answer","text":"晴，22度"') // 终态完整答案(落盘/TTS 用)
  // 终态 answer 必须在 done 之前
  expect(txt.indexOf('"type":"answer","text":"晴，22度"')).toBeLessThan(txt.indexOf('"type":"done"'))
})

test('无 token → 401', async () => {
  const srv = createGlassesServer({ stt: fakeStt, agent: fakeAgent, token: 't', ttlMs: 5000 })
  const res = await srv.handleChat(new Request('http://x/glasses/chat', { method: 'POST', body: new FormData() }))
  expect(res.status).toBe(401)
})

test('首轮 model 起初未知 → 大脑出声后补发 meta(状态栏不空)', async () => {
  let model: string | undefined // 模拟 SDK：开头未知，大脑一跑才有
  const lateModelAgent = { async *ask() { model = 'Opus 4.8'; yield '答案' } }
  const srv = createGlassesServer({
    stt: fakeStt, agent: lateModelAgent, token: 't', ttlMs: 5000,
    getMeta: () => (model ? { model, usage5h: '', usage7d: '' } : undefined),
  })
  const fd = new FormData()
  fd.append('audio', new Blob([new Uint8Array([1])], { type: 'audio/wav' }), 'a.wav')
  const res = await srv.handleChat(new Request('http://x/glasses/chat', {
    method: 'POST', headers: { authorization: 'Bearer t' }, body: fd,
  }))
  const txt = await res.text()
  expect(txt).toContain('"type":"meta"') // 首轮也发了 meta
  expect(txt).toContain('Opus 4.8')
})

test('空转写不进大脑,回 error', async () => {
  const blankStt = { name: 'whispercpp' as const, transcribe: async () => '   ' }
  const srv = createGlassesServer({ stt: blankStt, agent: fakeAgent, token: 't', ttlMs: 5000 })
  const fd = new FormData()
  fd.append('audio', new Blob([new Uint8Array([1])], { type: 'audio/wav' }), 'a.wav')
  const res = await srv.handleChat(new Request('http://x/glasses/chat', {
    method: 'POST', headers: { authorization: 'Bearer t' }, body: fd,
  }))
  const txt = await res.text()
  expect(txt).toContain('没说话')
})
