#!/bin/sh
# 把后端 URL+token 经 adb 注入眼镜 app。用法：
#   scripts/config-glasses.sh <PUBLIC_URL> <TOKEN> [adb-serial]
# 注意（实测）：必须 (1)先启动 app 脱离 stopped (2)用显式 -n 组件(避开 Android 隐式广播后台限制)。
set -e
URL="$1"; TOKEN="$2"
[ -z "$URL" ] || [ -z "$TOKEN" ] && { echo "用法: $0 <PUBLIC_URL> <TOKEN> [serial]"; exit 1; }
case "$URL" in https://*) ;; *) echo "URL 必须 https"; exit 1;; esac
S=""; [ -n "$3" ] && S="-s $3"
PKG=com.example.rokidvsikea
adb $S shell am start -n $PKG/.MainActivity >/dev/null 2>&1; sleep 2
adb $S shell am broadcast -n $PKG/.ConfigReceiver -a $PKG.SET_CONFIG --es url "$URL" --es token "$TOKEN" | grep -i completed
adb $S shell am force-stop $PKG
adb $S shell am start -n $PKG/.MainActivity >/dev/null 2>&1
echo "✓ 配置已注入并重启 app"
