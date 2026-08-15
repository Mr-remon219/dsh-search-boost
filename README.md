# dsh-search-boost

> DeepSeek Harness (DSH) 网络搜索增强插件 —— 多引擎融合搜索、正文抓取、X 搜索、深度研究、多 agent 并行研究、主动搜索守则。

A bundle plugin for DeepSeek Harness: multi-engine fused search (free-by-default Antigravity CLI / Bing chain with Tavily / Brave / Exa failover), focused page fetching, X (Twitter) search via Grok Build, step-mode deep research, parallel multi-agent research, and an injected proactive-search policy.

## 特性

| 能力 | 说明 |
|---|---|
| **内置 web_search 升级** | 通过 `WebSearchProvider` 注册 + patch 改写 `searchProvider`，内置 `web_search` 直接跑在本插件的免费优先引擎链上（保留原生引用卡片） |
| `fused_search` | 多引擎融合检索：免费引擎优先（Antigravity CLI → Bing），keyed 引擎 failover（Tavily → Brave → Exa）。复杂度路由、Grok 风格查询预处理（`site:` / `OR` / 引号）、域名硬过滤、半衰期时效衰减、跨引擎共现打分、6h TTL 缓存 |
| `x_search` | X/Twitter 搜索：通过本地 Grok Build CLI 借道（`~/.grok/auth.json` 登录态），返回结构化证据（summary + 帖子列表 + 不确定性）；无订阅时 45s 超时降级，不阻塞调用 |
| `fetch_page` | Jina Reader 正文抓取 + 本地 HTML 回退 + `focus` 定向提取（省 ~90% token）+ 24h 缓存 |
| `deep_research` | step 模式深研：complex 融合检索 + 覆盖度分析 + 跨域佐证统计 + 缺口 + 建议查询，**由主 agent 驱动多轮直至收敛** |
| `research_parallel` | 多 agent 并行深研：子查询分解 → 并行派 DSH 原生 subagent（每代理独立上下文，继承 fused_search/fetch_page）→ 时间预算 → 来源合并 |
| `search_stats` | 缓存 / 分档 / 引擎可用性 / grok 状态审计 |
| 搜索守则 | `systemPrompt.section` 正规注入：时效事实必搜、技术论断验证、X 内容路由 x_search、停止条件、成本感知（免费引擎优先） |

## 安装（bundle，推荐）

```sh
# 从本地目录
dsh plugin --profile web add ./dsh-search-boost

# 或从 GitHub（发布后）
dsh plugin add github:<你的用户名>/dsh-search-boost
```

首次使用会初始化 profile 并 pnpm 链接本包。验证：

```sh
dsh --profile web --dump-config   # web.searchProvider 应为 dsh-search-boost
dsh --profile web                 # 启动后内置 web_search 即走本插件引擎链
```

**无头端到端验证**（不启动 GUI）：在 profile 的 `cordis.patch.yml` 追加 headless-runner 插件行（`inject: [headlessStartup]` + `config.task: !!js ctx.headlessStartup.task`，见内置 `@deepseek-ai/dsh-headless` 的 patch），然后 `dsh --profile <name> "用 web_search 搜索 …"` 直接跑任务验证。

## 备选：会话级动态插件（plugin-host.js）

`plugin-host.js` 是单文件动态插件形态（会话内 `cordis_define` 安装），不替换内置 `web_search`，适合单会话快速增强；bundle 形态（推荐）为部署级，内置 web_search 直接升级。

## 配置（API Key）

bundle 运行在宿主进程，key 从以下来源按序加载：

1. `~/.dsh-search-boost-keys.json`（推荐）或工作区 `./.search-boost-keys.json`：

```json
{
  "tavily": "tvly-...",
  "exa": "...",
  "brave": "..."
}
```

2. 环境变量回退：`TAVILY_API_KEY` / `EXA_API_KEY` / `BRAVE_API_KEY`

缺 key 的引擎自动从链上剔除。**免费引擎无需任何配置**：Antigravity CLI（macOS/Linux 装一次、浏览器登录一次）与 Bing（零配置）开箱即用；X 搜索需要本机装有 Grok Build 且已登录（SuperGrok / X Premium 订阅）。

## 实测基准（2026-08，Windows + headless）

