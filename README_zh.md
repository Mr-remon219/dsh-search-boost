# dsh-search-boost

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）搜索增强插件 —— 多引擎融合搜索、正文抓取、X 搜索、深度研究、多 agent 并行研究、主动搜索守则。

一个面向 DSH 的 **bundle 插件**：升级内置 `web_search`，并注册一整套搜索工具：

- 免费引擎**并行**：**Antigravity CLI / Bing / DuckDuckGo / Exa MCP（exa-free）**（全部无 key），keyed 引擎 **Tavily / Brave / Exa** 在配置 key 后加入。
- 融合排序：跨引擎共现打分 + 半衰期时效衰减。
- 由主 agent 驱动的深度研究，以及扇出到 DSH 原生 subagent 的并行研究。

## 特性

| 能力 | 说明 |
|---|---|
| **内置 web_search + web_fetch 升级** | 注册 `WebSearchProvider` + `WebFetchProvider` 并 patch 改写 `searchProvider` + `fetchProvider` 两个配置键，内置 `web_search` 直接跑在本插件的免费优先引擎链上、内置 `web_fetch` 跑在 Jina 优先抓取链上（保留原生引用/结果卡片） |
| `fused_search` | 多引擎融合检索：免费引擎**并行**（Antigravity CLI / Bing / DuckDuckGo / Exa MCP —— 全部无 key），keyed 引擎在配置 key 后加入（Tavily / Brave / Exa）。当前搜索层用 `/web_change` 切换（free=仅无 key 引擎 / api=全池），也支持按次 `layer` 覆盖。复杂度路由、Grok 风格查询预处理、域名硬过滤、半衰期时效衰减、跨引擎共现打分、6h TTL 缓存 |
| `x_search` | X/Twitter 实时搜索：帖子 / 用户 / 线程。`keyword`/`semantic` 走**并行即时搜索** —— 托管 xAI `x_search` 工具（`/x-login` 导入 grok 登录，或 `XAI_API_KEY`）∥ 融合多引擎（限 x.com）同时跑，结果按 status id/url 去重合并。**零凭据也能用**：多引擎 + oEmbed 全文增强（~2s），用户结构化资料走 X 匿名 guest GraphQL，线程全文走 oEmbed。结果按类型缓存（keyword/semantic 5min、user 10min、thread 15min TTL）。`/x-login` 启用官方路径，`/x-logout` 关闭 |
| `/x-login` | 把 xAI 凭据导入 `~/.dsh-search-boost-xauth.json` 以启用官方 `x_search` 路径：`/x-login`（无参 = 从你的 grok 登录 `~/.grok/auth.json` 导入）、`/x-login -k <XAI_API_KEY>`（公开 api.x.ai）、`/x-login status`。OIDC token 自动刷新（尽力同步回 grok 文件）；grok CLI 自己的登录永不被改动 |
| `/x-logout` | 删除 `/x-login` 凭据：官方托管路径被禁用，`x_search` 只用多引擎 / guest-GraphQL / oEmbed 降级链 |
| `fetch_page` | Jina Reader 正文抓取 + 本地 HTML 回退 + `focus` 定向提取（省 ~90% token）+ 24h 缓存 |
| `deep_research` | step 模式深研：complex 融合检索 + 覆盖度分析 + 跨域佐证统计 + 缺口 + 建议查询，**由主 agent 驱动多轮直至收敛** |
| `research_parallel` | 多 agent 并行深研：子查询分解 → 并行派 DSH 原生 subagent（每代理独立上下文，继承 `fused_search` / `fetch_page`）→ 时间预算 → 来源合并 |
| `search_stats` | 缓存 / 分档 / 引擎可用性 / x_search 凭据状态审计 |
| 搜索守则 | `systemPrompt.section` 正规注入：时效事实必搜、技术论断验证、X 内容路由 `x_search`、停止条件、成本感知（免费引擎优先） |

## 安装（bundle，推荐）

**从 npm 安装（推荐给使用者 —— 已发布版本）：**

```sh
dsh plugin add dsh-search-boost          # 最新版
dsh plugin add dsh-search-boost@0.0.3    # 锁定版本
```

npm 安装按版本分发、不依赖任何本地 checkout；registry 上的包永远对应一个已提交、已测试的工作树（由 `prepublishOnly` 门禁保证）。

**从源码安装（开发 / 最新 git）：**

```sh
dsh plugin add github:Mr-remon219/dsh-search-boost        # 最新 main
dsh plugin add github:Mr-remon219/dsh-search-boost#<hash> # 锁定 commit
dsh plugin --profile web add git+file:///path/to/repo     # 本地 git 源（协议已实测）
```

git/本地源适合开发迭代：改完 → 重启 → 验证。

或者直接运行仓库内的安装脚本（语法校验 → key 配置 → 安装 → 验证）：

```powershell
.\install.ps1          # Windows（默认装进 profile "web"）
./install.sh           # Linux / macOS
```

