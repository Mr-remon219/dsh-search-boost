# dsh-search-boost

> Search boost for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): multi-engine fused search, focused page fetching, X (Twitter) search, step-mode deep research, parallel multi-agent research, and an injected proactive-search policy.

A **bundle plugin** for DSH that upgrades the built-in `web_search` and registers a family of search tools:

- Free-by-default engines run **in parallel**: **Antigravity CLI / Bing / DuckDuckGo** (all keyless), with keyed **Tavily / Brave / Exa** joining when keys are present.
- Fused multi-engine ranking with cross-engine co-occurrence scoring and time-decay freshness.
- Deep research driven by the main agent, and parallel research fanned out to native DSH subagents.

## Features

| Capability | Description |
|---|---|
| **Built-in `web_search` upgrade** | Registers a `WebSearchProvider` and patches `searchProvider`, so the built-in `web_search` runs on this plugin's free-first engine chain (native citation cards preserved) |
| `fused_search` | Multi-engine fused retrieval: free engines run **in parallel** (Antigravity CLI / Bing / DuckDuckGo — all keyless, two are plain curl scrapes), keyed engines join when keys exist (Tavily / Brave / Exa). Complexity routing, Grok-style query preprocessing (`site:` / `OR` / quotes), hard domain filters, half-life time-decay freshness, cross-engine co-occurrence scoring, 6h TTL cache |
| `x_search` | X/Twitter search via the local Grok Build CLI (`~/.grok/auth.json` login state). Returns structured evidence (summary + posts + uncertainty); degrades gracefully after a 45s timeout when there is no subscription, never blocks the call |
| `fetch_page` | Jina Reader content extraction + local HTML fallback + `focus`-based topic extraction (saves ~90% tokens) + 24h cache |
| `deep_research` | Step-mode deep research: complex fused search + coverage analysis + cross-domain corroboration stats + gaps + suggested queries, **driven by the main agent in rounds until convergence** |
| `research_parallel` | Parallel multi-agent research: sub-query decomposition → fan out to native DSH subagents (each with its own context, inheriting `fused_search` / `fetch_page`) → time budget → merged sources |
| `search_stats` | Audit of cache / tier distribution / engine availability / grok status |
| Search policy | Injected via `systemPrompt.section`: time-sensitive facts must be searched, technical claims verified, X content routed to `x_search`, stop conditions, cost awareness (free engines first) |

## Installation (bundle — recommended)

**One command** (after publishing, or from a local git source):

```sh
dsh plugin add github:Mr-remon219/dsh-search-boost    # published
dsh plugin --profile web add git+file:///path/to/repo # local git source (protocol verified)
```

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

Engines without a key are automatically dropped from the fan-out. **Free engines need no configuration at all**: Antigravity CLI (macOS/Linux — install once, sign in once in the browser), Bing (zero-config) and DuckDuckGo (zero-config) work out of the box, and the keyless ones run in parallel so a single-engine failure never leaves you empty-handed. X search requires Grok Build installed locally and signed in (SuperGrok / X Premium subscription).

## Verified benchmarks (2026-08, Windows + headless)

| Scenario | Result |
|---|---|
| `dsh plugin add` install + patch layer applied | ✓ (`dump-config` confirms `searchProvider` rewritten + plugin row inserted) |
| Headless end-to-end `web_search` | ✓ (headless-runner embedded in profile, runs on the free Bing chain) |
| No-key parallel fan-out | Zero keys, simple tier: bing + DuckDuckGo run in parallel (measured 1.7s, 6 fused hits, 0 engine errors); agy joins from the medium tier; quality improves further with keyed engines |
| SSRF vs Clash TUN fake-ip | Literal 198.18/15 (RFC 2544) targets are blocked; hostname resolution that lands entirely in 198.18/15 is treated as TUN fake-ip and allowed (the TUN device routes to the real host); opt out with `DSH_SEARCH_ALLOW_TUN_FAKEIP=0`. Measured: fetch_page github.com 953ms via Jina on a fake-ip machine |
| SSRF vs Clash TUN fake-ip | Literal 198.18/15 (RFC 2544) targets are blocked; hostname resolution that lands entirely in 198.18/15 is treated as TUN fake-ip and allowed (the TUN device routes to the real host); opt out with `DSH_SEARCH_ALLOW_TUN_FAKEIP=0`. Measured: fetch_page github.com 953ms via Jina on a fake-ip machine |
| `deep_research` (bundle) | 18s per round: tokio v1.53.1 conclusion + cross-source corroboration + complete gaps/suggested_queries |
| `research_parallel` (bundle) | 2 subagents in parallel, 53.6s: 10 first-party sources (changelog / crates.io / GitHub cross-consistent) |
| `x_search` timeout degradation | Precise 45.09s timeout, clear error message, non-blocking |
| grok json-schema mode | 17s envelope response (except X search, which needs a subscription) |

## Architecture notes

- The bundle runs in the **host process**: Node `fetch` / `child_process` directly, no sandboxed-shell workarounds (contrast: the session-level plugin needs `ctx.shell.run` + quoting care).
- Patching `web.searchProvider` is the key integration: the built-in `web_search` keeps its schema/UI unchanged; only the backend is swapped for the engine chain.
- X search is adapted from [liustack/modsearch](https://github.com/liustack/modsearch) (MIT): `grok -p --always-approve --json-schema`, salvaging the contract object from `text` when `structuredOutput` is null.

## Files

```
index.js                    — bundle plugin entry (provider + tool registration + policy injection)
lib/engines.js              — key loading + engine chain with failover
lib/fusion.js               — fused scoring / cache
lib/fetch.js                — Jina Reader + local fallback + focus extraction
lib/grok.js                 — X (Twitter) search via Grok Build CLI
lib/research.js             — deep_research round + research_parallel fan-out
lib/policy.js               — proactive-search policy section text
cordis.patch.yml            — patch layer (web.searchProvider + plugin row)
package.json                — bundle manifest (dsh.bundle.patch)
install.ps1 / install.sh    — one-command install scripts
search-boost-keys.example.json — key file example
plugin-host.js              — alternative session-level dynamic plugin (full source)
```

## License

MIT

## Friends

- [Linux.do](https://linux.do/) — open-source developer community
