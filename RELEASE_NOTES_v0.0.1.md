# dsh-search-boost v0.0.1

First release of the search boost plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

## What's inside

- **Built-in `web_search` upgrade** — registers a `WebSearchProvider` and patches `searchProvider`, so the built-in `web_search` runs on a **parallel free-engine fan-out** (Bing + DuckDuckGo curl scrapes, + Antigravity CLI where installed) instead of a serial failover chain. Native citation cards preserved.
- **`fused_search`** — multi-engine fused retrieval: free engines run in parallel (Antigravity CLI / Bing / DuckDuckGo, all keyless), keyed Tavily / Brave / Exa join when keys are configured. Complexity routing, Grok-style query preprocessing (`site:` / `OR` / quotes), hard domain filters, half-life time-decay freshness, cross-engine co-occurrence scoring, 6h TTL cache.
- **`fetch_page`** — Jina Reader extraction + local HTML fallback + `focus`-based topic extraction (~90% token savings) + 24h cache.
- **`x_search`** — X/Twitter search via the local Grok Build CLI, structured evidence output, 45s timeout degradation when there is no subscription (never blocks).
- **`deep_research`** — step-mode research: complex fused search + coverage analysis + cross-domain corroboration + gaps + suggested queries, driven by the main agent in rounds until convergence.
- **`research_parallel`** — parallel multi-agent research fanned out to native DSH subagents under a time budget.
- **`search_stats`** — cache / tier / engine-error / recent-query audit.
- **Proactive-search policy v3** — injected into the system prompt: search-first by default, hard rule that any doubt about an external fact triggers an immediate search, per-answer self-check, no "reasoning away" of uncertainty.
- **X-algorithm-inspired scoring** (Apache-2.0, from [xai-org/x-algorithm](https://github.com/xai-org/x-algorithm)) — repeated-domain decay (0.7x for a second result from the same domain) + single-engine discount (0.9x) for result diversity.

## Install

```sh
dsh plugin add github:Mr-remon219/dsh-search-boost
```

or run the bundled installer (checks `dsh` and `pnpm`, auto-detects the npx cache, auto-injects npm global dir into PATH):

```powershell
.\install.ps1        # Windows
./install.sh         # Linux / macOS
```

See [README.md](https://github.com/Mr-remon219/dsh-search-boost#readme) for configuration (keys are loaded from `~/.dsh-search-boost-keys.json` or `TAVILY_API_KEY` / `EXA_API_KEY` / `BRAVE_API_KEY` env vars; free engines need zero config).

## License

MIT
