#!/bin/sh
# macOS: 把 rode 后端托管为 launchd 服务（开机/崩溃自起）。幂等。
# 用法: scripts/start-backend-launchd.sh   (在 repo 根跑,读 .env)
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.$(id -un).rode"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BUN="$(command -v bun || echo /opt/homebrew/bin/bun)"
( cd "$REPO" && "$BUN" install --no-summary )   # 确保依赖在（全新 clone 没有 node_modules）
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>$REPO/backend/index.ts</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO/rode-backend.log</string>
  <key>StandardErrorPath</key><string>$REPO/rode-backend.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ launchd 托管: $LABEL (日志 $REPO/rode-backend.log)"
