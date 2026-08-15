# dsh-search-boost 优先修改清单（供审计）

基线：`d22f890`（v0.0.1 / `main`）。  
对照：三份 Cloud Agent 调研（两份「项目优化研究」+ 一份「项目优化方案」）+ 本仓库源码复核。  
回归：`npm test` / `node scripts/verify-audit.mjs`（修复后应变为全部通过）。

**本轮已修：** P0-1、P0-2、P0-3、P1-4、P1-5、P1-6、P1-7、P1-8、P1-9、P1-11、P1-12、P1-13。  
**刻意未修：** P1-10（`WebFetchProvider`，需对齐官方结果形状后再做）、P2-14（`plugin-host.js` `debug_shell`）。

本清单只列**现在最该改**的项。RRF 换分、Firecrawl/Exa 匿名腿、npm 发布、目录收录**不在本轮**——那些是提质和分发，不是正确性。

## 0. 审计决策表

请在「本轮做」打勾。建议本轮只做 **P0 全部 + P1-4/5/6/7/8/11/13**。

| ID | 严重度 | 一句话 | 本轮做 | 同意修 |
|---|---|---|---|---|
| P0-1 | 安全 | `fetch_page` 能读 `127.0.0.1` / 内网 | ☐ | ☐ |
| P0-2 | 正确性 | `research_parallel` 的 `max_seconds` 在 timer 未接通时是空的 | ☐ | ☐ |
| P0-3 | 正确性 | 返回给模型的 URL 被整串小写，大小写敏感链接变 404 | ☐ | ☐ |
| P1-4 | 质量 | `fetch_page` 缓存键含 `focus`，换 focus 重抓 | ☐ | ☐ |
| P1-5 | 正确性 | `deep_research` 的 `complexity:'complex'` 被忽略，还会打无 key 引擎 | ☐ | ☐ |
| P1-6 | 正确性 | `fused_search` 缓存键不含档位 | ☐ | ☐ |
| P1-7 | 质量 | `www` 与裸域不去重，融合信号被拆散 | ☐ | ☐ |
| P1-8 | 一致性 | 内置 `web_search` 钉死 simple，且不走共享缓存 | ☐ | ☐ |
| P1-9 | 契约 | provider 收下 `signal` 从不转发 | ☐ | ☐ |
| P1-10 | 集成 | 未注册 `WebFetchProvider` | ☐ | ☐ |
| P1-11 | 审计 | `search_stats` 漏掉 `ddg` | ☐ | ☐ |
| P1-12 | 漂移 | bundle 冲突时留更短正文（输出层目前会丢掉 content） | ☐ | ☐ |
| P1-13 | 延迟 | simple 档默认带 45s `agy`，`Promise.all` 被拖死 | ☐ | ☐ |
| P2-14 | 安全/债务 | `plugin-host.js` 的 `debug_shell` 可跑任意命令 | ☐ | ☐ |

**不要在本轮做的：** 换 RRF、加 SearXNG/Firecrawl/百度腿、设置页 UI、代理、awesome 目录 PR、把 `plugin-host.js` 整文件重写。定位继续守「免费并行融合 + 政策注入 + 原生 subagent」，不要去卷 `dsh-web-search-pro` 的平台覆盖。

---

## 1. P0 —— 不修会伤用户或伤机器

### P0-1 `fetch_page` 无 SSRF 防护

**文件：** `lib/fetch.js`（只校验 `^https?://`，然后 `fetch(url)` / `r.jina.ai/${url}`）

**已复现：** 本地回环服务返回 `INTERNAL ADMIN TOKEN=s3cr3t-abcdef`，Jina 403 后走 local fallback，**原文进了模型**。代码里没有任何 `127.0.0.1` / `169.254.169.254` / 私网段检查。

**为什么是真威胁：** 搜索结果和网页正文都是不可信输入。插件自己的政策要求「疑问即搜索」「对关键来源 `fetch_page`」。页面里写一句「详情见 http://169.254.169.254/latest/meta-data/」就可能被跟过去。DSH 官方本地 fetch **不**挡内网，这层必须插件自己做。

**建议改法：**

- 只允许 `http`/`https`，拒绝带 userinfo 的 URL。
- `dns.lookup` 之后拒绝回环 / 链路本地 / 私网 / ULA（`127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7`）。
- 手动跟随重定向，**每一跳重新解析再校验**（防 DNS rebinding）。
- 正文加字节上限。
- 文档写明：走 Jina 时 URL 会发给第三方。

