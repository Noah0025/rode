// 可插拔文字转语音引擎：Mac mini 上调用 edge-tts，或显式关闭。

import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export type TtsResult = { audio: Uint8Array; mime: string }

export interface TtsEngine {
  readonly name: 'edge' | 'off'
  synthesize(text: string): Promise<TtsResult>
}

export type TtsEnv = {
  RODE_TTS_ENGINE?: string
  RODE_TTS_VOICE?: string
  RODE_EDGE_TTS_BIN?: string
  /** ffmpeg 路径；"off" 关闭静音裁剪。默认 "ffmpeg"（找不到则该段自动跳过裁剪）。 */
  RODE_TTS_FFMPEG?: string
}

export function createTts(env: TtsEnv): TtsEngine {
  const which = (env.RODE_TTS_ENGINE ?? 'off').trim().toLowerCase()
  if (which === 'off') return new NoopTts()
  if (which === 'edge') {
    const ff = (env.RODE_TTS_FFMPEG ?? 'ffmpeg').trim()
    return new EdgeTts({
      bin: env.RODE_EDGE_TTS_BIN ?? 'edge-tts',
      voice: env.RODE_TTS_VOICE ?? 'zh-CN-XiaoxiaoNeural',
      ffmpeg: ff && ff !== 'off' ? ff : undefined,
    })
  }
  throw new Error(`未知 RODE_TTS_ENGINE=${which}（只支持 edge|off）`)
}

/** 命令执行器可注入，测试无需安装 edge-tts CLI。 */
export type TtsRunner = (argv: string[], timeoutMs: number) => Promise<void>

export class EdgeTts implements TtsEngine {
  readonly name = 'edge' as const

  constructor(
    private cfg: { bin: string; voice: string; ffmpeg?: string },
    private run: TtsRunner = runTtsCommand,
    private timeoutMs = 10_000,
  ) {}

  async synthesize(text: string): Promise<TtsResult> {
    const dir = mkdtempSync(join(tmpdir(), 'rode-tts-'))
    const output = join(dir, 'speech.mp3')
    const trimmed = join(dir, 'trimmed.mp3')
    try {
      await this.run([
        this.cfg.bin,
        '--text', text,
        '--voice', this.cfg.voice,
        '--write-media', output,
      ], this.timeoutMs)
      // 裁掉 edge-tts 每段首尾垫的静音（分句播放时段间断感的主要来源）。
      // areverse 两次实现"裁头又裁尾"；-45dB 阈值保守，保留 50ms 呼吸余量。裁剪失败用原始音频。
      let finalPath = output
      if (this.cfg.ffmpeg) {
        try {
          await this.run([
            this.cfg.ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', output,
            '-af', 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse',
            trimmed,
          ], this.timeoutMs)
          finalPath = trimmed
        } catch { /* ffmpeg 缺失/失败 → 用未裁剪原始音频 */ }
      }
      const file = readFileSync(finalPath)
      if (file.byteLength === 0) throw new Error('edge-tts 输出为空')
      return { audio: new Uint8Array(file), mime: 'audio/mpeg' }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }
}

export const runTtsCommand: TtsRunner = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = Symbol('timed-out')
  const result = await Promise.race([
    proc.exited,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (result === timedOut) {
    try { proc.kill() } catch {}
    throw new Error(`edge-tts timeout after ${timeoutMs}ms`)
  }
  if (result !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`edge-tts exit ${result}: ${err.slice(0, 200)}`)
  }
}

/** engine=off 时由编排层直接跳过；空结果仅用于接口行为保持可预测。 */
export class NoopTts implements TtsEngine {
  readonly name = 'off' as const
  async synthesize(_text: string): Promise<TtsResult> {
    return { audio: new Uint8Array(), mime: 'audio/mpeg' }
  }
}