| 场景 | 数据 |
|---|---|
| `dsh plugin add` 安装 + 层生效 | ✓（dump-config 确认 searchProvider 改写 + 插件行插入） |
| headless 端到端 web_search | ✓（profile 内嵌 headless-runner，走 bing 免费引擎链） |
| 免费链 failover | 无 agy 时自动落到 Bing；tavily key 就绪时融合质量显著提升 |
| deep_research（bundle） | 单轮 18s：tokio v1.53.1 结论 + 跨源佐证 + gaps/suggested_queries 完整 |
| research_parallel（bundle） | 2 子代理并行 53.6s：10 个一手源（changelog/crates.io/GitHub 三处交叉一致） |
| x_search 超时降级 | 45.09s 精确超时，错误信息明确，不阻塞 |
| grok json-schema 模式 | 17s 返回 envelope（需要订阅的 X 搜索除外） |

## 架构要点

- bundle 运行在宿主进程：Node fetch / child_process 直用，无沙箱 shell 绕行（对比会话级插件需要 `ctx.shell.run` + 引号处理）
- patch 层覆盖 `web.searchProvider` 是整个集成的关键：内置 web_search 的 schema/UI 不变，后端换成引擎链
- X 搜索抄自 [liustack/modsearch](https://github.com/liustack/modsearch)（MIT）：`grok -p --always-approve --json-schema`，`structuredOutput` 为 null 时从 `text` salvage 契约对象

## License

MIT


## 安装（DSH 动态插件）

### 一键安装（推荐）

```powershell
# Windows
.\install.ps1                 # 交互式配置 key（可回车跳过，用无 key 引擎）
.\install.ps1 -KeysFile .\my-keys.json
```

```bash
# Linux / macOS
./install.sh
./install.sh --keys ./my-keys.json
```

脚本会：校验源码语法 → 生成 key 配置（可选）→ 生成安装指令并复制到剪贴板。
**最后一步**：把安装指令粘贴给 DSH 助手（DSH 动态插件只能在会话内由助手执行 `cordis_define` 安装，无外部安装通道），助手即完成安装并用 `search_stats` 验证。

### 手动安装

插件本体是一个 Host half 动态 Cordis 插件。启动 DSH 会话后，将 `plugin-host.js` 全文作为 `code.host` 传入：

```text
cordis_define(kind: "new", idPrefix: "sboost", code: { host: <plugin-host.js 全文> })
cordis_run(pluginId, packageId, mode: "run")
```

重启进程后需重新 define/run（动态插件不跨进程存活）；磁盘缓存 `.search-boost-cache.json` 自动复用。

## 配置（API Key）

发布版**不含任何密钥**，引擎 key 从以下来源按序加载：

1. **配置文件**（推荐）：工作区下 `.search-boost-keys.json` 或 `search-boost-keys.json`：

```json
{
  "tavily": "tvly-...",
  "exa": "...",
  "brave": "..."
}
```

2. **环境变量**回退：`TAVILY_API_KEY` / `EXA_API_KEY` / `BRAVE_API_KEY`

缺 key 的引擎自动从可用列表剔除；`bing`（HTML 抓取）与 `deepseek`（DSH 原生 web 服务）无需 key，永远可用。

## 实测基准（2026-08，主会话）

| 场景 | 数据 |
|---|---|
| fused_search 冷缓存（medium） | 1.5–3.1s，6 结果，官方源居首（x.ai 3.73 分跨引擎共现） |
| fused_search 热缓存 | **8ms** |
| deep_research 单轮 | ~9.1s 收敛，学术级来源（WUSTL / Stony Brook 论文、Springer） |
| research_parallel | 3 子代理并行 74.8s，18 合并来源，跨域佐证（RustSec 通告 + crates.io 一手 API） |
| 引擎错误 | 0 |

## 架构要点与踩坑（Windows 沙箱）

- 动态 Host 沙箱无 `fetch`/`process`/`URL`：HTTP 经 `ctx.shell.run` 跑 curl，POST body 用 `-d '<单引号 JSON>'`（`@file`/`stdin`/`cmd.exe` 路径在插件 shell 会被引号解析破坏）
- `shell.resolve` 与 `fs.writeText` 必须显式传会话 `sandboxPolicy`（镜像 dsh-tool-pwsh 的解析方式），否则 executor 默认受限模式拒跑
- 工具 value schema 严格：property 级 `required: true`、object 需显式 `additionalProperties`、null 字段省略
- 主动搜索守则与工具会自动传播给 subagent（实测子代理无指示自动完成 fused_search × 2 + fetch_page × 8 深研链）

## 文件

```
plugin-host.js              — 插件完整源码（cordis_define 的 code.host）
search-boost-keys.example.json — key 配置文件示例
```

## License

MIT
