# dsh-search-boost

> Search boost for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): multi-engine fused search, focused page fetching, X (Twitter) search, step-mode deep research, parallel multi-agent research, and an injected proactive-search policy.

A **bundle plugin** for DSH that upgrades the built-in `web_search` and registers a family of search tools:

- Free-by-default engines run **in parallel**: **Antigravity CLI / Bing / DuckDuckGo / Exa MCP (exa-free)** (all keyless), with keyed **Tavily / Brave / Exa** joining when keys are present.
- **Two search layers, switched with `/web_change`**: `free` (keyless engines only — no credits, ideal for research loops) vs `api` (full pool incl. keyed Tavily / Brave / Exa). Choice persists across reloads.
- Fused multi-engine ranking with cross-engine co-occurrence scoring and time-decay freshness.
- Deep research driven by the main agent, and parallel research fanned out to native DSH subagents.

## Features

| Capability | Description |
|---|---|
| **Built-in `web_search` + `web_fetch` upgrade** | Registers `WebSearchProvider` + `WebFetchProvider` and patches both seam configs (`searchProvider` + `fetchProvider`), so the built-in `web_search` runs on this plugin's free-first engine chain and the built-in `web_fetch` runs on its Jina-first page reader (native citation/result cards preserved) |
| `fused_search` | Multi-engine fused retrieval: free engines run **in parallel** (Antigravity CLI / Bing / DuckDuckGo / Exa MCP — all keyless), keyed engines join when keys exist (Tavily / Brave / Exa). The active layer (free vs api) is switched with `/web_change`; `layer` can be overridden per call. Complexity routing, Grok-style query preprocessing (`site:` / `OR` / quotes), hard domain filters, half-life time-decay freshness, cross-engine co-occurrence scoring, 6h TTL cache |
| `/web_change` | Switch the search layer at runtime: `/web_change free` (keyless only: agy/bing/ddg/exa-free) or `/web_change api` (full pool). `/web_change show` reports the current layer and which engines are available. Persisted to `~/.dsh-search-boost-layer.json` so it survives reloads |
| `x_search` | Real-time X/Twitter search: posts, users, threads. `keyword`/`semantic` run as **parallel instant search** — the hosted xAI `x_search` tool (grok login via `/x-login`, or `XAI_API_KEY`) runs ∥ the fused multi-engine route (site-restricted to x.com), results merged and deduped by status id/url. Works with **no credentials at all**: multi-engine + oEmbed full-text enhancement (~2s), structured user profiles via X's anonymous guest GraphQL, thread full text via oEmbed. Results cached per kind (keyword/semantic 5min, user 10min, thread 15min TTL). `/x-login` enables the official path, `/x-logout` disables it |
| `/x-login` | Import xAI credentials for the official `x_search` path into `~/.dsh-search-boost-xauth.json`: `/x-login` (bare — from your grok login `~/.grok/auth.json`), `/x-login -k <XAI_API_KEY>` (public api.x.ai), `/x-login status`. OIDC tokens auto-refresh (best-effort sync back to grok's file); grok CLI's own login is never touched |
| `/x-logout` | Remove the `/x-login` credentials: the official hosted path is disabled and `x_search` uses only the multi-engine / guest-GraphQL / oEmbed fallback chain |
| `fetch_page` | Jina Reader content extraction + local HTML fallback + `focus`-based topic extraction (saves ~90% tokens) + 24h cache |
| `deep_research` | Step-mode deep research: complex fused search + coverage analysis + cross-domain corroboration stats + gaps + suggested queries, **driven by the main agent in rounds until convergence** |
| `research_parallel` | Parallel multi-agent research: sub-query decomposition → fan out to native DSH subagents (each with its own context, inheriting `fused_search` / `fetch_page`) → time budget → merged sources |
| `search_stats` | Audit of cache / tier distribution / engine availability / x_search credential state |
| Search policy | Injected via `systemPrompt.section`: time-sensitive facts must be searched, technical claims verified, X content routed to `x_search`, stop conditions, cost awareness (free engines first) |

## Installation (bundle — recommended)

**From npm (recommended for users — published release):**

```sh
dsh plugin add dsh-search-boost          # latest
dsh plugin add dsh-search-boost@0.0.3    # pin a version
```

npm-sourced installs are versioned and independent of any local checkout; the registry package always matches a committed, tested tree (enforced by the `prepublishOnly` gate).

**From source (development / latest git):**

```sh
dsh plugin add github:Mr-remon219/dsh-search-boost        # latest main
dsh plugin add github:Mr-remon219/dsh-search-boost#<hash> # pin a commit
dsh plugin --profile web add git+file:///path/to/repo     # local git source (protocol verified)
```

Git/local sources are ideal for iterating on fixes: edit → restart → verify.

Or run the install script from the repo (syntax check → key setup → install → verification):

```powershell
.\install.ps1          # Windows (defaults to profile "web")
./install.sh           # Linux / macOS
```

After installing, restart `dsh --profile web`. The built-in `web_search` now runs on this plugin's engine chain, and `fused_search` / `fetch_page` / `x_search` / `deep_research` / `research_parallel` / `search_stats` are all registered. The git-source install protocol has been verified end to end (pnpm fetch → patch layer applied → usable).

### Troubleshooting: missing `dsh` or `pnpm`

The official way to run DSH is `npx @deepseek-ai/dsh web`, which leaves **no global `dsh` command** — the install script can't see it. The script now auto-detects the npx cache (`%LOCALAPPDATA%\npm-cache\_npx\*` / `~/.npm/_npx/*`) and npm global prefix, so this usually just works. If it still fails, either:

1. Install globally (recommended), then reopen your terminal:
   ```sh
   npm install -g @deepseek-ai/dsh
   ```
2. Skip the script and run the install via npx directly:
   ```sh
   npx --yes @deepseek-ai/dsh plugin --profile web add <path-to-this-repo>
   ```

`dsh plugin add` also needs **pnpm** (DSH uses it to resolve bundle dependencies). The script checks for it and auto-adds the npm global dir to the current session's `PATH` when pnpm was installed but isn't on it. If pnpm is genuinely missing:

```sh
npm install -g pnpm
# or, with corepack:
corepack enable && corepack prepare pnpm@latest --activate
```

```sh
dsh --profile web --dump-config   # web.searchProvider should be dsh-search-boost
dsh --profile web                 # built-in web_search now uses this plugin's chain
```

**Headless end-to-end verification** (no GUI): append a headless-runner plugin row to the profile's `cordis.patch.yml` (`inject: [headlessStartup]` + `config.task: !!js ctx.headlessStartup.task`, see the patch shipped with the built-in `@deepseek-ai/dsh-headless`), then run:

```sh
dsh --profile <name> "use web_search to search …"
```

## Alternative: session-level dynamic plugin (`plugin-host.js`)

`plugin-host.js` is a single-file dynamic plugin installed inside a session via `cordis_define`. It does **not** replace the built-in `web_search` and is suited for quick per-session boosts; the bundle form (recommended) is deployment-level and upgrades the built-in `web_search` directly.

Manual installation: start a DSH session and pass the full contents of `plugin-host.js` as `code.host`:

```text
cordis_define(kind: "new", idPrefix: "sboost", code: { host: <full plugin-host.js> })
cordis_run(pluginId, packageId, mode: "run")
```

Dynamic plugins do not survive a process restart — re-define/run after restarting; the disk cache `.search-boost-cache.json` is reused automatically.

## Configuration (API keys)

The published bundle contains **no secrets**. The bundle runs in the host process and loads keys from the following sources in order:

1. `~/.dsh-search-boost-keys.json` (recommended) or workspace `./.search-boost-keys.json`:

```json
{
  "tavily": "tvly-...",
  "exa": "...",
  "brave": "..."
}
```

2. Environment variable fallback: `TAVILY_API_KEY` / `EXA_API_KEY` / `BRAVE_API_KEY`

Engines without a key are automatically dropped from the fan-out. **Free engines need no configuration at all**: Antigravity CLI (macOS/Linux — install once, sign in once in the browser), Bing, DuckDuckGo and Exa MCP (exa-free) work out of the box, and the keyless ones run in parallel so a single-engine failure never leaves you empty-handed. In the `free` layer only these keyless engines are dialed; the `api` layer adds the keyed Tavily / Brave / Exa when keys are present.

### x_search credentials (optional)

`x_search` works with zero credentials — it routes to the multi-engine route (site-restricted to x.com) + oEmbed full-text, with structured user profiles via X's anonymous guest GraphQL. The **official hosted path** (the xAI `x_search` tool, real-time in-app search with advanced syntax) is an explicit opt-in:

| Command | Effect |
|---|---|
| `/x-login` | Import your grok login (`~/.grok/auth.json`) into `~/.dsh-search-boost-xauth.json` — the official path is then used (tokens auto-refresh via OIDC, best-effort sync back to grok's file). Requires a SuperGrok / X Premium+ tier |
| `/x-login -k <XAI_API_KEY>` | Same, but with an API key from console.x.ai (public `api.x.ai` endpoint) |
| `/x-login status` | Show the credential chain (env key → local copy → grok file present-but-not-imported) |
| `/x-logout` | Delete the local copy — official path disabled, `x_search` back to the credential-free chain. **Never touches grok CLI's own login** |

`~/.grok/auth.json` is **never auto-consumed**: without an explicit `/x-login` (or `XAI_API_KEY` env), `x_search` uses only the credential-free chain. `/x-login` sets `recordInput: false`, so an API key passed on the command line never lands in the session log — the state file owns the payload. Routing: `keyword`/`semantic` → hosted x_search ∥ multi-engine in parallel, merged and deduped (with no credentials: multi-engine + oEmbed in ~2s); `user` → guest GraphQL structured profile + timeline → multi-engine profile links; `thread` → oEmbed single-post full text.

## Verified benchmarks (2026-08, Windows + headless)

| Scenario | Result |
|---|---|
| `dsh plugin add` install + patch layer applied | ✓ (`dump-config` confirms `searchProvider` rewritten + plugin row inserted) |
| Headless end-to-end `web_search` | ✓ (headless-runner embedded in profile, runs on the free Bing chain) |
| No-key parallel fan-out | Zero keys, simple tier: bing + DuckDuckGo + exa-free run in parallel; agy joins from the medium tier; a cross-engine hit (ddg + exa-free) out-ranks single-engine ones |
| `free` vs `api` layer | `free` uses only keyless engines (measured: bing + ddg + exa-free fused a "tokio latest version" query to 5 hits in ~3.0s with the correct entities); `api` adds keyed engines and cross-engine `ddg+exa-free+tavily+brave+exa` corroboration (score 8.29 vs free layer 3.44) |
| Dead-pool guard | A free-layer call that requests only keyed engines never dials a keyed engine and falls back to the layer's keyless pool instead of returning empty |
| SSRF vs Clash TUN fake-ip | Literal 198.18/15 (RFC 2544) targets are blocked; hostname resolution that lands entirely in 198.18/15 is treated as TUN fake-ip and allowed (the TUN device routes to the real host); opt out with `DSH_SEARCH_ALLOW_TUN_FAKEIP=0`. Measured: fetch_page github.com 953ms via Jina on a fake-ip machine |
| `deep_research` (bundle) | 18s per round: tokio v1.53.1 conclusion + cross-source corroboration + complete gaps/suggested_queries |
| `research_parallel` (bundle) | 2 subagents in parallel, 53.6s: 10 first-party sources (changelog / crates.io / GitHub cross-consistent) |
| `x_search` (credential-free) | No credentials at all: keyword via multi-engine (site:x.com) + oEmbed full-text enhancement in ~2-5s; user via guest GraphQL (structured profile + recent timeline with engagement, e.g. @NASA 92M followers); thread via oEmbed full text |
| `x_search` (official path) | After `/x-login`: hosted xAI tool via direct Responses-API POST (no subprocess) — keyword returns real-time posts with engagement, user returns structured account data; runs in parallel with the multi-engine route and merges (measured: 7 results = 3 hosted + 4 engine-supplemented, deduped) |
| `x_search` credential lifecycle | Default (no `/x-login`) → official path disabled even when `~/.grok/auth.json` exists; `/x-login` → enabled; `/x-logout` → disabled again, fallback chain still fully working |

## Architecture notes

- The bundle runs in the **host process**: Node `fetch` / `child_process` directly, no sandboxed-shell workarounds (contrast: the session-level plugin needs `ctx.shell.run` + quoting care).
- Patching `web.searchProvider` (and `web.fetchProvider`) is the key integration: the built-in `web_search` / `web_fetch` keep their schema/UI unchanged; only the backend is swapped for the engine chain / Jina-first page reader. All tools additionally declare DSH-native `presentCall`/`presentResult` cards (search/fetch family renders as native web result cards with citation lists via `output.presentationMeta`), and a `search_status` systemPrompt variable exposes the live layer + x_search credential state to the model every turn.
- X search has three layers: (1) the **official hosted path** (`lib/xsearch.js`) POSTs the Responses API directly with the hosted `x_search` tool — no grok subprocess; credentials come only from `/x-login` or `XAI_API_KEY`; (2) the **credential-free chain** (`lib/xfallback.js`) routes by type: multi-engine (site:x.com) + oEmbed full text, guest GraphQL for structured users, oEmbed for threads — with IPv4-forced DNS (Windows undici fix), a 2h-cached guest token, and query-id self-healing on 404; (3) a fast synchronous credential preflight routes straight to the chain when the official path is disabled.
- All fetch fan-out for X goes through `lib/xfallback.js`'s IPv4-forced `https.Agent` (undici on Windows defaults to IPv6-first DNS, which intermittently times out against bing.com / x.com).

## Files

```
index.js                    — bundle plugin entry (provider + tools + commands + policy injection)
lib/engines.js              — key loading + engine chain with failover
lib/exa-free.js             — Exa MCP keyless engine (free layer quality leg)
lib/layer.js                — free/api search-layer state, switched by /web_change (persisted)
lib/fusion.js               — fused scoring / tier tables / cache
lib/fetch.js                — Jina Reader + local fallback + focus extraction
lib/xauth.js                — x_search credential chain (/x-login state, OIDC refresh, /x-logout)
lib/xsearch.js              — x_search official path: direct Responses-API POST (hosted tool, no subprocess)
lib/xfallback.js            — x_search credential-free chain: multi-engine + oEmbed + guest GraphQL (IPv4 agent, guest-token cache, query-id self-heal)
lib/research.js             — deep_research round + research_parallel fan-out
lib/policy.js               — proactive-search policy section text
cordis.patch.yml            — patch layer (web.searchProvider + plugin row)
package.json                — bundle manifest (dsh.bundle.patch)
install.ps1 / install.sh    — one-command install scripts
scripts/verify-publish.mjs  — pre-publish gate (syntax + tests + clean tree)
search-boost-keys.example.json — key file example
plugin-host.js              — alternative session-level dynamic plugin (full source)
```

## Publishing (maintainers)

```sh
npm test      # run the test suite
npm publish   # prepublishOnly gate: syntax check + tests + clean-tree check
```

`npm publish` runs the `prepublishOnly` gate automatically: it aborts on a syntax error, a failing test, or a dirty working tree (`DSH_SB_ALLOW_DIRTY=1` forces through), so the registry tarball always matches the committed repo. After publishing, `dsh plugin add dsh-search-boost` installs the release.

## License

MIT

## Friends

- [Linux.do](https://linux.do/) — open-source developer community
