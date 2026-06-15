import { test, expect } from 'bun:test'
import { createStt, OpenAiWhisperStt, WhisperCppStt } from './stt'

test('createStt 默认返回 whispercpp 引擎', () => {
  const engine = createStt({})
  expect(engine.name).toBe('whispercpp')
})

test('createStt 按 RODE_STT_ENGINE=openai 选 openai 引擎', () => {
  const engine = createStt({ RODE_STT_ENGINE: 'openai', OPENAI_API_KEY: 'sk-test' })
  expect(engine.name).toBe('openai')
})

test('createStt openai 缺 key 时抛错', () => {
  expect(() => createStt({ RODE_STT_ENGINE: 'openai' })).toThrow(/OPENAI_API_KEY/)
})

test('OpenAiWhisperStt 提交 multipart 到 whisper API 并返回 text', async () => {
  const calls: { url: string; auth: string | null; hasFile: boolean }[] = []
  const stubFetch = (async (url: any, init: any) => {
    const fd = init.body as FormData
    calls.push({
      url: String(url),
      auth: init.headers.Authorization ?? null,
      hasFile: fd.has('file'),
    })
    return new Response(JSON.stringify({ text: '你好罗德' }), { status: 200 })
  }) as unknown as typeof fetch

  const engine = new OpenAiWhisperStt('sk-test', undefined, stubFetch)
  const text = await engine.transcribe(new Uint8Array([1, 2, 3]), 'audio/wav')

  expect(text).toBe('你好罗德')
  expect(calls[0].url).toContain('/audio/transcriptions')
  expect(calls[0].auth).toBe('Bearer sk-test')
  expect(calls[0].hasFile).toBe(true)
})

test('OpenAiWhisperStt 非 200 抛错', async () => {
  const stubFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
  const engine = new OpenAiWhisperStt('sk-test', undefined, stubFetch)
  await expect(engine.transcribe(new Uint8Array([1]), 'audio/wav')).rejects.toThrow(/500/)
})

test('WhisperCppStt 调用 runner 并返回去空白的文本', async () => {
  const seen: string[][] = []
  const stubRun = async (argv: string[]) => {
    seen.push(argv)
    return '  导航去西湖  \n'
  }
  const engine = new WhisperCppStt(
    { bin: 'whisper-cli', model: 'm.bin', lang: 'zh' },
    stubRun,
  )
  const text = await engine.transcribe(new Uint8Array([0x52, 0x49]), 'audio/wav')
  expect(text).toBe('导航去西湖')
  expect(seen[0]).toContain('m.bin')
  expect(seen[0]).toContain('zh')
})
