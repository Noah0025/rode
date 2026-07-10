// 分句流式 TTS 管线：答案 token 流边到边切句、边合成、按序吐音频段。
// 治「长回答语音滞后文字好几拍」：旧实现等整段答案完成才合成一次（首包延迟 ∝ 全文长度），
// 现在第一句凑齐即开合成，首段音频在流早期就绪。

import type { TtsEngine, TtsResult } from './tts'

/** 句边界字符（中英）。省略号/连续标点由「贪吃到非边界字符为止」自然并入前句。 */
const BOUNDARY = /[。！？!?；;\n]/
/** 句长下限：短于此不切（避免「好。」这类碎句一段一响）。 */
const MIN_SENTENCE = 6

/** 有状态分句器：push 喂增量文本、返回本次凑齐的完整句；flush 吐流末残句。 */
export class SentenceFeeder {
  private buf = ''

  push(chunk: string): string[] {
    this.buf += chunk
    const out: string[] = []
    for (;;) {
      const idx = this.findCut()
      if (idx < 0) break
      out.push(this.buf.slice(0, idx + 1).trim())
      this.buf = this.buf.slice(idx + 1)
    }
    return out.filter((s) => s.length > 0)
  }

  flush(): string | undefined {
    const rest = this.buf.trim()
    this.buf = ''
    return rest.length > 0 ? rest : undefined
  }

  /** 找第一个可切位置：边界字符 + 已达句长下限；连续边界（如「……」「！！」）并入同一句。 */
  private findCut(): number {
    for (let i = 0; i < this.buf.length; i++) {
      if (!BOUNDARY.test(this.buf[i])) continue
      if (i + 1 < MIN_SENTENCE) continue // 句太短，继续攒
      // 贪吃后续连续边界字符（省略号/多叹号），切点落在最后一个
      let j = i
      while (j + 1 < this.buf.length && BOUNDARY.test(this.buf[j + 1])) j++
      // 若边界串顶到 buf 末尾，可能还有同类字符在下个 chunk——等下一次 push 再切
      if (j === this.buf.length - 1) return -1
      return j
    }
    return -1
  }
}

export type SegmentSink = (seq: number, result: TtsResult) => void

/**
 * 按序合成管线：句子按提交顺序编号，最多 concurrency 路并发合成，
 * 但 onSegment 严格按 seq 升序回调（后完成的先到也压着等）。
 * 单句失败：跳过该 seq、记 onError，不阻塞后续。
 */
export class SentenceSynthPipeline {
  private nextSeq = 0
  private emitSeq = 0
  private pending = new Map<number, TtsResult | 'failed'>()
  private inflight = 0
  private queue: Array<{ seq: number; text: string }> = []
  private idleResolvers: Array<() => void> = []

  constructor(
    private engine: TtsEngine,
    private onSegment: SegmentSink,
    private opts: { concurrency?: number; onError?: (seq: number, err: unknown) => void } = {},
  ) {}

  submit(text: string): void {
    this.queue.push({ seq: this.nextSeq++, text })
    this.pump()
  }

  /** 全部已提交句子处理完（成功或失败均算完）后 resolve。 */
  async drain(): Promise<void> {
    if (this.queue.length === 0 && this.inflight === 0) return
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve))
  }

  get submitted(): number { return this.nextSeq }

  private pump(): void {
    const cap = this.opts.concurrency ?? 2
    while (this.inflight < cap && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.inflight++
      this.engine
        .synthesize(job.text)
        .then((result) => {
          if (result.audio.byteLength === 0) throw new Error('TTS 输出为空')
          this.pending.set(job.seq, result)
        })
        .catch((err) => {
          this.pending.set(job.seq, 'failed')
          this.opts.onError?.(job.seq, err)
        })
        .finally(() => {
          this.inflight--
          this.emitReady()
          this.pump()
          if (this.queue.length === 0 && this.inflight === 0) {
            const rs = this.idleResolvers.splice(0)
            for (const r of rs) r()
          }
        })
    }
  }

  /** 按 seq 升序吐段；failed 的 seq 静默跳过（app 按到达顺序播，无需连续编号）。 */
  private emitReady(): void {
    while (this.pending.has(this.emitSeq)) {
      const item = this.pending.get(this.emitSeq)!
      this.pending.delete(this.emitSeq)
      if (item !== 'failed') this.onSegment(this.emitSeq, item)
      this.emitSeq++
    }
  }
}
