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

# 1. 检测 dsh CLI（PATH → npx 缓存 → npm 全局）
find_dsh() {
  if command -v dsh >/dev/null 2>&1; then
    command -v dsh
    return 0
  fi
  # npx 缓存（官方推荐形态 `npx @deepseek-ai/dsh web` 的落点，取最新）
  local npx_bin
  npx_bin="$(ls -dt "$HOME"/.npm/_npx/*/node_modules/.bin/dsh 2>/dev/null | head -1)"
  if [[ -n "$npx_bin" ]]; then
    echo "$npx_bin"
    return 0
  fi
  # npm 全局前缀
  local prefix
  prefix="$(npm prefix -g 2>/dev/null || true)"
  if [[ -n "$prefix" ]]; then
    for n in dsh dsh.cmd; do
      if [[ -x "$prefix/bin/$n" || -f "$prefix/bin/$n" ]]; then
        echo "$prefix/bin/$n"
        return 0
      fi
    done
  fi
  return 1
}

DSH="$(find_dsh || true)"
if [[ -z "$DSH" ]]; then
  cat <<EOF

错误: 未找到 dsh CLI（DeepSeek Harness）。
官方通常通过 npx 运行（npx @deepseek-ai/dsh web），此时系统里没有全局 dsh 命令，本脚本检测不到。
请任选一种方式后重试：

  1) 全局安装（推荐，装完重开终端）：
     npm install -g @deepseek-ai/dsh

  2) 不装全局，改用 npx 直接执行本插件的安装：
     npx --yes @deepseek-ai/dsh plugin --profile $PROFILE add $REPO

  3) 如果 dsh 已装在非标准位置，把它的目录加入 PATH 后重试。
EOF
  exit 1
fi
echo "[1/3] dsh CLI: $DSH"

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
"$DSH" plugin --profile "$PROFILE" add "$REPO"

echo "--- 验证（dump-config）---"
"$DSH" --profile "$PROFILE" --dump-config | grep -E 'searchProvider|dsh-search-boost' | head -5

echo ""
echo "== 完成。启动：dsh --profile $PROFILE =="