**不建议：** 只写一个 hostname 黑名单（`localhost` 字符串挡不住 `127.0.0.1` / DNS 指向内网的公网名）。

### P0-2 `research_parallel` 时间预算是空的

**文件：** `lib/research.js` `ctxTimer()` + `index.js` `setTimer((ms) => ctx.timeout(ms))`

**已复现：** 不调用 `setTimer`（等同 `apply()` 里 `ctx.timeout` 抛错被吃掉），`maxSeconds=1` 的假 subagent **2.5s 仍未返回**。

根因：

```js
timerPromise ?? new Promise(() => {})   // timer 缺失 → 永远等 subagent
Promise.race([r.run.result, ctxTimer(deadline)?.then(...)])  // undefined 参与 race 会立刻变成 resolve(undefined)
```

**建议改法：**

- `timerFn` 缺失时回落到 `setTimeout` + `unref()`。
- 禁止把 `undefined` 丢进 `Promise.race`。
- 超时后 `dispose()` 未完成的 run，并给该 task 标 `timeout`。
- 给这段加一个永不 resolve 的假 subagent 单测（本仓库的 `scripts/verify-audit.mjs` P0-2 可直接改成 `node:test`）。

### P0-3 规范化 URL 被当成展示 URL

**文件：** `lib/fusion.js` `normalizeUrl()` 最后 `.toLowerCase()`；`fusedSearch` 把 `norm` 既当去重键又当 `url` 输出。

**已复现：**

```
raw         https://raw.githubusercontent.com/nodejs/node/main/README.md?Foo=Bar#Section
normalized  https://raw.githubusercontent.com/nodejs/node/main/readme.md?foo=bar
HEAD        raw=200  normalized=404
```

GitHub raw、S3 key、部分文档路径是大小写敏感的。模型拿到 404 URL 再 `fetch_page`，整条证据链断掉。

**建议改法：**

- 去重键：host 小写、剥 `www.`、去 fragment、去 `utm_*` 等跟踪参数、去末尾 `/`。**不要**小写 path/query。
- 输出：保留**第一次见到的原始 URL**。
- 顺手把 `www` / 裸域收进同一个键（见 P1-7）。

---

## 2. P1 —— 本轮值得一起修（改动面小、收益直接）

### P1-4 `fetch_page` 缓存键含 focus

`lib/fetch.js` 注释写「缓存存 RAW，focus 读取时过滤」，实际键是 `` page:${url}#${focus} ``。同一 URL 换 focus 必重抓。

**改法：** 键只用规范化后的 URL；缓存存原文；`focusFilter` 只在返回时跑。

### P1-5 `deep_research` 档位是死参数

`lib/research.js` 传 `complexity: 'complex'`，`fusedSearch` 只认 `tier`，默认 `'auto'`。  
探针查询 `tokio release notes` → `estimateComplexity` = **medium**，实际打了 `bing,ddg,antigravity,tavily`，不是 complex。  
同时 `.filter((e) => runOne)` 恒真，无 key 时仍会调用 tavily/brave/exa，`engineStats` 里常年挂假错误。  
`queriesUsed` 读 `fused.queriesUsed`，融合层根本不返回这个字段。

**改法：** `tier: 'complex'`；按 `available()` 过滤；`fusedSearch` 返回 `queriesUsed`。

### P1-6 / P1-8 缓存与 `web_search` 言行不一

`fused_search` 缓存键有 query / engines / 过滤 / recency / maxResults，**没有 tier**。先 simple 再 complex，6 小时内吃到旧结果。

`registerSearchProvider` 硬编码 `tier: 'simple'`，且**不碰** `SEARCH_CACHE`。README / 提交信息里的「shared 6h cache」不成立；用户配了 Tavily key，被 patch 接管的内置 `web_search` 也用不上。

**改法：** 键补 `tier`（建议 `v: 2`）；provider 与工具共用 `SEARCH_CACHE`；provider 用 `estimateComplexity(request.query)` 而不是钉死 simple。

### P1-7 `www` 拆散融合

`hostOf()` 剥了 `www.` 只写进 `domain` 字段，去重键仍带 `www.`。  
探针：bing 给 `https://www.example.com/page`，ddg 给 `https://example.com/page` → **两条结果、同一 domain**，本该 +0.8 的跨引擎加分变成两条各自 ×0.9 的单引擎折扣。这正好打在项目最核心的融合逻辑上。

**改法：** 与 P0-3 同一套去重键（host 去 `www.`）。

### P1-11 `search_stats` 漏 `ddg`

`index.js` 的审计输出只有 `antigravity / bing / tavily / brave / exa`。`ddg` 是默认免费腿之一。补一行即可。

