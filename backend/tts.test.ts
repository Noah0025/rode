import { test, expect } from 'bun:test'
import { EdgeTts, NoopTts, createTts, runTtsCommand } from './tts'

test('createTts 默认关闭，RODE_TTS_ENGINE=edge 时启用 EdgeTts', () => {
  expect(createTts({}).name).toBe('off')
  expect(createTts({ RODE_TTS_ENGINE: 'off' })).toBeInstanceOf(NoopTts)
  expect(createTts({ RODE_TTS_ENGINE: 'edge', RODE_TTS_VOICE: 'zh-CN-YunxiNeural' }).name).toBe('edge')
})

test('EdgeTts 调用 edge-tts 参数并读回 mp3', async () => {
  const seen: string[][] = []
  const engine = new EdgeTts(
    { bin: 'mock-edge-tts', voice: 'zh-CN-XiaoxiaoNeural' },
    async (argv) => {
      seen.push(argv)
      const output = argv[argv.indexOf('--write-media') + 1]
      await Bun.write(output, new Uint8Array([0x49, 0x44, 0x33]))
    },
  )

  const result = await engine.synthesize('你好')

  expect([...result.audio]).toEqual([0x49, 0x44, 0x33])
  expect(result.mime).toBe('audio/mpeg')
  expect(seen[0]).toContain('mock-edge-tts')
  expect(seen[0].slice(1, 5)).toEqual(['--text', '你好', '--voice', 'zh-CN-XiaoxiaoNeural'])
  expect(seen[0]).toContain('--write-media')
})

test('EdgeTts 进程失败时上抛错误', async () => {
  const engine = new EdgeTts(
    { bin: 'mock-edge-tts', voice: 'zh-CN-XiaoxiaoNeural' },
    async () => { throw new Error('edge-tts exit 2: boom') },
  )
  await expect(engine.synthesize('失败')).rejects.toThrow(/exit 2/)
})

test('edge-tts 命令失败和超时都报错', async () => {
  await expect(runTtsCommand([
    process.execPath, '-e', 'process.stderr.write("boom"); process.exit(7)',
  ], 1000)).rejects.toThrow(/exit 7: boom/)
  await expect(runTtsCommand([
    process.execPath, '-e', 'setTimeout(() => {}, 1000)',
  ], 10)).rejects.toThrow(/timeout after 10ms/)
})

test('NoopTts 不产生音频', async () => {
  const result = await new NoopTts().synthesize('不会合成')
  expect(result.audio.byteLength).toBe(0)
  expect(result.mime).toBe('audio/mpeg')
})
