// 可插拔语音转文字引擎：whisper.cpp 本地（默认，免 key+隐私）/ OpenAI 兼容云端（兜底）。

import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export interface SttEngine {
  readonly name: 'whispercpp' | 'whisperserver' | 'openai'
  /** 把一段音频字节转成文字。mime 形如 'audio/wav'。 */
  transcribe(audio: Uint8Array, mime: string): Promise<string>
}

export type SttEnv = {
  RODE_STT_ENGINE?: string
  OPENAI_API_KEY?: string
  /** OpenAI 兼容 STT 的 base URL（不写死厂商；默认 OpenAI，可换 NVIDIA NIM 等兼容端点）。 */
  RODE_STT_CLOUD_BASE?: string
  /** 云端 STT 模型名（默认 whisper-1）。 */
  RODE_STT_CLOUD_MODEL?: string
  RODE_WHISPER_BIN?: string
  RODE_WHISPER_MODEL?: string
  RODE_WHISPER_LANG?: string
  /** whisper-server 常驻端点（engine=whisperserver 时用；模型预载，免每轮重载）。 */
  RODE_WHISPER_SERVER_URL?: string
}

export function createStt(env: SttEnv): SttEngine {
  const which = (env.RODE_STT_ENGINE ?? 'whispercpp').trim()
  if (which === 'openai' || which === 'cloud') {
    if (!env.OPENAI_API_KEY) throw new Error('STT engine=cloud 需要 OPENAI_API_KEY（或兼容端点的 key）')
    return new OpenAiWhisperStt(env.OPENAI_API_KEY, {
      baseUrl: env.RODE_STT_CLOUD_BASE ?? 'https://api.openai.com/v1',
      model: env.RODE_STT_CLOUD_MODEL ?? 'whisper-1',
    })
  }
  if (which === 'whisperserver' || which === 'server') {
    return new WhisperServerStt({
      url: env.RODE_WHISPER_SERVER_URL ?? 'http://127.0.0.1:18791/inference',
      lang: env.RODE_WHISPER_LANG ?? 'zh',
    })
  }
  return new WhisperCppStt({
    bin: env.RODE_WHISPER_BIN ?? 'whisper-cli',
    model: env.RODE_WHISPER_MODEL ?? 'models/ggml-large-v3.bin',
    lang: env.RODE_WHISPER_LANG ?? 'zh',
  })
}

/** 默认 runner：把音频写临时 wav，跑 whisper-cli，读回 txt。可注入以便测试。 */
type WhisperRunner = (argv: string[]) => Promise<string>

export class WhisperCppStt implements SttEngine {
  readonly name = 'whispercpp' as const
  constructor(
    private cfg: { bin: string; model: string; lang: string },
    private run: WhisperRunner = defaultWhisperRunner,
  ) {}

  async transcribe(audio: Uint8Array, _mime: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'rode-stt-'))
    const wav = join(dir, 'in.wav')
    const ofBase = join(dir, 'out')
    try {
      await Bun.write(wav, audio)
      const out = await this.run([
        this.cfg.bin,
        '-m', this.cfg.model,
        '-l', this.cfg.lang,
        '-nt',            // no timestamps
        '-otxt',
        '-of', ofBase,
        wav,
      ])
      // 默认 runner 返回 txt 内容；若 runner 自己不读文件，回退读 <ofBase>.txt
      const text = out || readFileSync(`${ofBase}.txt`, 'utf8')
      return text.trim()
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }
}

const defaultWhisperRunner: WhisperRunner = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`whisper-cli exit ${code}: ${err.slice(0, 200)}`)
  }
  // -of 写到 <of>.txt；让调用方读文件，这里返回空串触发回退读取
  return ''
}

/** whisper.cpp 常驻 server：POST multipart 到 /inference，模型一直在内存，~1s 出文字。 */
// 繁体→简体：whisper 的中文常出繁体，统一转简体。opencc-js 懒加载，缺失/出错则原样返回。
let _t2s: ((s: string) => string) | null | undefined
async function toSimplified(s: string): Promise<string> {
  if (!s) return s
  if (_t2s === undefined) {
    try {
      const OpenCC = (await import('opencc-js')) as { Converter: (o: { from: string; to: string }) => (s: string) => string }
      _t2s = OpenCC.Converter({ from: 'tw', to: 'cn' })
    } catch { _t2s = null }
  }
  try { return _t2s ? _t2s(s) : s } catch { return s }
}

// 半角→全角标点：whisper 中文里常混半角(逗号/句号/问号…)。仅当标点紧邻 CJK 才转，英文句中的标点不动。
const _HALF2FULL: Record<string, string> = { ',': '，', '.': '。', '?': '？', '!': '！', ':': '：', ';': '；' }
function isCjk(ch: string | undefined): boolean {
  if (!ch) return false
  const c = ch.codePointAt(0) ?? 0
  return (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x303f)
}
export function normalizeCjkPunct(s: string): string {
  if (!s) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const full = _HALF2FULL[ch]
    // 紧邻中文才转，避免误伤 "3.5"、"a.m." 这类英文/数字语境
    if (full && (isCjk(s[i - 1]) || isCjk(s[i + 1]))) { out += full; continue }
    out += ch
  }
  return out
}

export class WhisperServerStt implements SttEngine {
  readonly name = 'whisperserver' as const
  constructor(
    private cfg: { url: string; lang: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async transcribe(audio: Uint8Array, mime: string): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([audio], { type: mime || 'audio/wav' }), 'audio.wav')
    form.append('response_format', 'json')
    form.append('language', this.cfg.lang) // 'auto' 让 whisper 自动判语种(中/英/德);否则固定该语种
    const res = await this.fetchImpl(this.cfg.url, { method: 'POST', body: form })
    if (!res.ok) throw new Error('whisper-server HTTP ' + res.status)
    const txt = await res.text()
    // server 按 response_format=json 返回 {"text":"…"}；解析失败则按纯文本兜底
    let out: string
    try { out = ((JSON.parse(txt) as { text?: string }).text ?? '').trim() }
    catch { out = txt.trim() }
    return normalizeCjkPunct(await toSimplified(out)) // 中文统一简体+全角标点；英德等不受影响
  }
}

export type CloudSttOpts = { baseUrl: string; model: string }

export class OpenAiWhisperStt implements SttEngine {
  readonly name = 'openai' as const
  constructor(
    private apiKey: string,
    private opts: CloudSttOpts = { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async transcribe(audio: Uint8Array, mime: string): Promise<string> {
    const ext = mime.includes('wav') ? 'wav' : 'bin'
    const form = new FormData()
    form.append('file', new Blob([audio], { type: mime }), `audio.${ext}`)
    form.append('model', this.opts.model)
    form.append('language', 'zh')
    const res = await this.fetchImpl(`${this.opts.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    })
    if (!res.ok) throw new Error('whisper API HTTP ' + res.status)
    const json = (await res.json()) as { text?: string }
    return (json.text ?? '').trim()
  }
}
