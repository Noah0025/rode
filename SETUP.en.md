# rode Backend Setup (for humans / for AI)

> [中文](SETUP.md) | **English**

> Target state: a long-running rode backend, reachable on the public internet, with the glasses app pointing at it.
> This document is a **methodology + checkpoints**, not a black box. Each step gives "what to achieve + which script to use + how to verify."
> For AI execution: only run the scripts below (least privilege), **verify after each step before moving to the next, do not silently sudo / do not improvise trial-and-error**. If something fails, stop and report the intermediate state.

## Prerequisites (provided by the user)
- An always-on machine (macOS or Linux) + [Bun](https://bun.sh)
- An **AI brain**: Claude by default — running inside Claude Code, driven through the **Claude Agent SDK** (`bun install` installs `@anthropic-ai/claude-agent-sdk`); you need the `claude` CLI installed + a logged-in subscription or an API key. rode is the host and calls Claude Code as its engine; it is **not a channel of Claude Code**. You can also swap in any brain that implements the `Agent` interface (Codex / another LLM / your own build, see `backend/agent/types.ts` and `PROTOCOL.en.md`)
  > Note: the default adapter may have SDK cold-start latency on the first turn (tens of seconds); subsequent turns continue the context via `resume`.
- A **public ingress**: Tailscale by default ([install + log in](https://tailscale.com/download)); you can also swap in cloudflared/ngrok/frp (implement `ExposeProvider`, see `backend/expose/types.ts`)
- Glasses side: the app already installed via adb (see README "Glasses-side install")
- WiFi: the glasses need network connectivity (see README "WiFi known limitations")

> AI execution note: the PATH in a non-interactive shell / SSH is very small, and may not find `bun`/`brew`/`openssl`. Before each command, make sure PATH includes them (e.g. for macOS Homebrew: `export PATH=/opt/homebrew/bin:$HOME/.bun/bin:$PATH`).

## Steps

### 0. Install dependencies (mandatory, otherwise the backend crashes on startup)
```sh
bun install        # installs @anthropic-ai/claude-agent-sdk etc.; required first on a fresh clone
```
**Verify**: `ls node_modules/@anthropic-ai/claude-agent-sdk` exists.
> The managed script runs `bun backend/index.ts` (not `bun start`), which does not auto-install dependencies — skipping this step will crash when importing the SDK.

### 1. Install STT (whisper.cpp)
```sh
scripts/install-whisper.sh        # idempotent: install whisper-cpp + download ggml-medium
whisper-server -m models/ggml-medium.bin -l zh --host 127.0.0.1 --port 18791 &
```
**Verify**: `curl -s -F file=@<some 16k.wav> -F response_format=json http://127.0.0.1:18791/inference` returns `{"text":...}`.

### 2. Generate a token + write .env
```sh
cp .env.example .env
echo "RODE_GLASSES_TOKEN=$(openssl rand -hex 24)" >> .env   # random per machine, stays in the local .env only
```
**Verify**: `grep -c '^RODE_GLASSES_TOKEN=' .env` should be **1** (the value is 48 hex characters); `.env` is already gitignored (never commit it).
> The token line in `.env.example` is commented out, so the `cp`+`echo` above will not produce a duplicate line. If you manually edited the example, make sure there is only one `RODE_GLASSES_TOKEN=` in `.env` — the loader takes the first one, and a duplicate will let the placeholder override the real token, causing authentication to always 401.
> If the port is taken: edit `.env` to change `PORT=18790` to a free port (e.g. 18795), and replace 18790 in the subsequent commands accordingly.

### 3. Start the backend (managed)
```sh
scripts/start-backend-launchd.sh   # macOS
# or scripts/start-backend-systemd.sh  # Linux
```
**Verify**: `curl -s localhost:18790/` → `rode ok`; `curl -s -o /dev/null -w '%{http_code}' -XPOST localhost:18790/glasses/chat` → `401` (rejected without a token).

### 4. Expose to the public internet, get PUBLIC_URL
Tailscale Funnel by default:
```sh
tailscale funnel --bg 18790
tailscale funnel status      # note down https://<node>.<tailnet>.ts.net
```
**Verify**: from **another machine / off-network** `curl -s https://<node>.ts.net/` → `rode ok`. PUBLIC_URL = `https://<node>.ts.net/glasses/chat`.
> Switching provider: just implement `ExposeProvider` and produce the PUBLIC_URL yourself; the backend does not care which one you use.

### 5. Pair the glasses (write URL+token via adb)
Plug the glasses in via USB:
```sh
scripts/config-glasses.sh "https://<node>.ts.net/glasses/chat" "<your RODE_GLASSES_TOKEN>"
```
(Inside the script: first start the app to bring it out of the stopped state, then explicitly `-n` the component to broadcast SET_CONFIG, then restart the app. This is the only reliable approach under Android's implicit-broadcast restrictions.)
**Verify**: `adb shell run-as com.example.rokidvsikea cat shared_prefs/rode_config.xml` (debug build) shows the written chat_url.

### 6. End-to-end acceptance
On the glasses (make sure WiFi is connected), single-click to talk and ask something → the HUD shows "what you said → thinking → the brain's answer."
Or curl directly on the backend machine (`audio` is the multipart field name, see PROTOCOL.en.md; note it differs from the `file` field of the step 1 whisper endpoint):
```sh
TOKEN=$(grep '^RODE_GLASSES_TOKEN=' .env | cut -d= -f2)
PUBLIC_URL="https://<node>.ts.net/glasses/chat"   # from step 4; for local testing use http://localhost:18790/glasses/chat
curl -N -H "Authorization: Bearer $TOKEN" -F audio=@/tmp/t.wav "$PUBLIC_URL"
```
You should see four kinds of SSE events: `user → status → answer → done`. (No wav on hand? `say -o /tmp/a.aiff "what's the weather today" && afconvert /tmp/a.aiff -f WAVE -d LEI16@16000 -c 1 /tmp/t.wav`)

## Swapping the brain (connecting a non-Claude agent)
Implement `Agent.ask(text, ctx): AsyncIterable<string>` from `backend/agent/types.ts`, and in `backend/index.ts` replace the default `ClaudeCodeAgent` with your implementation. The protocol (`PROTOCOL.en.md`) stays the same.
