# dsh-search-boost

A zero-dependency ESM **bundle plugin** for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It upgrades the built-in `web_search` and registers a family of search tools (`fused_search`, `fetch_page`, `x_search`, `deep_research`, `research_parallel`, `search_stats`). See `README.md` for the product overview and `README_zh.md` for the Chinese version.

## Cursor Cloud specific instructions

Durable, non-obvious notes for working in this repo. Standard commands live in `README.md` / `install.sh`; this section only captures what is not obvious.

### What this is (and isn't)
- This is a **library/plugin**, not a standalone server or web app. There is no dev server to start. It is loaded into DSH's host process via `cordis.patch.yml` (see `package.json` `dsh.bundle.patch`), which registers the search provider + tools and repoints the `web` seam's `searchProvider`.
- Running it "for real" via `dsh plugin add` needs the DSH CLI **and** `pnpm`, and DSH itself needs a DeepSeek API key. Neither the CLI nor a key is present by default, so full DSH integration is not exercised here.

### Dependencies
- Zero runtime dependencies (`package.json` `dependencies` is empty). `npm install` is effectively a no-op but is the idempotent update step.
- Requires Node `>=22.13` (uses built-in global `fetch`, `AbortSignal.timeout`, ESM). The VM ships Node 22.x.

### Lint / test / build
- There is **no** lint config, no test framework, and no build step.
- The de-facto "lint" is a syntax check, mirroring `install.sh`: `node --check` on the bundle sources — `index.js` and `lib/*.js` (`engines.js`, `exa-free.js`, `layer.js`, `fusion.js`, `fetch.js`, `xauth.js`, `xsearch.js`, `xfallback.js`, `policy.js`, `research.js`). Note `research.js` is not in `install.sh`'s list but should also pass.
- **Do not** run `node --check plugin-host.js`: it intentionally fails ("Illegal return statement"). `plugin-host.js` is a session-level dynamic-plugin body (top-level `return`) passed as `code.host` to `cordis_define`, not a standalone module.

### Black-box E2E (no DSH CLI)
- `npm run test:e2e` runs `scripts/blackbox-e2e.mjs`: mock DSH ctx + `apply()`, then exercises every user surface (commands, built-in `web_search`/`web_fetch`, all tools) against live free engines. Report written to `/opt/cursor/artifacts/blackbox_e2e_report.json` when available.

### How to exercise it end-to-end without the DSH CLI
- Import `index.js`, build a mock `ctx` exposing `web.registerSearchProvider` + `web.registerFetchProvider`, `tools.register`, `systemPrompt.section`, `timeout(ms)`, and `get(name)`, then call `apply(ctx, {})`. This captures the registered providers + tools + prompt sections; invoke `provider.search({query,maxResults})`, `provider.fetch({url})`, or a tool's `execute(args)` directly. Registration disposers are intentionally NOT handed to `ctx.effect`: the DSH loader commits the entry fiber right after `apply()` and would run every disposer, silently unregistering everything (empirically reproduced in the host — direct register survives, effect-wrapped register vanishes).
- The free engines **Bing**, **DuckDuckGo** and **Exa MCP (exa-free)** are keyless over `fetch` and need only outbound HTTPS to `www.bing.com` / `html.duckduckgo.com` / `mcp.exa.ai`. They are enough to prove the engine chain + fusion works. `lib/exa-free.js` hosts the Exa MCP client; `lib/layer.js` holds the `free`/`api` search-layer state switched by `/web_change`.
- Engines requiring external setup are unavailable by default and degrade gracefully: **Antigravity** (`agy` CLI, macOS/Linux, one-time sign-in), the **official x_search path** (hosted xAI tool — enabled only by `/x-login`, which imports `~/.grok/auth.json` into `~/.dsh-search-boost-xauth.json`, or by `XAI_API_KEY`; `/x-logout` disables it), and keyed **Tavily/Brave/Exa** (keys in `~/.dsh-search-boost-keys.json` or `TAVILY_API_KEY`/`BRAVE_API_KEY`/`EXA_API_KEY`). In the `free` layer these keyed engines are never dialed. `x_search` works with zero credentials anyway: it routes to the fused multi-engine route (site-restricted to x.com) + oEmbed full-text, with structured user profiles via X's anonymous guest GraphQL (`lib/xfallback.js`).

### Gotchas
- The HTML-scrape engines (Bing/DuckDuckGo) depend on the search sites' markup; if parsing suddenly returns 0 hits, the page structure likely changed rather than the code being broken.
- `search_stats` reports engine availability (which is why it shows `bing: true`, `ddg: true`, `exa-free: true` but `antigravity/tavily/brave/exa: false` in a clean environment), plus `x_search` state: `grok: false` / `x.source: "none"` means the official path is disabled and the credential-free fallback chain is used.
