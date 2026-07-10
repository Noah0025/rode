export type GlassesMeta = { model: string; usage5h: string; usage7d: string }
export type GlassesEvent =
  | { type: 'user'; text: string }
  | { type: 'status'; text: string }
  | { type: 'answer_delta'; text: string } // 流式增量块(逐块吐答案,眼镜端追加同一行)
  | { type: 'answer'; text: string }        // 终态完整答案(落盘/TTS;v1 兼容保留)
  | { type: 'tts'; url: string }            // [废弃,兼容旧端] 整段 mp3；现走 tts_seg 分句流式
  | { type: 'tts_seg'; turnId: string; seq: number; url: string } // 分句音频段，按 seq 升序到达
  | { type: 'tts_end'; turnId: string; total: number }            // 本轮全部段推送完毕
  | { type: 'done' }
  | { type: 'error'; text: string }
  | ({ type: 'meta' } & GlassesMeta)
const enc = new TextEncoder()
export function glassesEvent(ev: GlassesEvent): string { return `data: ${JSON.stringify(ev)}\n\n` }
export function encodeEvent(ev: GlassesEvent): Uint8Array { return enc.encode(glassesEvent(ev)) }
export function genTurnId(): string { return 'g:' + crypto.randomUUID() }
