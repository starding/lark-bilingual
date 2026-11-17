#!/bin/bash
# 生成可双击的应用：~/Applications/Lark 双语对照.app
# 用法：先在 Chrome 的两个窗口里各打开一篇文档，再双击应用。
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$(dirname "$(command -v node)")"
[ -x "$BIN/lark-cli" ] || BIN="$BIN:$(dirname "$(command -v lark-cli)")"
APP="$HOME/Applications/Lark 双语对照.app"
mkdir -p "$HOME/Applications"
rm -rf "$APP"
osacompile -o "$APP" -e "do shell script \"export PATH='$BIN':/usr/bin:/bin:/usr/sbin:/sbin; mkdir -p ~/.lark-bilingual; pkill -f 'node .*lark-bilingual[.]mjs'; nohup node '$HERE/lark-bilingual.mjs' --gui > ~/.lark-bilingual/app.log 2>&1 &\""
echo "已生成：$APP"
