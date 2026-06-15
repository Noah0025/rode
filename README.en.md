# rode
> [中文](README.md) | **English**

**Rokid AR glasses voice → your own AI brain → glasses HUD.** Single-tap to talk; the glasses record audio and send it to your self-hosted backend, which transcribes it, feeds it to the AI of your choice (Claude by default), and shows the answer on the HUD. Both the brain and the public ingress are pluggable.

<div align="center">
  <img src="assets/rode-hud-demo.png" alt="rode HUD demo" width="320">
  <p><em>Live HUD shots from the glasses (same conversation): self-identification (Claude running on your own machine) · writing to the calendar (agentic execution) · English Q&A (multilingual) · referencing the previous turn (multi-turn context). User on the right, Rode on the left.</em></p>
</div>

---

## ⚠️ For developers · At your own risk (read first)

This is **not** a plug-and-play consumer product. To use rode you need:
- To know how to use **adb** (install the app onto the glasses over a cable)
- An always-on machine + the ability to **expose it to the public internet** (Tailscale, etc.)
- An **AI brain**: Claude by default (requires a subscription or paid API), or swap in any AI agent

**Responsibility and privacy** (you must be aware):
- rode is a **continuous recording device**: what you say is sent to your self-hosted backend and processed by the third-party AI you chose. Use it with discretion when others are present, and comply with local law.
- SETUP **runs scripts on your own machine** and **exposes** local services **to the public internet**. That is a double responsibility surface; assess the risk yourself. This project is provided "AS IS" under Apache-2.0; the author makes no warranty and accepts no liability for any consequences.
- rode depends on **current YodaOS behavior** (sideload, adb, power policy). A Rokid firmware update may break it.

## Architecture

```
眼镜 app(录音) ──multipart 音频 POST──► 你的后端(公网入口 → :18790)
                                          │ whisper.cpp STT
                                          │ Agent.ask()  ← 任意 AI 大脑(可插拔)
                              ◄──SSE──────┘ user/status/answer/done/meta
眼镜 HUD 显示文字（v1 无语音朗读）
```

- **Protocol contract** (the only interface between glasses ↔ backend): see [`PROTOCOL.md`](PROTOCOL.md)
- **Setup** (executable by a human or an AI): see [`SETUP.md`](SETUP.md)
- Pluggable points: the brain [`backend/agent/types.ts`](backend/agent/types.ts), the public ingress [`backend/expose/types.ts`](backend/expose/types.ts), STT [`backend/stt.ts`](backend/stt.ts)

## v1 scope and limitations

**What it can do**
- Single-tap to talk → STT (whisper, multilingual: mixed Chinese/English/German) → your AI brain → text answer shown on the HUD
- Default brain = Claude, running inside Claude Code: **full agentic** capability on the server — search the web for real-time info, read/write files, run code, call MCP tools, write to the calendar, and more (the screenshot above wrote to the calendar)
- **Multi-turn context**: remembers the previous utterance, and does not lose it across backend restarts (sessionId persisted to disk)
- **Conversation history** stays local on the glasses (the most recent ~50 turns, segmented by time), and is still there after reopening the app
- Accidental taps can be canceled/undone with a double-tap
- **Three pluggable points**: the brain (any AI) · STT engine · public ingress

**Glasses permissions**
| Present and in use | Declared but restricted / not enabled |
|---|---|
| Microphone (record speech) · Network · Wake lock (no sleep within a turn) · Read battery/WiFi signal/time (status bar) · URL+token injected via adb | `CHANGE_WIFI_STATE`: **Android 12 blocks non-system apps from enabling WiFi**, so it actually cannot be turned on (falls back to adb, see below) · `CAMERA`: declared, but **v1 has no vision** (records audio only; no photos sent; the protocol reserves an image field, glasses-side implementation pending) |

**Current limitations (v1 cannot do)**
- **No spoken readout**: the glasses lack a Chinese TTS voice pack → answers are shown as text on the HUD only, with no audio (readout = backend synthesizes audio and sends it back; on the roadmap)
- **No vision**: no photos taken / no images sent (camera permission exists but is not wired up)
- **WiFi cannot stay on automatically**: it gets turned off by YodaOS on battery/sleep, and the app has no permission to enable it → relies on the adb fallback or use while charging (see "Known WiFi limitation" below)
- **Not streaming**: one answer per turn (returned as a whole), not token-by-token streaming output (streaming is on the roadmap)
- **Not always-listening**: turn-based, triggered by a single tap, not actively listening (a power-saving + privacy design choice)
- **Not offline**: all computation happens on your server backend; the glasses only do input and output; unusable when disconnected
- **First-turn cold start**: the default Claude brain may take tens of seconds for the SDK cold start on the first turn, then gets faster after multi-turn `resume`

## Quick start
1. **Glasses-side install**: build the APK from `glasses-app/` and `adb install` (see below).
2. **Backend**: follow [`SETUP.md`](SETUP.md) (install whisper → generate token → start the backend → expose to the public internet → `scripts/config-glasses.sh` to pair the glasses).
3. Single-tap on the glasses to talk.

