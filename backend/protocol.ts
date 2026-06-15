export type GlassesMeta = { model: string; usage5h: string; usage7d: string }
export type GlassesEvent =
  | { type: 'user'; text: string }
  | { type: 'status'; text: string }
  | { type: 'answer'; text: string }
  | { type: 'done' }
  | { type: 'error'; text: string }
  | ({ type: 'meta' } & GlassesMeta)
const enc = new TextEncoder()
export function glassesEvent(ev: GlassesEvent): string { return `data: ${JSON.stringify(ev)}\n\n` }
export function encodeEvent(ev: GlassesEvent): Uint8Array { return enc.encode(glassesEvent(ev)) }
export function genTurnId(): string { return 'g:' + crypto.randomUUID() }
