# dsh-search-boost

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）搜索增强插件 —— 多引擎融合搜索、正文抓取、X 搜索、深度研究、多 agent 并行研究、主动搜索守则。

面向 DSH 的 **bundle 插件**：升级内置 `web_search` / `web_fetch`，并注册一整套搜索工具。

## 搜索层（`/web_change` 切换）

运行时用 `/web_change` 切换，选择写入 `~/.dsh-search-boost-layer.json`，重启后仍生效：

| 层 | 实际调用的引擎 | 适用场景 |
|---|---|---|
| **`free`**（仅无 key） | **Bing + DuckDuckGo + Yahoo + Exa MCP（exa-free）** —— 全部无 key，经 live 探针验证 | 反复研究、零成本、不想烧 API 额度 |
| **`api`**（默认） | 上述无 key 引擎 **+** Antigravity CLI（本机有 `agy` 时） **+** 已配置 key 的 **Tavily / Brave / Exa** | 要最全召回、愿意用付费 API |

无 key 引擎**并行**运行，单个失败不会空手而归。融合排序带跨引擎共现加分和半衰期时效衰减。

## 特性

| 能力 | 说明 |
|---|---|
| **内置 web_search + web_fetch 升级** | 注册并 patch `searchProvider` + `fetchProvider`；UI/引用卡片不变，后端换成本插件的引擎链与 Jina 优先抓取 |
| `fused_search` | 多引擎融合：复杂度分档、Grok 风格查询预处理（`site:` / `OR` / 引号）、域名过滤、跨引擎打分、6h 缓存。层由 `/web_change` 控制，单次调用可 `layer` 覆盖 |
| `/web_change` | `free` = 仅无 key 池；`api` = 全池；`show` = 当前层 + 各引擎是否可用 |
| `x_search` | X/Twitter 实时：帖文 / 用户 / 线程。有凭据：托管 xAI 工具 ∥ 多引擎（限 x.com）并行合并。**无凭据**：多引擎 + oEmbed 全文（~2s）、guest GraphQL 用户资料、oEmbed 线程。`/x-login`、`/x-logout` 开关官方路径 |
| `/x-login` | 将 xAI 凭据写入 `~/.dsh-search-boost-xauth.json`（从 `~/.grok/auth.json` 或 `-k <XAI_API_KEY>` 导入）。OIDC 自动刷新；不改动 grok CLI 自身登录 |
| `/x-logout` | 删除 `/x-login` 凭据，回到免凭据降级链 |
| `fetch_page` | Jina Reader + 本地 HTML 回退 + `focus` 定向提取 + 24h 缓存 |
| `deep_research` | step 模式深研：complex 融合检索 + 覆盖度 + 缺口 + 建议查询，主 agent 多轮驱动 |
| `research_parallel` | 子查询分解 → DSH 原生 subagent 并行 → 来源合并 |
| `search_stats` | 缓存 / 分档 / 引擎可用性 / x_search 凭据审计 |
| 搜索守则 | `systemPrompt.section` 注入：时效事实必搜、X 内容走 `x_search`、优先免费引擎 |

## 安装（推荐 bundle）

### 从 npm 安装

```sh
dsh plugin --profile web add dsh-search-boost          # 最新版
dsh plugin --profile web add dsh-search-boost@0.1.2    # 指定版本
dsh plugin --profile web update dsh-search-boost       # 更新
```

- **`--profile web` 必填**（`web` 为常用 Web 配置档）。
- DSH 通过 pnpm 拉包并自动应用 `dsh.bundle.patch`，**无需手改配置**。
- 安装后重启：`dsh --profile web`。

### 从 Git 源码安装

```sh
dsh plugin --profile web add github:Mr-remon219/dsh-search-boost
dsh plugin --profile web add git+file:///本地/仓库/路径
```

### 一键脚本

```powershell
.\install.ps1          # Windows
./install.sh           # Linux / macOS
```

验证：

```sh
dsh --profile web --dump-config   # web.searchProvider 应为 dsh-search-boost
dsh --profile web
```

### 找不到 `dsh` 或 `pnpm`

常用启动方式是 `npx @deepseek-ai/dsh web`，不会装全局 `dsh`。可全局安装或直接用 npx：

```sh
npm install -g @deepseek-ai/dsh
# 或：
npx --yes @deepseek-ai/dsh plugin --profile web add dsh-search-boost
```

`dsh plugin` 需要 **pnpm**（`npm install -g pnpm` 或 corepack）。

