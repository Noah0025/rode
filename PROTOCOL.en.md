# rode Glasses ↔ Backend Protocol Contract
> [中文](PROTOCOL.md) | **English**

> This is rode's **only interface**. Any backend implementation (any AI brain, any language) can drive the rode glasses app as long as it satisfies this contract. The glasses app does not care how the backend is implemented.

## Inbound: POST /glasses/chat

After the glasses record an utterance, they POST a multipart request to the backend:

```
POST /glasses/chat
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

| Field | Required | Description |
|------|------|------|
| `audio` | ✅ | A recording, **16kHz mono WAV** |
| `image` | ⬜ | Optional, the current frame from the glasses camera, JPEG (sent alongside the audio when the user asks "take a look at this") |

**Authentication**: if `token` does not match → must return `401`. The token is a binding credential randomly generated per backend (see SETUP).

## Outbound: SSE event stream

A successful request returns `Content-Type: text/event-stream`, one event per line:

```
data: <JSON>\n\n
```

The `type` field of `<JSON>` determines the event type:

| type | Fields | Meaning | Glasses behavior |
|------|------|------|----------|
| `user` | `text` | The user's original words as transcribed by STT | Echo "what the user said" |
| `status` | `text` | Processing status (e.g. `"思考中"`) | HUD shows status |
| `answer` | `text` | The brain's answer | Display + read aloud (if TTS available) |
| `done` | — | This turn is over | Connection closes, return to IDLE |
| `error` | `text` | Error message | Display the error, return to IDLE |
| `meta` | `model`, `usage5h`, `usage7d` | Optional status-bar meta info | Show in status bar |

### Timing convention
1. After the connection is established, the backend **first sends** `user` (echo the transcription) + `status` ("思考中")
2. During processing the connection **stays open** (the glasses HUD keeps showing "思考中")
3. The brain produces a result → send `answer` → immediately followed by `done` → **close the connection**
4. **One turn, one answer**: a single request corresponds to one `answer` + `done`, then the connection closes. The next utterance is a new POST.
5. On error (STT failure / brain timeout) → send `error` + `done` (HTTP is still 200, the error is in the event)

### Event JSON example
```
data: {"type":"user","text":"今天天气怎么样"}

data: {"type":"status","text":"思考中"}

data: {"type":"meta","model":"Sonnet 4.6","usage5h":"29%","usage7d":"3%"}

data: {"type":"answer","text":"柏林今天阴天，最高22度，出门带件外套。"}

data: {"type":"done"}

```

## Minimal self-test (curl)
```bash
# Test the whole chain with a Chinese 16k wav
say -v Tingting -o /tmp/t.aiff "今天天气怎么样" && afconvert /tmp/t.aiff -f WAVE -d LEI16@16000 -c 1 /tmp/t.wav
curl -N -H "Authorization: Bearer $TOKEN" -F audio=@/tmp/t.wav https://<your-backend>/glasses/chat
# Expect to receive user / status / (meta) / answer / done events in order
# No token → expect 401
```

## Notes for implementers
- The only hard constraints on the backend are the ones above. The STT engine, AI brain, and public entry point are all your choice (the reference implementation uses whisper.cpp + any Agent + Tailscale, see backend/ and SETUP.en.md).
- Wiring in the brain only requires implementing `Agent.ask(text, ctx) -> AsyncIterable<string>` (see `backend/agent/types.ts`); it exposes no details of any specific brain.
- The glasses app's `URL` and `token` are written in by setup via adb (see SETUP.en.md); there is no pairing UI inside the app.