## Glasses-side install (build)
```sh
cd glasses-app
cp local.properties.example local.properties   # 把 sdk.dir 改成真实 Android SDK 路径(或设 ANDROID_HOME)；URL/token 可留占位,由 setup 经 adb 注入,不烤进 APK
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
The URL+token are not baked in at compile time; they are written at runtime by `scripts/config-glasses.sh` via adb (`ConfigReceiver`→SharedPreferences).

## ⚠️ Known WiFi limitation (read first, or the glasses won't connect to the backend)

**Core problem**: the glasses (YodaOS) automatically turn off WiFi when on **battery power / asleep**, and **a regular app has no permission to turn it back on** — Android 12 blocks `setWifiEnabled()` for non-system apps, and the rode app's call returns false the same way. The glasses' native AI goes online **via Bluetooth to a phone**, not relying on WiFi, so the Rokid platform does not keep WiFi on persistently. **Result**: after the glasses reboot or sit idle for a while, WiFi turns off and the HUD shows "not connected to the backend."

**This is not a bug, it is a platform limitation.** The realistic usage for now:

1. **Save the WiFi first**: plug the glasses into USB, connect to your WiFi once in developer mode (`adb shell cmd wifi connect-network "<SSID>" wpa2 "<密码>"`, or connect once in the glasses settings) so it remembers the network.
2. **When WiFi gets turned off, force it on with adb** (the app has no permission, but adb does):
   ```sh
   adb shell svc wifi enable          # 开 WiFi，自动重连已存网络
   adb shell cmd wifi status          # 确认连上（看到 "connected to ..." 即可）
   ```
3. **More stable while charging**: WiFi is less likely to be turned off while plugged in / in use, and turn-based voice is good enough.
4. **After every glasses reboot** WiFi defaults to off, so you need to `adb shell svc wifi enable` once more.

**A complete fix**: either give the app control over WiFi (requires Device Owner, which requires a factory reset — not adopted by this project), or switch to a low-power form factor that **goes through Bluetooth to a phone** (Rokid's official path, see roadmap R1). v1 takes the compromise of "adb fallback + use while charging."

## Security
- Each backend **generates a random token**, kept only in the local `.env` and the glasses prefs; zero secrets in the repo (`scripts/check-no-secrets.sh` scans for them)
- Backend: rate limiting / body limits / log redaction; exposing to the public internet means exposing your local AI capabilities, so run the brain within restricted permissions
- The `ConfigReceiver` used for config injection is exported (required for adb delivery) and only accepts https URLs; another app on the same machine could in theory deliver a forged config, a risk that is acceptable on a personal development device

## Related projects

Several projects already bring AI to smart glasses. rode positions itself as a **Rokid-platform, phone-free, self-hosted pluggable agentic backend**. The table below compares the main approaches by hardware, connection method, and brain form factor:

| Project | Hardware | Connection | Brain |
|---|---|---|---|
| **rode** (this project) | Rokid (full Android / YodaOS) | Glasses-native app, WiFi direct to a self-hosted backend, no phone needed | Self-hosted, pluggable (Claude by default, swap in any agent) |
| [claude-code-g2](https://github.com/sam-siavoshian/claude-code-g2) | Even Realities G2 (display only) | WebView + Bluetooth via the official phone app | Claude, counts against the Max subscription |
| [VisionClaude](https://github.com/mrdulasolutions/visionclaude) | iPhone / Meta Ray-Ban | Phone → local MCP | Claude, vision-focused |
| [RokidAIAssistant](https://github.com/zero2005x/RokidAIAssistant) | Rokid (same hardware) | Glasses ↔ phone Bluetooth | Cloud API (multiple providers, bring your own key), not self-hosted |
| [MentraOS](https://github.com/Mentra-Community/MentraOS) | Vuzix / Even / Mach1 | Vendor OS, self-hosted mini-app | Can connect a local LLM; does not support Rokid |

**Architecture trade-off**: rode v1 takes the "glasses connect to the backend directly over WiFi, no phone" route, which wins on being the least hassle — no extra phone app needed; the cost is that YodaOS turns off WiFi while idle, requiring an adb fallback (see "Known WiFi limitation"). The other route is "Bluetooth through a phone companion" (adopted by RokidAIAssistant and others, requiring a dedicated phone app + the Rokid CXR SDK), which avoids the WiFi problem but requires carrying a phone — this is rode's roadmap R1, not a ruled-out option.

## Roadmap
- **R1 CXR Bluetooth mobile form factor**: a phone companion acts as a gateway over Bluetooth, removing the need for public ingress + low power + fixes WiFi (Rokid's official form factor)
- **R2 Pairing-code provisioning**: the glasses store only a pairing code, with credentials provisioned by the backend, so no sensitive information is persisted
- **R3 Multi-provider ingress**: cloudflared / ngrok / frp built in
- **R4 Idempotent installer via Docker/Nix**

## License
Apache-2.0. AS IS, at your own risk.
