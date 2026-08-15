#!/usr/bin/env bash
# dsh-search-boost 一键安装（Linux / macOS）—— bundle 形态
# 用法：
#   ./install.sh                       # 默认安装到 profile "web"
#   ./install.sh --profile myprofile   # 指定 profile
#   ./install.sh --keys ./my-keys.json # 顺便配置引擎 key
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="web"
KEYS_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --keys) KEYS_FILE="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

echo "== dsh-search-boost 一键安装（bundle）=="
command -v dsh >/dev/null 2>&1 || { echo "错误: 未找到 dsh CLI"; exit 1; }
echo "[1/3] dsh CLI: $(command -v dsh)"

if command -v node >/dev/null 2>&1; then
  echo "[2/3] 校验源码语法 ..."
  for f in index.js lib/engines.js lib/fusion.js lib/fetch.js lib/grok.js lib/policy.js; do
    node --check "$REPO/$f"
  done
  echo "      语法 OK"
fi

if [[ -n "$KEYS_FILE" && -f "$KEYS_FILE" ]]; then
  cp "$KEYS_FILE" "$HOME/.dsh-search-boost-keys.json"
  echo "      key 已写入 ~/.dsh-search-boost-keys.json"
else
  echo "      未配置 key（免费引擎 bing 开箱即用）"
fi

echo "[3/3] dsh plugin add ..."
dsh plugin --profile "$PROFILE" add "$REPO"

echo "--- 验证（dump-config）---"
dsh --profile "$PROFILE" --dump-config | grep -E 'searchProvider|dsh-search-boost' | head -5

echo ""
echo "== 完成。启动：dsh --profile $PROFILE =="
