// 眼镜 HTTP 入口：POST /glasses/chat（multipart 音频）→ STT → Agent.ask → SSE 回文本。
// "等大脑回答"的 pending/deliver 逻辑下放到 Agent 适配器；
// 本文件只管 HTTP/SSE/STT 编排，大脑无关，无 channel/MCP 耦合。

import type { SttEngine } from './stt'
import { normalizeCjkPunct } from './stt'
import type { Agent } from './agent/types'
import type { GlassesEvent, GlassesMeta } from './protocol'
import { glassesEvent, encodeEvent, genTurnId } from './protocol'
import { redact } from './security'

export type GlassesServerOpts = {
  stt: SttEngine
  agent: Agent
  token: string
  ttlMs: number
  /** 可选：请求体上限（字节），超过回 413。 */
  bodyLimit?: number
  /** 可选：保存入站图片，返回落盘路径。 */
  saveImage?: (turnId: string, bytes: Uint8Array) => Promise<string>
  /** 可选：每轮随 SSE 下发状态栏元信息。 */
  getMeta?: () => GlassesMeta | undefined
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
}

function sseOnce(ev: GlassesEvent): Response {
  return new Response(glassesEvent(ev) + glassesEvent({ type: 'done' }), { status: 200, headers: SSE_HEADERS })
}

export function createGlassesServer(opts: GlassesServerOpts) {
  async function handleChat(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (req.method !== 'POST' || url.pathname !== '/glasses/chat') return new Response('not found', { status: 404 })
    if (opts.token && req.headers.get('authorization') !== `Bearer ${opts.token}`) {
      return new Response('unauthorized', { status: 401 })
    }
    if (opts.bodyLimit && Number(req.headers.get('content-length') ?? '0') > opts.bodyLimit) {
      return new Response('payload too large', { status: 413 })
    }

    let form: FormData
    try { form = await req.formData() } catch { return new Response('bad multipart', { status: 400 }) }
    const audio = form.get('audio')
    if (!(audio instanceof Blob)) return new Response('missing audio', { status: 400 })
    const bytes = new Uint8Array(await audio.arrayBuffer())

    let text: string
    try { text = (await opts.stt.transcribe(bytes, audio.type || 'audio/wav')).trim() }
    catch (err) {
      process.stderr.write(redact('glasses: STT failed: ' + err) + '\n')
      return sseOnce({ type: 'error', text: '没听清，再说一遍' })
    }
    if (!text) return sseOnce({ type: 'error', text: '没说话' })  // 空转写不进大脑

    const turnId = genTurnId()
    let imagePath: string | undefined
    const image = form.get('image')
    if (image instanceof Blob && opts.saveImage) {
      try { imagePath = await opts.saveImage(turnId, new Uint8Array(await image.arrayBuffer())) }
      catch (err) { process.stderr.write(redact('glasses: image save failed: ' + err) + '\n') }
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enq = (ev: GlassesEvent) => { try { controller.enqueue(encodeEvent(ev)) } catch {} }
        enq({ type: 'user', text })
        enq({ type: 'status', text: '思考中' })
        let metaSent = false
        const sendMeta = () => {
          if (metaSent) return
          const m = opts.getMeta?.()
          if (m) { enq({ type: 'meta', ...m }); metaSent = true }
        }
        sendMeta() // 流开始就发(第2轮起 model 已知,状态栏即时刷)

        let answered = false
        const timer = setTimeout(() => {
          if (!answered) { enq({ type: 'error', text: '超时了' }); enq({ type: 'done' }); try { controller.close() } catch {} }
        }, opts.ttlMs)

        let raw = '' // 原始(未归一)累积,终态统一归一,避免标点跨块边界漏转
        try {
          for await (const chunk of opts.agent.ask(text, { turnId, imagePath })) {
            answered = true
            sendMeta() // 首轮：开头 model 还 undefined,大脑一出声 model 就有了,这里补发,状态栏不再空
            raw += chunk
            enq({ type: 'answer_delta', text: normalizeCjkPunct(chunk) }) // 逐块流式;中文标点统一全角
          }
          // 终态完整答案：眼镜端据此定稿落盘 + TTS（v1 单条 answer 语义保留）
          const full = normalizeCjkPunct(raw).trim()
          if (full) enq({ type: 'answer', text: full })
        } catch (err) {
          process.stderr.write(redact('glasses: agent failed: ' + err) + '\n')
          if (!answered) enq({ type: 'error', text: '出错了' })
        } finally {
          clearTimeout(timer)
          enq({ type: 'done' })
          try { controller.close() } catch {}
        }
      },
    })
    return new Response(stream, { status: 200, headers: SSE_HEADERS })
  }

  return { handleChat }
}
