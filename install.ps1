# dsh-search-boost 一键安装（Windows / PowerShell）—— bundle 形态
#
# 用法：
#   .\install.ps1                                  # 默认安装到 profile "web"
#   .\install.ps1 -Profile myprofile               # 指定 profile
#   .\install.ps1 -KeysFile .\my-keys.json         # 顺便配置引擎 key
#
# 安装后启动：dsh --profile <name>（内置 web_search 即走本插件引擎链）

[CmdletBinding()]
param(
  [string]$Profile = "web",
  [string]$KeysFile = ""
)

$ErrorActionPreference = "Stop"
$Repo = $PSScriptRoot

Write-Host "== dsh-search-boost 一键安装（bundle）==" -ForegroundColor Cyan

# 1. 检测 dsh CLI（PATH → npx 缓存 → npm 全局）
function Find-Dsh {
  # 1) PATH 中的 dsh
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  # 2) npx 缓存（官方推荐形态 `npx @deepseek-ai/dsh web` 的落点）
  #    可能有多个 _npx/<hash> 目录（不同包），逐个找含 dsh shim 的；
  #    优先 .cmd / .ps1（Windows 可执行），无扩展名 shim 无法直接执行
  $npxDirs = @(Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx\*" -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending)
  foreach ($d in $npxDirs) {
    $bin = Join-Path $d.FullName "node_modules\.bin"
    foreach ($n in @("dsh.cmd", "dsh.ps1", "dsh")) {
      $p = Join-Path $bin $n
      if (Test-Path $p) { return $p }
    }
  }
  # 3) npm 全局前缀
  $npmPrefix = $null
  try { $npmPrefix = & npm prefix -g 2>$null } catch {}
  if ($npmPrefix) {
    foreach ($n in @("dsh.cmd", "dsh.ps1", "dsh")) {
      $p = Join-Path $npmPrefix $n
      if (Test-Path $p) { return $p }
    }
  }
  return $null
}

$dsh = Find-Dsh
if (-not $dsh) {
  Write-Host "" -NoNewline
  Write-Error @"
未找到 dsh CLI（DeepSeek Harness）。
官方通常通过 npx 运行（npx @deepseek-ai/dsh web），此时系统里没有全局 dsh 命令，本脚本检测不到。
请任选一种方式后重试：

  1) 全局安装（推荐，装完重开终端）：
     npm install -g @deepseek-ai/dsh

  2) 不装全局，改用 npx 直接执行本插件的安装：
     npx --yes @deepseek-ai/dsh plugin --profile $Profile add $Repo

  3) 如果 dsh 已装在非标准位置，把它的目录加入 PATH 后重试。
"@
  exit 1
}

# 1b. 检测 pnpm（dsh plugin add 的硬依赖，dsh 用它解析 bundle 依赖）
$npmPrefix = $null
try { $npmPrefix = & npm prefix -g 2>$null } catch {}
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
  # npm 全局已装 pnpm 但不在 PATH（例如装完没重开终端）→ 自动注入本会话 PATH
  if ($npmPrefix) {
    foreach ($n in @("pnpm.cmd", "pnpm.ps1", "pnpm")) {
      $p = Join-Path $npmPrefix $n
      if (Test-Path $p) {
        $env:PATH = "$npmPrefix;$env:PATH"
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
        Write-Host "[注] pnpm 不在 PATH，已自动加入 npm 全局目录: $npmPrefix" -ForegroundColor Yellow
        break
      }
    }
  }
}
if (-not $pnpm) {
  Write-Error @"
未找到 pnpm（dsh plugin add 的硬依赖，用于解析 bundle 依赖）。
请先安装，装完重开终端后重新运行本脚本：

  1) 通过 npm 全局安装（推荐）：
     npm install -g pnpm

  2) 如果用 corepack 管理：
     corepack enable
     corepack prepare pnpm@latest --activate
"@
  exit 1
}

Write-Host "[1/3] dsh CLI: $dsh" -ForegroundColor Green
Write-Host "      pnpm: $($pnpm.Source)" -ForegroundColor Green

# 2. 语法校验（node 存在时）
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Write-Host "[2/3] 校验源码语法 ..." -ForegroundColor Yellow
  foreach ($f in @("index.js", "lib\engines.js", "lib\fusion.js", "lib\fetch.js", "lib\grok.js", "lib\policy.js")) {
    & $node.Source --check (Join-Path $Repo $f) 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error "语法校验失败: $f"; exit 1 }
  }
  Write-Host "      语法 OK" -ForegroundColor Green
}

# 3. key 配置（可选）
if ($KeysFile -and (Test-Path $KeysFile)) {
  Copy-Item $KeysFile "$env:USERPROFILE\.dsh-search-boost-keys.json" -Force
  Write-Host "      key 已写入 ~/.dsh-search-boost-keys.json" -ForegroundColor Green
} else {
  Write-Host "      未配置 key（免费引擎 bing 开箱即用；tavily/brave/exa 需 key）" -ForegroundColor DarkYellow
}

# 4. dsh plugin add
Write-Host "[3/3] dsh plugin add ..." -ForegroundColor Yellow
Push-Location (Split-Path $Repo -Parent)
try {
  & $dsh plugin --profile $Profile add $Repo 2>&1 | Select-Object -Last 6
  if ($LASTEXITCODE -ne 0) { Write-Error "dsh plugin add 失败"; exit 1 }
} finally {
  Pop-Location
}

# 5. 验证层
Write-Host "--- 验证（dump-config）---" -ForegroundColor Cyan
& $dsh --profile $Profile --dump-config 2>&1 | Select-String -Pattern 'searchProvider|dsh-search-boost' | Select-Object -First 5

Write-Host ""
Write-Host "== 完成。启动：dsh --profile $Profile ==" -ForegroundColor Green
Write-Host "内置 web_search 已走 dsh-search-boost 引擎链；fused_search / fetch_page / x_search / search_stats 工具已注册。"
