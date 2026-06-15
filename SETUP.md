# rode 后端搭建（给人 / 给 AI 读）

> **中文** | [English](SETUP.en.md)

> 目标状态：一个常驻的 rode 后端，公网可达，眼镜 app 指向它。
> 本文是**方法论 + 检查点**，不是黑盒。每步给"要达成什么 + 用哪个脚本 + 怎么验证"。
> 给 AI 执行：只跑下面的脚本（最小权限），**每步验证后再下一步，不要静默 sudo / 不要即兴试错**。失败就停下报告中间态。

## 前置（用户自备）
- 一台常开的机器（macOS 或 Linux）+ [Bun](https://bun.sh)
- 一个 **AI 大脑**：默认 Claude —— 跑在 Claude Code 里，经 **Claude Agent SDK** 驱动（`bun install` 会装 `@anthropic-ai/claude-agent-sdk`）；需装好 `claude` CLI + 登录订阅或给 API key。rode 是宿主、把 Claude Code 当引擎调用，**不是 Claude Code 的 channel**。也可换任意实现 `Agent` 接口的大脑（Codex / 其它 LLM / 自建，见 `backend/agent/types.ts` 与 `PROTOCOL.md`）
  > 注：默认适配器首轮可能有 SDK 冷启动延迟（数十秒），多轮经 `resume` 续上下文。
- 一个**公网入口**：默认 Tailscale（[装 + 登录](https://tailscale.com/download)）；也可换 cloudflared/ngrok/frp（实现 `ExposeProvider`，见 `backend/expose/types.ts`）
- 眼镜端：已 adb 装好 app（见 README「眼镜端安装」）
- WiFi：眼镜需联网（见 README「WiFi 已知限制」）

> AI 执行注意：非交互 shell / SSH 的 PATH 很小，可能找不到 `bun`/`brew`/`openssl`。每条命令先确保 PATH 含它们（如 macOS Homebrew：`export PATH=/opt/homebrew/bin:$HOME/.bun/bin:$PATH`）。

## 步骤

### 0. 装依赖（必做，否则后端启动即崩）
```sh
bun install        # 装 @anthropic-ai/claude-agent-sdk 等；全新 clone 必须先跑
```
**验证**：`ls node_modules/@anthropic-ai/claude-agent-sdk` 存在。
> 托管脚本跑的是 `bun backend/index.ts`（不是 `bun start`），不会自动装依赖——这步漏了会在 import SDK 时崩。

### 1. 装 STT（whisper.cpp）
```sh
scripts/install-whisper.sh        # 幂等：装 whisper-cpp + 下 ggml-medium
whisper-server -m models/ggml-medium.bin -l zh --host 127.0.0.1 --port 18791 &
```
**验证**：`curl -s -F file=@<某段16k.wav> -F response_format=json http://127.0.0.1:18791/inference` 返回 `{"text":...}`。

### 2. 生成 token + 写 .env
```sh
cp .env.example .env
echo "RODE_GLASSES_TOKEN=$(openssl rand -hex 24)" >> .env   # 每机随机,只进本机 .env
```
**验证**：`grep -c '^RODE_GLASSES_TOKEN=' .env` 应为 **1**（值是 48 位 hex）；`.env` 已 gitignore（绝不提交）。
> `.env.example` 里的 token 行是注释掉的，所以上面 `cp`+`echo` 不会产生重复行。若你手动改了 example，务必确保 `.env` 里只有一条 `RODE_GLASSES_TOKEN=`——loader 取第一条，重复会让真 token 被占位符盖掉、认证恒 401。
> 端口若被占用：编辑 `.env` 把 `PORT=18790` 改成空闲端口（如 18795），后续命令里的 18790 同步替换。

### 3. 起后端（托管）
```sh
scripts/start-backend-launchd.sh   # macOS
# 或 scripts/start-backend-systemd.sh  # Linux
```
**验证**：`curl -s localhost:18790/` → `rode ok`；`curl -s -o /dev/null -w '%{http_code}' -XPOST localhost:18790/glasses/chat` → `401`（无 token 被拒）。

### 4. 暴露公网，拿 PUBLIC_URL
默认 Tailscale Funnel：
```sh
tailscale funnel --bg 18790
tailscale funnel status      # 记下 https://<node>.<tailnet>.ts.net
```
**验证**：从**另一台/外网** `curl -s https://<node>.ts.net/` → `rode ok`。PUBLIC_URL = `https://<node>.ts.net/glasses/chat`。
> 换 provider：实现 `ExposeProvider` 并自行产出 PUBLIC_URL 即可，后端不关心用哪家。

### 5. 配对眼镜（经 adb 写入 URL+token）
眼镜插 USB：
```sh
scripts/config-glasses.sh "https://<node>.ts.net/glasses/chat" "<你的RODE_GLASSES_TOKEN>"
```
（脚本内部：先启动 app 脱离 stopped → 显式 `-n` 组件 broadcast SET_CONFIG → 重启 app。这是 Android 隐式广播限制下唯一可靠的做法。）
**验证**：`adb shell run-as com.example.rokidvsikea cat shared_prefs/rode_config.xml`（debug 包）能看到写入的 chat_url。

### 6. 端到端验收
眼镜（确保 WiFi 已连）单击说话问一句 → HUD 出现「你说的话 → 思考中 → 大脑回答」。
或后端机直接 curl（`audio` 是 multipart 字段名，见 PROTOCOL.md；注意与 step 1 whisper 端点的 `file` 字段不同）：
```sh
TOKEN=$(grep '^RODE_GLASSES_TOKEN=' .env | cut -d= -f2)
PUBLIC_URL="https://<node>.ts.net/glasses/chat"   # step 4 拿到的；本地自测可用 http://localhost:18790/glasses/chat
curl -N -H "Authorization: Bearer $TOKEN" -F audio=@/tmp/t.wav "$PUBLIC_URL"
```
应看到 `user → status → answer → done` 四类 SSE 事件。（没有现成 wav？`say -o /tmp/a.aiff "今天天气怎么样" && afconvert /tmp/a.aiff -f WAVE -d LEI16@16000 -c 1 /tmp/t.wav`）

## 换大脑（接非 Claude 的 agent）
实现 `backend/agent/types.ts` 的 `Agent.ask(text, ctx): AsyncIterable<string>`，在 `backend/index.ts` 把默认的 `ClaudeCodeAgent` 换成你的实现即可。协议（`PROTOCOL.md`）不变。
