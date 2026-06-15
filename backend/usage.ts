// 用量提供者：读 rode 会话 statusLine 落盘的真实限额数据（Claude Code 喂给 statusLine
// 的 rate_limits），转成「模型 · 5h% · 7d%」供眼镜状态栏。
// 数据源 = ~/.claude/channels/rode/usage.json，由 rode-settings.json 的 statusLine 脚本写。
// 这是 Max 套餐的真实 5h/7d 限额百分比（非 ccusage 的成本估算）。

import { readFileSync } from 'fs'

export type GlassesMeta = { model: string; usage5h: string; usage7d: string }

/** statusLine 写入的原始结构 */
type UsageFile = {
  model?: string          // display_name，如 "Sonnet 4.6" 或 "Claude Sonnet 4.6"
  five_pct?: number | null
  week_pct?: number | null
}

/** "Claude Sonnet 4.6" → "Sonnet 4.6"；空则回退。 */
export function prettyModel(displayName: string | undefined, fallback: string): string {
  const s = (displayName || '').replace(/^Claude\s+/i, '').trim()
  return s || fallback
}

/** 模型 id "claude-sonnet-4-5" → "Sonnet 4.5"；认不出回退。 */
export function prettyModelId(id: string | undefined, fallback: string): string {
  const s = (id || '').trim()
  const m = s.match(/(opus|sonnet|haiku|fable)[-_]?(\d+)(?:[-.](\d+))?/i)
  if (!m) return s.replace(/^claude-?/i, '') || fallback
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  return `${name} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`
}

export function formatMeta(j: UsageFile, modelFallback: string): GlassesMeta | undefined {
  if (j.five_pct == null && j.week_pct == null) return undefined
  return {
    model: prettyModel(j.model, modelFallback),
    usage5h: j.five_pct != null ? `${Math.round(j.five_pct)}%` : '—',
    usage7d: j.week_pct != null ? `${Math.round(j.week_pct)}%` : '—',
  }
}

export function createUsageProvider(opts: { usageFile: string; modelFallback: string }) {
  return {
    // 每次现读小文件（statusLine 渲染时刷新它）。文件缺失/未渲染过 → undefined → 状态栏留空。
    get(): GlassesMeta | undefined {
      try {
        return formatMeta(JSON.parse(readFileSync(opts.usageFile, 'utf8')) as UsageFile, opts.modelFallback)
      } catch { return undefined }
    },
    start() {},  // 兼容旧调用；数据由 rode statusLine 写，无需轮询
    stop() {},
  }
}
