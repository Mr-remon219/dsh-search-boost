# dsh-search-boost

> Search boost for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): multi-engine fused search, focused page fetching, X (Twitter) search, step-mode deep research, parallel multi-agent research, and an injected proactive-search policy.

A **bundle plugin** for DSH that upgrades the built-in `web_search` / `web_fetch` and registers a family of search tools.

> **search-boost family**
>
> | Project | For | Link |
> |---------|-----|------|
> | [**search-boost**](https://github.com/Mr-remon219/search-boost) | Cursor · Codex · Claude · Grok · Antigravity via MCP | [GitHub](https://github.com/Mr-remon219/search-boost) · [npm](https://www.npmjs.com/package/search-boost-mcp) |
> | [**dsh-search-boost**](https://github.com/Mr-remon219/dsh-search-boost) *(this repo)* | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle plugin | you are here |
> | [**pi-search-boost**](https://github.com/Mr-remon219/pi-search-boost) | [pi](https://github.com/earendil-works/pi-coding-agent) extension | [GitHub](https://github.com/Mr-remon219/pi-search-boost) · [npm](https://www.npmjs.com/package/pi-search-boost) |

Search engines live in **`lib/`**: on the **free** layer, Bing, DuckDuckGo, Yahoo, and Exa-free run in parallel; the **api** layer adds Antigravity CLI (when available) and keyed Tavily / Brave / Exa when keys are present (one key is enough; all three recommended for best fusion).

中文文档 → [README_zh.md](./README_zh.md)

---

## Search layers

Two layers, switched at runtime with `/web_change` (persisted to `~/.dsh-search-boost-layer.json`):

| Layer | Engines dialed | When to use |
|---|---|---|
| **`free`** (keyless only) | **Bing + DuckDuckGo + Yahoo + Exa MCP (exa-free)** — all live-probed, no API keys | Research loops, zero-cost runs, privacy-conscious use |
| **`api`** (default) | Same keyless legs **plus** Antigravity CLI (when `agy` is on PATH) and keyed **Tavily / Brave / Exa** (when keys are present) | Maximum recall; cross-engine corroboration with paid APIs |

Keyless engines run **in parallel** so one failure never leaves you empty-handed. Fused ranking adds cross-engine co-occurrence scoring and half-life time-decay freshness.

## Features

| Capability | Description |
|---|---|
| **Built-in `web_search` + `web_fetch` upgrade** | Registers `WebSearchProvider` + `WebFetchProvider` and patches both seam configs, so built-in search/fetch keep native citation cards while the backend runs on this plugin's engine chain and Jina-first page reader |
| `fused_search` | Multi-engine fused retrieval with complexity routing, Grok-style query preprocessing (`site:` / `OR` / quotes), domain filters, cross-engine scoring, and 6h TTL cache. Active layer via `/web_change`; per-call `layer` override supported |
| `/web_change` | `/web_change free` → keyless pool only; `/web_change api` → full pool; `/web_change show` → current layer + engine availability |
| `x_search` | Real-time X/Twitter: posts, users, threads. With credentials: hosted xAI tool ∥ multi-engine (site:x.com), merged and deduped. **Without credentials**: multi-engine + oEmbed full text (~2s), guest GraphQL user profiles, oEmbed threads. `/x-login` / `/x-logout` toggle the official path |
| `/x-login` | Import xAI credentials into `~/.dsh-search-boost-xauth.json` (from `~/.grok/auth.json` or `-k <XAI_API_KEY>`). OIDC auto-refresh; grok CLI login untouched |
| `/x-logout` | Remove `/x-login` credentials; `x_search` falls back to the credential-free chain |
| `fetch_page` | Jina Reader + local HTML fallback + `focus` topic extraction + 24h cache |
| `deep_research` | Step-mode deep research: complex fused search + coverage analysis + gaps + suggested queries, driven by the main agent in rounds |
| `research_parallel` | Sub-query decomposition → native DSH subagents in parallel → merged sources |
| `search_stats` | Cache / tier / engine availability / x_search credential audit |
| Search policy | Injected via `systemPrompt.section`: verify time-sensitive facts, route X content to `x_search`, prefer free engines |

## Installation (bundle — recommended)

**From npm (recommended):**

```sh
dsh plugin --profile web add dsh-search-boost          # latest
dsh plugin --profile web add dsh-search-boost@0.1.3    # pin a version
dsh plugin --profile web update dsh-search-boost       # update to a newer release
```

`--profile <name>` is **required** (`web` is the standard web-UI profile). DSH uses pnpm to resolve the package, auto-wires the `dsh.bundle.patch` layer, and adds it to the profile's bundle list — no manual config editing. Restart `dsh --profile web`.

**From source (development):**

```sh
dsh plugin --profile web add github:Mr-remon219/dsh-search-boost
dsh plugin --profile web add git+file:///path/to/repo
```

Or use the install script (syntax check → key setup → install → verification):

```powershell
.\install.ps1          # Windows
./install.sh           # Linux / macOS
```

Verify:

```sh
dsh --profile web --dump-config   # web.searchProvider → dsh-search-boost
dsh --profile web
```

### Troubleshooting: missing `dsh` or `pnpm`

If you run DSH via `npx @deepseek-ai/dsh web`, there is no global `dsh` binary — install globally or use npx directly:

```sh
npm install -g @deepseek-ai/dsh
# or:
npx --yes @deepseek-ai/dsh plugin --profile web add dsh-search-boost
```

`dsh plugin` needs **pnpm** (`npm install -g pnpm` or corepack).

## Alternative: session-level dynamic plugin (`plugin-host.js`)

`plugin-host.js` is a single-file dynamic plugin for per-session boosts. It does **not** replace built-in `web_search`. The bundle form (above) is recommended for deployment-level integration.

## Configuration (API keys)

The published bundle contains **no secrets**. Keys load from:

1. `~/.dsh-search-boost-keys.json` or `./.search-boost-keys.json`:

```json
{ "tavily": "tvly-...", "exa": "...", "brave": "..." }
```

2. Environment: `TAVILY_API_KEY` / `EXA_API_KEY` / `BRAVE_API_KEY`

Engines without a key are dropped from the fan-out automatically.

**Free layer needs zero configuration.** Bing, DuckDuckGo, Yahoo, and Exa MCP (exa-free) are keyless and run in parallel. Antigravity CLI (`agy`) is optional and only joins in the **`api`** layer (medium/complex tiers) when installed and signed in.

### x_search credentials (optional)

| Command | Effect |
|---|---|
| `/x-login` | Import grok login → official hosted x_search path (SuperGrok / X Premium+ tier) |
| `/x-login -k <XAI_API_KEY>` | Same via console.x.ai API key |
| `/x-login status` | Show credential chain |
| `/x-logout` | Disable official path; fallback chain still works |

`~/.grok/auth.json` is never auto-consumed. Without `/x-login` or `XAI_API_KEY`, `x_search` uses only the credential-free chain.

## Verified benchmarks (2026-08, Windows)

### Free-layer engine probe (12 queries × 9 candidates)

Live benchmark (`node scripts/engine-benchmark.mjs`); full report in `scripts/engine-benchmark-report.json`.

| Engine | Success | Avg latency | Verdict |
|---|---|---|---|
| bing | 100% | ~2.0s | ✅ free layer |
| ddg | 100% | ~2.2s | ✅ free layer |
| yahoo | 100% | ~2.3s | ✅ free layer (new in v0.1.2) |
| exa-free | 100% | ~4.2s | ✅ free layer |
| antigravity | 92% | ~27s | api layer only (slow, needs `agy` CLI) |
| brave-html / mojeek / searx | 0% | — | rejected (429, blocked, or unreachable) |

### Integration scenarios

| Scenario | Result |
|---|---|
| `free` layer fused_search | 5 hits in ~1.3–3.0s; cross-engine corroboration (e.g. yahoo+exa-free → score 3.29 on rust release notes) |
| `x_search` (no credentials) | keyword via multi-engine + oEmbed; user via guest GraphQL (@NASA ~2s); thread via oEmbed |
| SSRF vs Clash TUN fake-ip | Literal 198.18/15 blocked; TUN-routed hostnames allowed (`DSH_SEARCH_ALLOW_TUN_FAKEIP=0` to disable) |
| Headless `web_search` | ✓ free Bing/DDG/Yahoo/Exa chain |
| Unit + E2E tests | 57/57 unit tests; 14/14 black-box E2E |

## Architecture notes

- Runs in the **host process** (Node `fetch` / `child_process` directly).
- HTML scrapers (Bing / DDG / Yahoo) use **IPv4-forced fetch** — undici on Windows defaults to IPv6-first DNS, which intermittently times out against search hosts.
- X search: official path (`lib/xsearch.js`) → credential-free chain (`lib/xfallback.js`: multi-engine + oEmbed + guest GraphQL) with sync preflight when no credentials.

## Files

```
index.js                    — bundle entry (providers + tools + commands + policy)
lib/engines.js              — engine registry (bing / ddg / yahoo / exa-free / …)
lib/exa-free.js             — Exa MCP keyless engine
lib/layer.js                — free/api layer state (/web_change)
lib/fusion.js               — fusion scoring, tier tables, cache
lib/fetch.js                — Jina Reader + focus extraction
lib/xauth.js / xsearch.js / xfallback.js — x_search credential + official + fallback paths
lib/research.js             — deep_research + research_parallel
lib/policy.js               — proactive-search policy
cordis.patch.yml            — DSH patch layer manifest
scripts/engine-benchmark.mjs — maintainer: live free-engine probe
```

## Publishing (maintainers)

```sh
npm test
npm publish   # prepublishOnly: syntax + tests + clean git tree
```

## License

MIT

---

**Links:** [Issues](https://github.com/Mr-remon219/dsh-search-boost/issues) · [search-boost](https://github.com/Mr-remon219/search-boost) · [pi-search-boost](https://github.com/Mr-remon219/pi-search-boost)

**Friendly link:** [LINUX DO 社区](https://linux.do/)
