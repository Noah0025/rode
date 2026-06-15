// Tailscale Funnel 公网入口适配器（默认实现）。
// 注意：Funnel 免费层，ToS 禁作生产网关，量大可能限流——见 README 风险说明。

import type { ExposeProvider } from './types'

type Runner = (argv: string[]) => Promise<string>

const defaultRun: Runner = async (argv) => {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out
}

export class TailscaleExpose implements ExposeProvider {
  private publicUrl: string | null = null
  constructor(private opts: { bin?: string; run?: Runner } = {}) {}

  private get bin() { return this.opts.bin ?? 'tailscale' }
  private get run() { return this.opts.run ?? defaultRun }

  async install(): Promise<void> {
    // 仅探活；登录/funnel 授权由用户在 SETUP 完成（交互式，不在此自动做）
    await this.run([this.bin, 'version'])
  }

  async start(localPort: number): Promise<string> {
    await this.run([this.bin, 'funnel', '--bg', String(localPort)])
    const status = await this.run([this.bin, 'funnel', 'status'])
    const m = status.match(/https:\/\/[^\s]+\.ts\.net/)
    this.publicUrl = m ? m[0] : null
    if (!this.publicUrl) throw new Error('无法从 funnel status 解析 PUBLIC_URL')
    return this.publicUrl
  }

  url(): string | null { return this.publicUrl }

  async healthcheck(): Promise<boolean> {
    try { return (await this.run([this.bin, 'funnel', 'status'])).includes('Funnel on') }
    catch { return false }
  }
}
