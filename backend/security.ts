// 安全工具：限流 / body 大小限制 / 日志脱敏。公网暴露自有后端必备。

/** 内存滑动窗口限流，按 key（如 IP）。 */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(private opts: { max: number; windowMs: number }) {}
  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.opts.windowMs
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff)
    if (arr.length >= this.opts.max) { this.hits.set(key, arr); return false }
    arr.push(now); this.hits.set(key, arr); return true
  }
}

/** body 是否在上限内。 */
export function withinBodyLimit(size: number, limit: number): boolean {
  return size <= limit
}

/** 日志脱敏：抹掉 Bearer token / 长十六进制串。 */
export function redact(s: string): string {
  return s
    .replace(/Bearer\s+[\w.-]+/gi, 'Bearer ***')
    .replace(/\b[0-9a-f]{24,}\b/gi, '***')
}
