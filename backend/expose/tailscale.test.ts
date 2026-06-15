import { test, expect } from 'bun:test'
import { TailscaleExpose } from './tailscale'

test('start 解析出 funnel 公网 URL', async () => {
  const calls: string[][] = []
  const ts = new TailscaleExpose({ bin: 'tailscale', run: async (a) => {
    calls.push(a)
    if (a.includes('status')) return 'https://node.tailnet.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:18790'
    return ''
  }})
  const url = await ts.start(18790)
  expect(url).toBe('https://node.tailnet.ts.net')
  expect(calls.some(c => c.includes('funnel'))).toBe(true)
})

test('healthcheck 看 Funnel on', async () => {
  const ts = new TailscaleExpose({ run: async () => 'x (Funnel on)' })
  expect(await ts.healthcheck()).toBe(true)
})

test('status 无 URL 时 start 抛错', async () => {
  const ts = new TailscaleExpose({ run: async () => 'nothing here' })
  await expect(ts.start(1)).rejects.toThrow(/PUBLIC_URL/)
})
