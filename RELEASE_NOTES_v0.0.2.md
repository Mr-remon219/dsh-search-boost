# v0.0.2 — Search layers (`/web_change`) + keyless Exa MCP engine

Two `free` / `api` search layers, a new keyless quality engine (Exa MCP), and
hardening fixes. The big change: **the free and api layers are now switchable
at runtime** with `/web_change`, so a research loop can run keyless-only
(`free`) and dial the full pool (`api`) when keyed corroboration matters.

## Features

- **`/web_change [free|api|show]`** — switch the active search layer at
  runtime (host `commands` service). `free` dials only keyless engines
  (Antigravity / Bing / DuckDuckGo / Exa MCP); `api` is the full pool incl.
  keyed Tavily / Brave / Exa. Persisted to `~/.dsh-search-boost-layer.json`, so
  it survives reloads. `fused_search` output now reports the active layer;
  `fused_search` / `deep_research` also accept a per-call `layer` override.
- **Keyless Exa MCP engine (`exa-free`)** — new `lib/exa-free.js`: a minimal
  MCP Streamable HTTP client speaking `initialize → initialized →
  tools/call web_search_exa` against `mcp.exa.ai`. Keyless, neural/semantic
  retrieval; measured 4/4 correct-entity results in probing and it now joins
  the free-tier parallel fan-out (bing + ddg + exa-free), raising cross-engine
  corroboration without any API key.
- **Layer-aware tier tables** — `lib/fusion.js` adds `TIER_ENGINES_FREE`
  (keyless-only per tier); the active layer selects which table is dialed.
- **Free-layer engine guard** — a free-layer call that requests only keyed
  engines never dials one; it falls back to the layer's keyless pool (or the
  keyless exa-free engine as a last resort) and reports a WARNING instead of
  silently returning empty.

## Fixes

- **MCP notification path** (`lib/exa-free.js`) — MCP `notifications/initialized`
  is answered with `202` + empty body; the pre-0.0.2 shape would try to parse it
  as JSON and throw. Notification responses (no JSON-RPC `id`) now short-circuit
  with an empty payload.
- **Cache key now includes the layer** (`searchCacheKey` version 2 → 3) so a
  `free` and an `api` result for the same query do not collide.
- **Dead-pool guard** — a call that ends up with no usable engine degrades to
  keyless exa-free and says so (no silent empty result).

## Notes

- The `free` layer is single-purpose: cheaper and privacy-friendlier, but with
  fewer cross-engine hits and higher 429 exposure on the keyless channels.
  Prefer `/web_change api` for high-stakes research.
- The session-level `plugin-host.js` bundle is the older single-file form and
  does not gain `/web_change`; install the bundle (recommended) for layers.