## 备选：会话级动态插件（plugin-host.js）

单文件动态插件，会话内 `cordis_define` 安装，**不替换**内置 `web_search`。部署级集成请用上面的 bundle 方式。

## 配置（API Key）

发布包**不含密钥**。按序读取：

1. `~/.dsh-search-boost-keys.json` 或 `./.search-boost-keys.json`：

```json
{ "tavily": "tvly-...", "exa": "...", "brave": "..." }
```

2. 环境变量：`TAVILY_API_KEY` / `EXA_API_KEY` / `BRAVE_API_KEY`

缺 key 的引擎自动从并行列表剔除。

**`free` 层零配置**：Bing、DuckDuckGo、Yahoo、Exa MCP（exa-free）全部无 key、开箱并行。Antigravity CLI（`agy`）为可选项，仅在 **`api` 层** medium/complex 档、且本机已安装登录时加入。

### x_search 凭据（可选）

| 命令 | 作用 |
|---|---|
| `/x-login` | 导入 grok 登录 → 启用官方托管 x_search（需 SuperGrok / X Premium+） |
| `/x-login -k <XAI_API_KEY>` | 用 console.x.ai API key |
| `/x-login status` | 查看凭据链 |
| `/x-logout` | 关闭官方路径；降级链仍可用 |

`~/.grok/auth.json` **不会自动读取**。未 `/x-login` 且无 `XAI_API_KEY` 时，`x_search` 只走免凭据链。

## 实测基准（2026-08，Windows）

### 免费层引擎探针（12 条查询 × 9 个候选）

运行 `node scripts/engine-benchmark.mjs`；完整 JSON 见 `scripts/engine-benchmark-report.json`。

| 引擎 | 成功率 | 平均延迟 | 结论 |
|---|---|---|---|
| bing | 100% | ~2.0s | ✅ 纳入 free 层 |
| ddg | 100% | ~2.2s | ✅ 纳入 free 层 |
| yahoo | 100% | ~2.3s | ✅ 纳入 free 层（v0.1.2 新增） |
| exa-free | 100% | ~4.2s | ✅ 纳入 free 层 |
| antigravity | 92% | ~27s | 仅 api 层（慢、依赖 `agy` CLI） |
| brave-html / mojeek / searx | 0% | — | 未纳入（429 / 不可达 / 被拦） |

### 集成场景

| 场景 | 结果 |
|---|---|
| `free` 层 fused_search | ~1.3–3.0s 返回 5 条；跨引擎佐证（如 rust 发版：yahoo+exa-free 共现 → 分 3.29） |
| `x_search`（无凭据） | keyword 多引擎+oEmbed；user guest GraphQL（@NASA ~2s）；thread oEmbed |
| SSRF 与 Clash TUN fake-ip | 字面量 198.18/15 拦截；TUN 路由主机名放行（`DSH_SEARCH_ALLOW_TUN_FAKEIP=0` 可关） |
| headless web_search | ✓ 走 free 层引擎链 |
| 单元 + E2E | 57/57 单元测试；14/14 黑盒 E2E |

## 架构要点

- 运行在**宿主进程**（Node `fetch` / `child_process` 直调）。
- HTML 抓取引擎（Bing / DDG / Yahoo）使用 **IPv4 强制 fetch**，避免 Windows 上 undici IPv6 优先 DNS 间歇超时。
- X 搜索：官方路径（`xsearch.js`）→ 免凭据链（`xfallback.js`：多引擎 + oEmbed + guest GraphQL）；无凭据时同步预检直走降级链。

## 文件

```
index.js                    — bundle 入口
lib/engines.js              — 引擎注册（bing / ddg / yahoo / exa-free / …）
lib/exa-free.js             — Exa MCP 无 key 引擎
lib/layer.js                — free/api 层状态
lib/fusion.js               — 融合打分与分档
lib/fetch.js                — Jina + focus 提取
lib/xauth.js / xsearch.js / xfallback.js — x_search 凭据与路径
lib/research.js             — 深研与并行研究
lib/policy.js               — 搜索守则
cordis.patch.yml            — DSH patch 清单
scripts/engine-benchmark.mjs — 维护者：live 免费引擎探针
```

## 发布（维护者）

```sh
npm test
npm publish   # prepublishOnly：语法 + 测试 + 工作树干净
```

## License

MIT

## 友链

- [Linux.do](https://linux.do/) — 开源技术社区