### P1-13 simple 档被 agy 拖到 45s

`TIER_ENGINES.simple = ['bing', 'ddg', 'antigravity']`，`agy` 内部 `AGY_TIMEOUT_MS = 45_000`，融合用 `Promise.all` 等最慢的一条。装了 agy 的机器上，一次「平凡查询」可能从 ~2s 变成 ~45s。

**改法（选一，建议 A）：**

- A. simple 默认只有 `bing+ddg`；agy 从 medium 起加入。
- B. 保留 agy，但 simple 用「先到先用」：免费 HTML 腿完成后即可返回，agy 超时只记统计、不挡结果。

政策文本里「simple 档 1 查询×2 引擎」也和现状（3 引擎含 CLI）不一致，改完一起改文案。

### P1-9 / P1-10 官方 seam 没对齐（可放到第二轮）

- `search(request, signal)` 的 `signal` 从未传给引擎；取消操作无效。
- 未 `registerFetchProvider`，内置 `web_fetch` 仍是官方实现；`surfing-plugin` 是 search+fetch 双注册。
- provider 的 `content` 现在是调试串 `[dsh-search-boost] 6 sources from bing+ddg`，浪费官方留给模型的摘要位。

这两条不修也能用，但和「升级内置 web_search」的产品承诺差一截。建议 **P0 合并之后**立刻做，不要和 RRF 绑在一起。

### P1-12 更短正文（低优先级）

`lib/fusion.js`：`existing.content.length > hit.content.length` 时覆盖 → 留更短的。  
`plugin-host.js` 是反的（留更长）。融合输出目前会剥掉 `content`，所以**用户暂时看不到**，但是两套实现已经在漂移。跟 P0-3 同一文件时顺手改掉即可。

---

## 3. P2 —— 记下来，本轮可以不做

| 项 | 说明 |
|---|---|
| P2-14 `debug_shell` | 会话插件可执行任意命令。bundle 形态没有这个工具。若还宣传 `plugin-host.js`，应删掉或加显式开关，默认关。 |
| 零测试 / 零 CI | `install.sh` 只做 `node --check`。Bing/DDG HTML 一改结构就静默空结果。下一步用 `node:test` 吃掉 `scripts/verify-audit.mjs`。 |
| 缓存无上限、bundle 无磁盘 | `plugin-host.js` 有 `.search-boost-cache.json`，bundle 重启即丢。先加 LRU，磁盘可后做。 |
| 死代码 | `runChain()` 已无人调用；`research.js` 导入了不用的 `estimateComplexity`；`renderX` 的 `degraded` 不可达（`searchX` 只 `ok` 或抛错）。 |
| README 与行为 | `x_search` 写「45s 超时降级」，实际是抛错；工具 `timeoutMs: 180000` 与内部 45s 不一致。 |
| `AGY_MODEL` 写死 | `gemini-3.6-flash-low` 改名整条腿失效。 |
| 无 Config / 设置页 | key 只能手写 JSON；`dsh-jina` 有 `installSettingsSection`。 |
| 两套实现 | `plugin-host.js` 1408 行与 `lib/` 已分叉（磁盘缓存、deepseek 引擎、content 合并、无 ddg/agy）。应降级为「历史形态」或改成从 `lib/` 生成。 |
| 分发 | 未打 `dsh-plugin` topic、未发 npm、四大 awesome 目录未收录。这是曝光问题，不是功能问题。 |

---

## 4. 建议落地顺序（每一刀都能单独合并）

1. **P0-1 + P0-2 + P0-3 + P1-7**（`lib/fetch.js` / `lib/fusion.js` / `lib/research.js`）—— 安全与 URL 正确性，带上 `scripts/verify-audit.mjs` 转成的回归测试。
2. **P1-4 + P1-5 + P1-6 + P1-8 + P1-11 + P1-13**（`index.js` + 融合/研究入口）—— 缓存、档位、simple 延迟、统计。
3. **P1-9 + P1-10** —— 把 `signal` 和 `WebFetchProvider` 补齐，内置工具才算真正升级。
4. 之后才谈 RRF、免费腿扩容、设置页、分发。

---

## 5. 复现命令

```sh
node scripts/verify-audit.mjs
```

脚本只 import 生产模块，不改源码。P0-1 会在本机起一个回环 HTTP 服务再拆掉；P0-3 会对 GitHub raw 发两次 `HEAD`（`README.md` → 200，小写 → 404）。修完对应项后，该条应变为 `NOT REPRODUCED`。
