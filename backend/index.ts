#!/usr/bin/env bun
/**
 * rode 后端入口 —— 独立 agent 应用（非 Claude Code 的 channel）。
 * 组装：STT + ClaudeCodeAgent(经 Claude Agent SDK 驱动) + glasses-server，暴露 HTTP /glasses/chat。
 * rode 是宿主，把 Claude Code 当引擎调用；大脑可换=换 Agent 实现。独立 `bun backend/index.ts` 即可跑。
 */

import { readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { loadConfig } from './config'
import { createStt } from './stt'
import { prettyModelId } from './usage'
import { createGlassesServer } from './glasses-server'
import { ClaudeCodeAgent } from './agent/claude-code'
import { RateLimiter } from './security'

// ─── env：先读 RODE_STATE_DIR(默认 cwd) 下的 .env（真实 env 优先），再 loadConfig ──────
const STATE_DIR = process.env.RODE_STATE_DIR ?? process.cwd()
try {
  for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const cfg = loadConfig(process.env)

// Rode persona：语音助手必须简短/口语/不 markdown/默认别深网搜（快答短答）。可用 RODE_PERSONA 覆盖。
const RODE_PERSONA = process.env.RODE_PERSONA ??
  '你是 Rode，戴在 Rokid 眼镜上的语音助手。自称一律用「Rode」，不要译成中文名（不要叫罗德）。回答必须遵守：' +
  '1)极简短、口语化、像说话，适合朗读；' +
  '2)纯文本，绝不用 markdown、链接、列表、表格、代码块；中文用简体，中文标点一律全角（，。？！：；），不要半角全角混用；' +
  '3)需要实时或外部信息(天气/新闻/查事实/算东西)就直接联网查到再简短答,别让用户去别处确认、别反问能不能查;只有真正危险不可逆的操作(删改文件/对外发消息/push/装卸软件)才拒绝并口头说明;' +
  '4)不确定就一句话说不确定,别长篇。'

// 默认大脑：Claude，经 Claude Code via Agent SDK 驱动（多轮 resume 续上下文，bypassPermissions 无人值守）
const agent = new ClaudeCodeAgent({
  cwd: process.env.RODE_AGENT_CWD ?? STATE_DIR,
  model: process.env.RODE_MODEL || undefined,
  systemPromptAppend: RODE_PERSONA,
  maxTurns: Number(process.env.RODE_MAX_TURNS ?? '12'),
  sessionFile: join(STATE_DIR, 'session-id'), // 落盘 sessionId，重启不丢多轮上下文
})

const stt = createStt(process.env)
const glasses = createGlassesServer({
  stt,
  agent,
  token: cfg.token,
  ttlMs: cfg.ttlMs,
  bodyLimit: Number(process.env.RODE_BODY_LIMIT ?? 26_214_400), // 25MB
  // 状态栏只显示真实模型（5h/7d 订阅限额 headless SDK 拿不到，不再显示冻结假值）
  getMeta: () => {
    const id = agent.currentModel()
    return id ? { model: prettyModelId(id, 'Claude'), usage5h: '', usage7d: '' } : undefined
  },
  saveImage: async (turnId, bytes) => {
    const inboxDir = join(STATE_DIR, 'inbox')
    try { mkdirSync(inboxDir, { recursive: true }) } catch {}
    const dest = join(inboxDir, `${turnId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`)
    await Bun.write(dest, bytes)
    return dest
  },
})

const rl = new RateLimiter({ max: Number(process.env.RODE_RATE_MAX ?? 30), windowMs: 60000 })
Bun.serve({
  port: cfg.port,
  idleTimeout: 0, // 关掉 Bun 默认 10s 空闲超时——SSE 思考期(SDK 冷启/网搜可 >10s)连接会被误杀;由 glasses-server ttlMs + 眼镜端超时治理
  fetch: (req: Request, server) => {
    const path = new URL(req.url).pathname
    if (path === '/') return new Response('rode ok')
    if (path.startsWith('/glasses/')) {
      const ip = server.requestIP(req)?.address ?? 'unknown'
      if (!rl.allow(ip)) return new Response('too many requests', { status: 429 })
      return glasses.handleChat(req)
    }
    return new Response('not found', { status: 404 })
  },
})
process.stderr.write(`rode backend: HTTP on :${cfg.port}（独立 agent, 大脑=Claude Agent SDK）\n`)
