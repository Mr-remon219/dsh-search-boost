# dsh-search-boost

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）搜索增强插件 —— 多引擎融合搜索、正文抓取、X 搜索、深度研究、多 agent 并行研究、主动搜索守则。

一个面向 DSH 的 **bundle 插件**：升级内置 `web_search`，并注册一整套搜索工具：

- 免费引擎**并行**：**Antigravity CLI / Bing / DuckDuckGo**（全部无 key），keyed 引擎 **Tavily / Brave / Exa** 在配置 key 后加入。
- 融合排序：跨引擎共现打分 + 半衰期时效衰减。
- 由主 agent 驱动的深度研究，以及扇出到 DSH 原生 subagent 的并行研究。

## 特性

| 能力 | 说明 |
|---|---|
| **内置 web_search 升级** | 注册 `WebSearchProvider` 并 patch 改写 `searchProvider`，内置 `web_search` 直接跑在本插件的免费优先引擎链上（保留原生引用卡片） |
| `fused_search` | 多引擎融合检索：免费引擎**并行**（Antigravity CLI / Bing / DuckDuckGo —— 全部无 key，其中两个是纯 curl 抓取），keyed 引擎在配置 key 后加入（Tavily / Brave / Exa）。复杂度路由、Grok 风格查询预处理（`site:` / `OR` / 引号）、域名硬过滤、半衰期时效衰减、跨引擎共现打分、6h TTL 缓存 |
| `x_search` | X/Twitter 搜索：通过本地 Grok Build CLI 借道（`~/.grok/auth.json` 登录态），返回结构化证据（summary + 帖子列表 + 不确定性）；无订阅时 45s 超时降级，不阻塞调用 |
| `fetch_page` | Jina Reader 正文抓取 + 本地 HTML 回退 + `focus` 定向提取（省 ~90% token）+ 24h 缓存 |
| `deep_research` | step 模式深研：complex 融合检索 + 覆盖度分析 + 跨域佐证统计 + 缺口 + 建议查询，**由主 agent 驱动多轮直至收敛** |
| `research_parallel` | 多 agent 并行深研：子查询分解 → 并行派 DSH 原生 subagent（每代理独立上下文，继承 `fused_search` / `fetch_page`）→ 时间预算 → 来源合并 |
| `search_stats` | 缓存 / 分档 / 引擎可用性 / grok 状态审计 |
| 搜索守则 | `systemPrompt.section` 正规注入：时效事实必搜、技术论断验证、X 内容路由 `x_search`、停止条件、成本感知（免费引擎优先） |

## 安装（bundle，推荐）

**一条命令**（发布后，或本地 git 源）：

```sh
dsh plugin add github:Mr-remon219/dsh-search-boost    # 发布后
dsh plugin --profile web add git+file:///path/to/repo # 本地 git 源（协议已实测）
```

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

缺 key 的引擎自动从并行列表剔除。**免费引擎无需任何配置**：Antigravity CLI（macOS/Linux 装一次、浏览器登录一次）、Bing（零配置）、DuckDuckGo（零配置）开箱即用，且无 key 引擎并行运行——单个引擎失败不会让你空手而归。X 搜索需要本机装有 Grok Build 且已登录（SuperGrok / X Premium 订阅）。

## 实测基准（2026-08，Windows + headless）

| 场景 | 数据 |
|---|---|
| `dsh plugin add` 安装 + patch 层生效 | ✓（dump-config 确认 searchProvider 改写 + 插件行插入） |
| headless 端到端 web_search | ✓（profile 内嵌 headless-runner，走 bing 免费引擎链） |
| 无 key 并行 | simple 档零 key：bing + DuckDuckGo 并行（实测 1.7s，6 条融合结果，0 引擎错误）；装了 agy 则加入；keyed 引擎进一步提质 |
| deep_research（bundle） | 单轮 18s：tokio v1.53.1 结论 + 跨源佐证 + gaps/suggested_queries 完整 |
| research_parallel（bundle） | 2 子代理并行 53.6s：10 个一手源（changelog/crates.io/GitHub 三处交叉一致） |
| x_search 超时降级 | 45.09s 精确超时，错误信息明确，不阻塞 |
| grok json-schema 模式 | 17s 返回 envelope（需要订阅的 X 搜索除外） |

## 架构要点

- bundle 运行在宿主进程：Node `fetch` / `child_process` 直用，无沙箱 shell 绕行（对比会话级插件需要 `ctx.shell.run` + 引号处理）
- patch 层覆盖 `web.searchProvider` 是整个集成的关键：内置 web_search 的 schema/UI 不变，后端换成引擎链
- X 搜索抄自 [liustack/modsearch](https://github.com/liustack/modsearch)（MIT）：`grok -p --always-approve --json-schema`，`structuredOutput` 为 null 时从 `text` salvage 契约对象

## 文件

```
index.js                    — bundle 插件入口（provider 注册 + 工具注册 + 守则注入）
lib/engines.js              — key 加载 + 引擎链 failover
lib/fusion.js               — 融合打分 / 缓存
lib/fetch.js                — Jina Reader + 本地回退 + focus 提取
lib/grok.js                 — X（Twitter）搜索（Grok Build CLI）
lib/research.js             — deep_research 单轮 + research_parallel 扇出
lib/policy.js               — 主动搜索守则文本
cordis.patch.yml            — patch 层（web.searchProvider + 插件行）
package.json                — bundle 清单（dsh.bundle.patch）
install.ps1 / install.sh    — 一键安装脚本
search-boost-keys.example.json — key 配置文件示例
plugin-host.js              — 备选会话级动态插件（完整源码）
```

## License

MIT
