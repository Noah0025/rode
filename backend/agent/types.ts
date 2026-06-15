// 大脑可插拔抽象：喂文字 + 上下文，流式吐回答片段（可只 yield 一次）。
// 任何 AI 大脑/agent 实现此接口即可接入 rode，不向桥暴露具体大脑细节。

export type AgentCtx = { turnId: string; imagePath?: string }

export interface Agent {
  ask(text: string, ctx: AgentCtx): AsyncIterable<string>
}
