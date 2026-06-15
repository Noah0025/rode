// 后端配置：从环境变量读取，强制 token（公网暴露必须鉴权）。

export type RodeConfig = { token: string; port: number; sttEngine: string; ttlMs: number }

export function loadConfig(env: Record<string, string | undefined>): RodeConfig {
  const token = (env.RODE_GLASSES_TOKEN ?? '').trim()
  if (!token) throw new Error('RODE_GLASSES_TOKEN 必填（公网暴露须鉴权）')
  return {
    token,
    port: Number(env.PORT ?? '18790'),
    sttEngine: env.RODE_STT_ENGINE ?? 'whisperserver',
    ttlMs: Number(env.RODE_TTL_MS ?? '120000'),
  }
}
