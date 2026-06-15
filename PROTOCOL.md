# rode 眼镜 ↔ 后端 协议契约

> 这是 rode 的**唯一接口**。任何后端实现（任何 AI 大脑、任何语言）只要满足本契约，就能驱动 rode 眼镜 app。眼镜 app 不关心后端怎么实现。

## 入站：POST /glasses/chat

眼镜录一段话后，POST 一个 multipart 请求到后端：

```
POST /glasses/chat
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `audio` | ✅ | 一段录音，**16kHz 单声道 WAV** |
| `image` | ⬜ | 可选，眼镜摄像头当前画面，JPEG（用户问"看看这个"时随音频带上）|

**鉴权**：`token` 不匹配 → 必须返回 `401`。token 为每台后端随机生成的绑定凭证（见 SETUP）。

## 出站：SSE 事件流

成功请求返回 `Content-Type: text/event-stream`，每个事件一行：

```
data: <JSON>\n\n
```

`<JSON>` 的 `type` 字段决定事件类型：

| type | 字段 | 含义 | 眼镜行为 |
|------|------|------|----------|
| `user` | `text` | STT 转写出的用户原话 | 回显"用户说的" |
| `status` | `text` | 处理中状态（如 `"思考中"`）| HUD 显状态 |
| `answer` | `text` | 大脑的回答 | 显示 + 朗读（若有 TTS）|
| `done` | — | 本轮结束 | 连接关闭，回 IDLE |
| `error` | `text` | 出错提示 | 显示错误，回 IDLE |
| `meta` | `model`, `usage5h`, `usage7d` | 可选状态栏元信息 | 状态栏显示 |

### 时序约定
1. 连接建立后，后端**先发** `user`（回显转写）+ `status`（"思考中"）
2. 处理期间连接**保持打开**（眼镜 HUD 一直显"思考中"）
3. 大脑出结果 → 发 `answer` → 紧接 `done` → **关闭连接**
4. **一轮一答**：一次请求对应一个 `answer` + `done`，然后连接关闭。下一句话是新的一次 POST。
5. 出错（STT 失败/大脑超时）→ 发 `error` + `done`（HTTP 仍 200，错误在事件里）

### 事件 JSON 示例
```
data: {"type":"user","text":"今天天气怎么样"}

data: {"type":"status","text":"思考中"}

data: {"type":"meta","model":"Sonnet 4.6","usage5h":"29%","usage7d":"3%"}

data: {"type":"answer","text":"柏林今天阴天，最高22度，出门带件外套。"}

data: {"type":"done"}

```

## 最小自测（curl）
```bash
# 用一段中文 16k wav 测整条链路
say -v Tingting -o /tmp/t.aiff "今天天气怎么样" && afconvert /tmp/t.aiff -f WAVE -d LEI16@16000 -c 1 /tmp/t.wav
curl -N -H "Authorization: Bearer $TOKEN" -F audio=@/tmp/t.wav https://<your-backend>/glasses/chat
# 期望依次收到 user / status / (meta) / answer / done 事件
# 无 token → 期望 401
```

## 实现者须知
- 后端唯一硬约束就是上面这些。STT 引擎、AI 大脑、公网入口都可自选（参考实现用 whisper.cpp + 任意 Agent + Tailscale，见 backend/ 与 SETUP.md）。
- 大脑接入只需实现 `Agent.ask(text, ctx) -> AsyncIterable<string>`（见 `backend/agent/types.ts`），不暴露任何具体大脑细节。
- 眼镜 app 的 `URL` 与 `token` 由 setup 经 adb 写入（见 SETUP.md），app 内无配对界面。
