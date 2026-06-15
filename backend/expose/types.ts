// 公网入口可插拔抽象：把本地端口暴露成一个可达的 PUBLIC_URL。
// 默认实现 Tailscale Funnel；可换 cloudflared / ngrok / frp（各实现此接口）。

export interface ExposeProvider {
  /** 确保 CLI 装好/登录（幂等）。 */
  install(): Promise<void>
  /** 暴露本地端口，返回公网 URL。 */
  start(localPort: number): Promise<string>
  /** 当前公网 URL（未 start 则 null）。 */
  url(): string | null
  /** 暴露是否健康。 */
  healthcheck(): Promise<boolean>
}
