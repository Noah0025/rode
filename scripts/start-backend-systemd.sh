#!/bin/sh
# Linux: 把 rode 后端托管为 user systemd 服务。幂等。
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun)"
( cd "$REPO" && "$BUN" install --no-summary )   # 确保依赖在（全新 clone 没有 node_modules）
UNIT="$HOME/.config/systemd/user/rode.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<U
[Unit]
Description=rode backend
[Service]
WorkingDirectory=$REPO
ExecStart=$BUN $REPO/backend/index.ts
Restart=always
[Install]
WantedBy=default.target
U
systemctl --user daemon-reload
systemctl --user enable --now rode.service
echo "✓ systemd 托管: rode.service (journalctl --user -u rode -f 看日志)"
