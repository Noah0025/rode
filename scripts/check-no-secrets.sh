#!/bin/sh
# 零密钥扫描：跟踪文件里不应出现真实凭证 / 私有部署地址 / 本机用户名。命中非零退出。
# 通用规则，不写死任何 maintainer 专属名字。占位用 <node>/<your-...> 等。
hit=0
SELF=':!scripts/check-no-secrets.sh'

# 1) 指向真实 tailnet/funnel 的 /glasses 部署地址（占位应是 <node>.<tailnet>.ts.net）
if git grep -nE '[a-z0-9-]+\.ts\.net/glasses' -- . "$SELF" >/dev/null 2>&1; then
  echo "❌ 私有部署地址泄露:"; git grep -nE '[a-z0-9-]+\.ts\.net/glasses' -- . "$SELF"; hit=1
fi

# 2) 硬编码 token（32+ 位 hex），*.example 除外
if git grep -nE 'GLASSES_TOKEN=[0-9a-f]{32,}' -- . ':!*.example' >/dev/null 2>&1; then
  echo "❌ 硬编码 token:"; git grep -nE 'GLASSES_TOKEN=[0-9a-f]{32,}' -- . ':!*.example'; hit=1
fi

# 3) 绝对 home 路径（泄露用户名），扫描器/example 除外；文档/代码请用 ~ 或 $HOME
if git grep -nE '/(Users|home)/[A-Za-z][A-Za-z0-9_-]+/' -- . "$SELF" ':!*.example' >/dev/null 2>&1; then
  echo "❌ 绝对 home 路径(泄露用户名，请改 ~ 或 \$HOME):"; git grep -nE '/(Users|home)/[A-Za-z][A-Za-z0-9_-]+/' -- . "$SELF" ':!*.example'; hit=1
fi

[ "$hit" = 0 ] && echo "CLEAN" || exit 1
