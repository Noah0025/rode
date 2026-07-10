import { describe, expect, test } from 'bun:test'
import { SentenceFeeder, SentenceSynthPipeline } from './tts-stream'
import type { TtsEngine, TtsResult } from './tts'

describe('SentenceFeeder', () => {
  test('基本切句：句号边界+跨 chunk 累积', () => {
    const f = new SentenceFeeder()
    expect(f.push('今天天气')).toEqual([])
    expect(f.push('很好。我们出去')).toEqual(['今天天气很好。'])
    expect(f.push('玩吧！好')).toEqual(['我们出去玩吧！'])
    expect(f.flush()).toBe('好')
  })

  test('短句不切（长度下限）', () => {
    const f = new SentenceFeeder()
    expect(f.push('好。')).toEqual([]) // 太短，攒着
    expect(f.push('那就这么定了。收工')).toEqual(['好。那就这么定了。'])
    expect(f.flush()).toBe('收工')
  })

  test('省略号/连续标点并入同句，不在边界串中间切', () => {
    const f = new SentenceFeeder()
    expect(f.push('让我想想。。')).toEqual([]) // 边界串顶到末尾，等下个 chunk
    expect(f.push('。然后呢？行')).toEqual(['让我想想。。。']) // 「然后呢？」仅4字低于下限，继续攒
    expect(f.flush()).toBe('然后呢？行')
  })

  test('中英混排与英文标点', () => {
    const f = new SentenceFeeder()
    const out = f.push('Claude Code is great! 它比 Cursor 更 agentic。完')
    expect(out).toEqual(['Claude Code is great!', '它比 Cursor 更 agentic。'])
    expect(f.flush()).toBe('完')
  })

  test('无标点长串只在 flush 吐', () => {
    const f = new SentenceFeeder()
    expect(f.push('一二三四五六七八九十'.repeat(3))).toEqual([])
    expect(f.flush()).toBe('一二三四五六七八九十'.repeat(3))
  })

  test('换行也是边界', () => {
    const f = new SentenceFeeder()
    expect(f.push('第一点内容\n第二点更多')).toEqual(['第一点内容'])
    expect(f.flush()).toBe('第二点更多')
  })
})

function fakeEngine(behavior: (text: string) => Promise<TtsResult>): TtsEngine {
  return { name: 'fake', synthesize: behavior }
}
const audio = (tag: string): TtsResult => ({ audio: new TextEncoder().encode(tag), mime: 'audio/mpeg' })

describe('SentenceSynthPipeline', () => {
  test('并发下仍按 seq 升序吐段（后交先成也压序）', async () => {
    const resolvers = new Map<string, (r: TtsResult) => void>()
    const engine = fakeEngine((t) => new Promise((res) => resolvers.set(t, res)))
    const got: number[] = []
    const p = new SentenceSynthPipeline(engine, (seq) => got.push(seq), { concurrency: 2 })
    p.submit('句零')
    p.submit('句一')
    resolvers.get('句一')!(audio('b')) // 后一句先合成完
    await Bun.sleep(5)
    expect(got).toEqual([]) // 压着等句零
    resolvers.get('句零')!(audio('a'))
    await p.drain()
    expect(got).toEqual([0, 1])
  })

  test('单句失败跳过不阻塞后续', async () => {
    const engine = fakeEngine(async (t) => {
      if (t === '坏句') throw new Error('boom')
      return audio(t)
    })
    const got: number[] = []
    const errs: number[] = []
    const p = new SentenceSynthPipeline(engine, (seq) => got.push(seq), {
      concurrency: 1,
      onError: (seq) => errs.push(seq),
    })
    p.submit('好句A')
    p.submit('坏句')
    p.submit('好句B')
    await p.drain()
    expect(got).toEqual([0, 2])
    expect(errs).toEqual([1])
  })

  test('空音频视为失败', async () => {
    const engine = fakeEngine(async () => ({ audio: new Uint8Array(0), mime: 'audio/mpeg' }))
    const got: number[] = []
    const errs: number[] = []
    const p = new SentenceSynthPipeline(engine, (seq) => got.push(seq), { onError: (s) => errs.push(s) })
    p.submit('任意')
    await p.drain()
    expect(got).toEqual([])
    expect(errs).toEqual([0])
  })

  test('drain 等待全部在飞任务', async () => {
    const engine = fakeEngine(async (t) => { await Bun.sleep(10); return audio(t) })
    const got: number[] = []
    const p = new SentenceSynthPipeline(engine, (seq) => got.push(seq), { concurrency: 2 })
    for (let i = 0; i < 5; i++) p.submit(`句${i}`)
    await p.drain()
    expect(got).toEqual([0, 1, 2, 3, 4])
  })
})