装完重启 `dsh --profile web` 即用：内置 `web_search` 走本插件引擎链，`fused_search` / `fetch_page` / `x_search` / `deep_research` / `research_parallel` / `search_stats` 全部注册。git 源安装协议已实测通过（pnpm 拉取 → patch 层生效 → 端到端可用）。

### 排查：缺 `dsh` 或缺 `pnpm`

DSH 官方推荐 `npx @deepseek-ai/dsh web` 运行，**不会产生全局 `dsh` 命令**，安装脚本因此检测不到。脚本现在会自动探测 npx 缓存（`%LOCALAPPDATA%\npm-cache\_npx\*` / `~/.npm/_npx/*`）和 npm 全局前缀，通常开箱即过。若仍失败，任选其一：

1. 全局安装（推荐），装完重开终端：
   ```sh
   npm install -g @deepseek-ai/dsh
   ```
2. 跳过脚本，直接用 npx 执行安装：
   ```sh
   npx --yes @deepseek-ai/dsh plugin --profile web add <本仓库路径>
   ```

`dsh plugin add` 还需要 **pnpm**（dsh 用它解析 bundle 依赖）。脚本会检查 pnpm，若已装但不在 PATH（例如装完没重开终端），会自动把 npm 全局目录注入当前会话的 PATH；若确实没装：

```sh
npm install -g pnpm
# 或用 corepack：
corepack enable && corepack prepare pnpm@latest --activate
```

```sh
dsh --profile web --dump-config   # web.searchProvider 应为 dsh-search-boost
dsh --profile web                 # 启动后内置 web_search 即走本插件引擎链
```

**无头端到端验证**（不启动 GUI）：在 profile 的 `cordis.patch.yml` 追加 headless-runner 插件行（`inject: [headlessStartup]` + `config.task: !!js ctx.headlessStartup.task`，见内置 `@deepseek-ai/dsh-headless` 的 patch），然后：

```sh
dsh --profile <name> "用 web_search 搜索 …"
```

## 备选：会话级动态插件（plugin-host.js）

`plugin-host.js` 是单文件动态插件形态（会话内 `cordis_define` 安装），**不替换**内置 `web_search`，适合单会话快速增强；bundle 形态（推荐）为部署级，内置 web_search 直接升级。

手动安装：启动 DSH 会话后，将 `plugin-host.js` 全文作为 `code.host` 传入：

```text
cordis_define(kind: "new", idPrefix: "sboost", code: { host: <plugin-host.js 全文> })
cordis_run(pluginId, packageId, mode: "run")
```

动态插件不跨进程存活，重启后需重新 define/run；磁盘缓存 `.search-boost-cache.json` 自动复用。

## 配置（API Key）

发布版**不含任何密钥**。bundle 运行在宿主进程，key 从以下来源按序加载：

1. `~/.dsh-search-boost-keys.json`（推荐）或工作区 `./.search-boost-keys.json`：

```json
{
  "tavily": "tvly-...",
  "exa": "...",
  "brave": "..."
}
```

2. 环境变量回退：`TAVILY_API_KEY` / `EXA_API_KEY` / `BRAVE_API_KEY`

缺 key 的引擎自动从并行列表剔除。**免费引擎无需任何配置**：Antigravity CLI（macOS/Linux 装一次、浏览器登录一次）、Bing、DuckDuckGo、Exa MCP（exa-free）开箱即用，且无 key 引擎并行运行——单个引擎失败不会让你空手而归。`free` 层只调无 key 引擎，`api` 层加入配置了 key 的 Tavily / Brave / Exa。

### x_search 凭据（可选）

`x_search` 零凭据即可用——直接走多引擎路由（限 x.com）+ oEmbed 全文，用户结构化资料走匿名 guest GraphQL。**官方托管路径**（xAI `x_search` 工具，实时站内搜索 + 高级语法）是显式开关：

| 命令 | 作用 |
|---|---|
| `/x-login` | 把你的 grok 登录（`~/.grok/auth.json`）导入 `~/.dsh-search-boost-xauth.json`，此后走官方路径（OIDC 自动刷新，尽力同步回 grok 文件）。需要 SuperGrok / X Premium+ 订阅 |
| `/x-login -k <XAI_API_KEY>` | 同上，但用 console.x.ai 的 API key（公开 `api.x.ai` 端点） |
| `/x-login status` | 查看凭据链（env key → 本地副本 → grok 文件存在但未导入） |
| `/x-logout` | 删除本地副本——官方路径禁用，`x_search` 回到免凭据链。**永不触碰 grok CLI 自己的登录** |

`~/.grok/auth.json` **不会被自动消费**：没有显式 `/x-login`（或 `XAI_API_KEY` 环境变量）时，`x_search` 只用免凭据链。路由：`keyword`/`semantic` → 托管 x_search ∥ 多引擎并行、合并去重（无凭据时多引擎 + oEmbed 约 2s）；`user` → guest GraphQL 结构化资料 + 时间线 → 多引擎账号链接；`thread` → oEmbed 单条全文。

## 实测基准（2026-08，Windows + headless）

