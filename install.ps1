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

# 1. 检测 dsh CLI
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
  Write-Error "未找到 dsh CLI（请先安装 DeepSeek Harness）"
  exit 1
}
Write-Host "[1/3] dsh CLI: $($dsh.Source)" -ForegroundColor Green

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
  dsh plugin --profile $Profile add $Repo 2>&1 | Select-Object -Last 6
  if ($LASTEXITCODE -ne 0) { Write-Error "dsh plugin add 失败"; exit 1 }
} finally {
  Pop-Location
}

# 5. 验证层
Write-Host "--- 验证（dump-config）---" -ForegroundColor Cyan
dsh --profile $Profile --dump-config 2>&1 | Select-String -Pattern 'searchProvider|dsh-search-boost' | Select-Object -First 5

Write-Host ""
Write-Host "== 完成。启动：dsh --profile $Profile ==" -ForegroundColor Green
Write-Host "内置 web_search 已走 dsh-search-boost 引擎链；fused_search / fetch_page / x_search / search_stats 工具已注册。"
