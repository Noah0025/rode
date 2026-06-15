import { test, expect } from 'bun:test'
import { RateLimiter, withinBodyLimit, redact } from './security'

test('限流: 超过阈值拒绝', () => {
  const rl = new RateLimiter({ max: 2, windowMs: 1000 })
  expect(rl.allow('ip1')).toBe(true)
  expect(rl.allow('ip1')).toBe(true)
  expect(rl.allow('ip1')).toBe(false)
})

test('限流: 窗口过后恢复', () => {
  const rl = new RateLimiter({ max: 1, windowMs: 1000 })
  expect(rl.allow('ip', 0)).toBe(true)
  expect(rl.allow('ip', 500)).toBe(false)
  expect(rl.allow('ip', 1500)).toBe(true)
})

test('body 限制', () => {
  expect(withinBodyLimit(5_000_000, 10_000_000)).toBe(true)
  expect(withinBodyLimit(20_000_000, 10_000_000)).toBe(false)
})

test('日志脱敏抹掉 token', () => {
  expect(redact('Authorization: Bearer abc123def.token')).toContain('Bearer ***')
  expect(redact('tok=0123456789abcdef0123456789abcdef')).toContain('***')
})