| 场景 | 数据 |
|---|---|
| `dsh plugin add` 安装 + patch 层生效 | ✓（dump-config 确认 searchProvider 改写 + 插件行插入） |
| headless 端到端 web_search | ✓（profile 内嵌 headless-runner，走 bing 免费引擎链） |
| 无 key 并行 | simple 档零 key：bing + DuckDuckGo + exa-free 并行；agy 从 medium 档加入；跨引擎命中（ddg+exa-free）排名高于单引擎命中 |
| SSRF 与 Clash TUN fake-ip | 字面量 198.18/15（RFC 2544 基准段）一律拦截；主机名解析整体落入 198.18/15 时视为 TUN fake-ip 放行（真实连接由 TUN 设备路由）；`DSH_SEARCH_ALLOW_TUN_FAKEIP=0` 可关闭豁免。实测：fake-ip 机器上 fetch_page github.com 953ms（Jina） |
| deep_research（bundle） | 单轮 18s：tokio v1.53.1 结论 + 跨源佐证 + gaps/suggested_queries 完整 |
| research_parallel（bundle） | 2 子代理并行 53.6s：10 个一手源（changelog/crates.io/GitHub 三处交叉一致） |
| x_search（免凭据） | 零凭据：keyword 走多引擎（site:x.com）+ oEmbed 全文增强，约 2-5s；user 走 guest GraphQL（结构化资料 + 最近时间线含互动数，实测 @NASA 92M 粉丝）；thread 走 oEmbed 全文 |
| x_search（官方路径） | `/x-login` 后：托管 xAI 工具直连 Responses API（零子进程）——keyword 返回实时帖子（含互动），user 返回结构化账号数据；与多引擎路由并行并合并（实测 7 条 = 托管 3 + 引擎补充 4，去重后） |
| x_search 凭据生命周期 | 默认（未 `/x-login`）→ 即使 `~/.grok/auth.json` 存在也禁用官方路径；`/x-login` → 启用；`/x-logout` → 再禁用，降级链依然完整可用 |

## 架构要点

- bundle 运行在宿主进程：Node `fetch` / `child_process` 直用，无沙箱 shell 绕行（对比会话级插件需要 `ctx.shell.run` + 引号处理）
- patch 层覆盖 `web.searchProvider` 是整个集成的关键：内置 web_search 的 schema/UI 不变，后端换成引擎链
- X 搜索三层结构：(1) **官方托管路径**（`lib/xsearch.js`）直接 POST Responses API、携带托管 `x_search` 工具——零 grok 子进程；凭据只来自 `/x-login` 或 `XAI_API_KEY`；(2) **免凭据链**（`lib/xfallback.js`）按 type 路由：多引擎（限 x.com）+ oEmbed 全文、guest GraphQL 结构化用户、oEmbed 线程——带 IPv4 强制 DNS（Windows undici 修复）、2h 缓存的 guest token、404 时 query id 自愈；(3) 同步毫秒级凭据预检：官方路径未启用时直接走免凭据链，不等超时
- X 相关 fetch 全部走 `lib/xfallback.js` 的 IPv4 强制 `https.Agent`（Windows 上 undici 默认 IPv6 优先 DNS，对 bing.com / x.com 会间歇性连接超时）

## 文件

```
index.js                    — bundle 插件入口（provider 注册 + 工具注册 + 命令 + 守则注入）
lib/engines.js              — key 加载 + 引擎链 failover
lib/exa-free.js             — Exa MCP 无 key 引擎（free 层质量腿）
lib/layer.js                — free/api 搜索层状态，/web_change 切换（落盘）
lib/fusion.js               — 融合打分 / 分档表 / 缓存
lib/fetch.js                — Jina Reader + 本地回退 + focus 提取
lib/xauth.js                — x_search 凭据链（/x-login 状态、OIDC 刷新、/x-logout）
lib/xsearch.js              — x_search 官方路径：直连 Responses API（托管工具，零子进程）
lib/xfallback.js            — x_search 免凭据链：多引擎 + oEmbed + guest GraphQL（IPv4 agent、guest token 缓存、query id 自愈）
lib/research.js             — deep_research 单轮 + research_parallel 扇出
lib/policy.js               — 主动搜索守则文本
cordis.patch.yml            — patch 层（web.searchProvider + 插件行）
package.json                — bundle 清单（dsh.bundle.patch）
install.ps1 / install.sh    — 一键安装脚本
scripts/verify-publish.mjs  — 发布前门禁（语法 + 测试 + 工作树干净）
search-boost-keys.example.json — key 配置文件示例
plugin-host.js              — 备选会话级动态插件（完整源码）
```

## 发布（维护者）

```sh
npm test      # 跑测试套件
npm publish   # prepublishOnly 门禁：语法 + 测试 + 工作树干净
```

`npm publish` 会自动执行 `prepublishOnly` 门禁：语法错误、测试失败、工作树不干净（有未提交改动）都会中止发布（`DSH_SB_ALLOW_DIRTY=1` 可强制放行），保证 registry 上的包与已提交的仓库永远一致。发布后 `dsh plugin add dsh-search-boost` 即可安装该版本。

## License

MIT

## 友链

- [Linux.do](https://linux.do/) — 开源技术社区
