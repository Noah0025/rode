// 默认大脑适配器：Claude（经 Claude Code + Claude Agent SDK 独立驱动，非 channel/MCP 注入）。
// rode 是宿主，把 Claude Code 当引擎：每轮 query() 跑一个完整 agentic 回合（带 ~/.claude 的
// 技能/记忆/工具），用 resume:<sessionId> 续多轮上下文。无人值守 bypassPermissions。

import { readFileSync, writeFileSync } from 'fs'
import type { Agent, AgentCtx } from './types'

// 抽象 SDK 的 query（便于测试注入，运行时用真 SDK）
export type SdkTextBlock = { type: string; text?: string }
export type SdkStreamEvent = { type?: string; delta?: { type?: string; text?: string } }
export type SdkMessage =
  | { type: 'assistant'; session_id?: string; message?: { content?: SdkTextBlock[]; model?: string } }
  | { type: 'stream_event'; session_id?: string; event?: SdkStreamEvent } // token 级 partial(includePartialMessages)
  | { type: 'result'; subtype?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown }
export type SdkQuery = (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>

export type ClaudeCodeOpts = {
  /** Claude Code 运行目录（影响 project CLAUDE.md/会话搜索；~/.claude 全局记忆/技能不受其限）。 */
  cwd?: string
  /** 可选模型 id；不设则用 SDK/settings 默认。 */
  model?: string
  /** 追加到 claude_code 预设系统提示后的 persona/约束（如 Rode 口吻：简短/口语/不 markdown/少网搜）。 */
  systemPromptAppend?: string
  /** 限制单轮 agentic 回合数（控延迟，语音场景宜小）；不设则 SDK 默认。 */
  maxTurns?: number
  /** 持久化 sessionId 的文件；设了则跨进程重启续多轮（否则仅进程内，重启即断上下文）。 */
  sessionFile?: string
  /** 注入用的 query（测试用）；默认动态 import 真 SDK。 */
  query?: SdkQuery
}

export class ClaudeCodeAgent implements Agent {
  private sessionId: string | undefined
  private lastModel: string | undefined
  private runQuery: SdkQuery
  constructor(private opts: ClaudeCodeOpts = {}) {
    this.runQuery = opts.query ?? defaultQuery
    // 启动时从盘上恢复上次的 sessionId，让重启不丢多轮上下文
    if (opts.sessionFile) {
      try { this.sessionId = readFileSync(opts.sessionFile, 'utf8').trim() || undefined } catch {}
    }
  }

  /** SDK 上一轮实际用的模型 id（如 claude-sonnet-4-5）；未跑过则 undefined。 */
  currentModel(): string | undefined { return this.lastModel }

  private setSession(id: string | undefined) {
    if (id === this.sessionId) return
    this.sessionId = id
    if (this.opts.sessionFile) {
      try { writeFileSync(this.opts.sessionFile, id ?? '') } catch {}
    }
  }

  async *ask(text: string, ctx: AgentCtx): AsyncIterable<string> {
    const prompt = ctx.imagePath
      ? `${text}\n[用户眼前画面在图片：${ctx.imagePath}，需要时用 Read 工具看]`
      : text
    // 流式后只有"还没吐过字"才能安全清 session 重来——否则重试会把半截答案重复吐一遍。
    let yielded = false
    try {
      for await (const chunk of this.runOnce(prompt)) { yielded = true; yield chunk }
    } catch (err) {
      // resume 的 session 可能已失效（重启后 SDK 清了/找不到）→ 清掉 sessionId 重来一轮：
      // 丢这条线程的旧上下文，但不至于把助手永久卡死在 resume 失败上。
      // 仅当本轮一个字都没吐过时才兜底重试（已吐字则直接抛，避免重复输出）。
      if (this.sessionId && !yielded) {
        this.setSession(undefined)
        yield* this.runOnce(prompt)
      } else {
        throw err
      }
    }
  }

  // 跑一个完整 agentic 回合，每个 text block 一到就逐块 yield（流式）。
  // 第一块 yield 之前抛出 → 上层可安全清 session 重试（还没吐过字）。
  private async *runOnce(prompt: string): AsyncIterable<string> {
    const options: Record<string, unknown> = {
      cwd: this.opts.cwd ?? process.cwd(),
      permissionMode: 'bypassPermissions', // 无人值守，工具自动通过
      includePartialMessages: true,        // 开 token 级 partial(stream_event),实现逐字流式
      env: { ...process.env },             // SDK 的 env 是替换不是合并，必须 spread
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.maxTurns ? { maxTurns: this.opts.maxTurns } : {}),
      // append 到 claude_code 预设：保留 agentic 能力,但叠加 Rode 口吻/约束
      ...(this.opts.systemPromptAppend
        ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: this.opts.systemPromptAppend } }
        : {}),
      ...(this.sessionId ? { resume: this.sessionId } : {}), // 第二轮起续上次会话
    }
    // 开了 partial 后:token 增量走 stream_event;完整 assistant 文本是同一内容的重复,需跳过(去重)。
    // 没 partial 流(非流式 SDK/测试)时回退到用 assistant 的 text block,保证仍有输出。
    let streamedAny = false
    for await (const msg of this.runQuery({ prompt, options })) {
      if (msg.type === 'stream_event') {
        const sm = msg as Extract<SdkMessage, { type: 'stream_event' }>
        if (sm.session_id) this.setSession(sm.session_id)
        const ev = sm.event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          streamedAny = true
          yield ev.delta.text // 逐 token 吐
        }
      } else if (msg.type === 'assistant') {
        const m = msg as Extract<SdkMessage, { type: 'assistant' }>
        if (m.session_id) this.setSession(m.session_id)
        if (m.message?.model) this.lastModel = m.message.model // model 从完整 assistant 取
        if (!streamedAny) {
          for (const block of m.message?.content ?? []) {
            if (block.type === 'text' && block.text) yield block.text // 回退:逐 block
          }
        }
      }
    }
  }
}

// 真 SDK：动态 import，避免测试环境必须装 SDK
async function* defaultQuery(params: { prompt: string; options: Record<string, unknown> }): AsyncIterable<SdkMessage> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  for await (const m of query(params as never) as AsyncIterable<SdkMessage>) yield m
}
