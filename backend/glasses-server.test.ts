import { test, expect } from 'bun:test'
import { createGlassesServer } from './glasses-server'
import { NoopTts } from './tts'

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

async function chat(srv: ReturnType<typeof createGlassesServer>): Promise<string> {
  const fd = new FormData()
  fd.append('audio', new Blob([new Uint8Array([1])], { type: 'audio/wav' }), 'a.wav')
  const res = await srv.handleChat(new Request('http://x/glasses/chat', {
    method: 'POST', headers: { authorization: 'Bearer t' }, body: fd,
  }))
  return res.text()
}

test('TTS 成功: answer 后发 tts，最后 done', async () => {
  const tts = {
    name: 'edge' as const,
    synthesize: async (text: string) => ({ audio: new TextEncoder().encode(text), mime: 'audio/mpeg' }),
  }
  const srv = createGlassesServer({ stt: fakeStt, agent: fakeAgent, tts, token: 't', ttlMs: 5000 })
  const txt = await chat(srv)
  const answerAt = txt.indexOf('"type":"answer"')
  const ttsAt = txt.indexOf('"type":"tts"')
  const doneAt = txt.indexOf('"type":"done"')
  expect(answerAt).toBeGreaterThanOrEqual(0)
  expect(answerAt).toBeLessThan(ttsAt)
  expect(ttsAt).toBeLessThan(doneAt)
})

test('TTS 失败只跳过 tts 事件，文字与 done 正常', async () => {
  const tts = {
    name: 'edge' as const,
    synthesize: async () => { throw new Error('mock synth failed') },
  }
  const srv = createGlassesServer({ stt: fakeStt, agent: fakeAgent, tts, token: 't', ttlMs: 5000 })
  const txt = await chat(srv)
  expect(txt).toContain('"type":"answer"')
  expect(txt).not.toContain('"type":"tts"')
  expect(txt).toContain('"type":"done"')
})

test('TTS off 不调用合成且不发 tts 事件', async () => {
  const srv = createGlassesServer({ stt: fakeStt, agent: fakeAgent, tts: new NoopTts(), token: 't', ttlMs: 5000 })
  expect(await chat(srv)).not.toContain('"type":"tts"')
})

test('GET /tts/:id 复用 Bearer 鉴权并回吐 mp3', async () => {
  const tts = {
    name: 'edge' as const,
    synthesize: async () => ({ audio: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg' }),
  }
  const srv = createGlassesServer({ stt: fakeStt, agent: fakeAgent, tts, token: 't', ttlMs: 5000 })
  const txt = await chat(srv)
  const url = JSON.parse(txt.split('\n').find(line => line.includes('"type":"tts"'))!.slice(6)).url

  const denied = await srv.handleChat(new Request('http://x' + url))
  expect(denied.status).toBe(401)
  const ok = await srv.handleChat(new Request('http://x' + url, { headers: { authorization: 'Bearer t' } }))
  expect(ok.status).toBe(200)
  expect(ok.headers.get('content-type')).toBe('audio/mpeg')
  expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([1, 2, 3])
})

test('TTS 音频 LRU 只保留最近 5 轮', async () => {
  let n = 0
  const tts = {
    name: 'edge' as const,
    synthesize: async () => ({ audio: new Uint8Array([++n]), mime: 'audio/mpeg' }),
  }
  const srv = createGlassesServer({ stt: fakeStt, agent: fakeAgent, tts, token: 't', ttlMs: 5000 })
  const urls: string[] = []
  for (let i = 0; i < 5; i++) {
    const txt = await chat(srv)
    urls.push(JSON.parse(txt.split('\n').find(line => line.includes('"type":"tts"'))!.slice(6)).url)
  }
  const auth = { authorization: 'Bearer t' }
  // 读取第 1 轮把它提升为最近使用，再加入第 6 轮；应淘汰原本第 2 轮而非第 1 轮。
  expect((await srv.handleChat(new Request('http://x' + urls[0], { headers: auth }))).status).toBe(200)
  const sixth = await chat(srv)
  urls.push(JSON.parse(sixth.split('\n').find(line => line.includes('"type":"tts"'))!.slice(6)).url)
  expect((await srv.handleChat(new Request('http://x' + urls[1], { headers: auth }))).status).toBe(404)
  expect((await srv.handleChat(new Request('http://x' + urls[0], { headers: auth }))).status).toBe(200)
  const latest = await srv.handleChat(new Request('http://x' + urls[5], { headers: auth }))
  expect(latest.status).toBe(200)
  expect([...new Uint8Array(await latest.arrayBuffer())]).toEqual([6])
})
