# v0.0.3 — x_search: parallel instant search + credential-free fallback chain

## New

- **`x_search` four modes** — `keyword` (X advanced syntax), `semantic` (natural language), `user` (structured account profile + recent timeline), `thread` (full conversation by post id / status URL).
- **Parallel instant search** — `keyword`/`semantic` run two channels concurrently and merge, deduped by status id/URL:
  - the **official hosted path**: pi-style direct Responses-API POST (`cli-chat-proxy.grok.com` with grok's OIDC login, or `api.x.ai` with `XAI_API_KEY`) — **no grok subprocess is ever spawned**;
  - the **fused multi-engine route** restricted to x.com (layer-aware: free layer = exa-free/bing/ddg, api layer adds keyed tavily/brave/exa).
  - Measured merge: 7 results = 3 hosted + 4 engine-supplemented.
- **Credential-free fallback chain** (`lib/xfallback.js`) — `x_search` works with **zero credentials**:
  - keyword/semantic → multi-engine (site:x.com) + **oEmbed full-text enhancement** for the top 1-2 status URLs (~2-5s);
  - user → **guest GraphQL** (X's anonymous web API): structured profile (followers/bio/verified/created) + recent timeline with likes/views/media;
  - thread → oEmbed single-post full text.
- **`/x-login` / `/x-logout`** — explicit credential switch: the official path is enabled **only** by `/x-login` (imports `~/.grok/auth.json` into `~/.dsh-search-boost-xauth.json`) or `/x-login -k <XAI_API_KEY>`; `/x-logout` removes the copy and routes back to the credential-free chain. `~/.grok/auth.json` is **never auto-consumed**; grok CLI's own login is never touched. OIDC tokens auto-refresh (standard `oauth2/token` at the IdP, best-effort sync back to grok's file).
- **Fast credential preflight** (`xAuthAvailableSync`, sync, zero network) — with no credentials `x_search` routes straight to the multi-engine chain instead of waiting on a primary-path timeout.

## Hardening

- **IPv4-forced DNS** — Windows undici defaults to IPv6-first lookups which intermittently time out against bing.com / x.com; every X-path fetch goes through a shared `https.Agent` with `dns.lookup(family: 4)` (`xfetch`).
- **guest token disk cache** (2h TTL, atomic write) — no re-mint per call.
- **query-id self-heal** — on GraphQL 404, re-extracts the latest `UserByScreenName` / `UserTweets` query ids from x.com's JS bundles and retries once.
- **new-shape UserByScreenName parsing** — `rest_id` / `profile_bio` / `relationship_counts` / `verification` with legacy-shape fallback; `view_counts_everywhere_api_enabled` feature flag so timeline views are populated.
- **retired the grok-CLI subprocess path** (`lib/grok.js` deleted) — the official path is now the direct Responses-API POST.

## Docs & tooling

- README / README_zh: x_search modes, routing, credential lifecycle, architecture; AGENTS.md and install scripts updated for the new module set.
- New unit tests: title/oEmbed parsing, guest user/tweet parsers (new shape), fallback routing with mocked fetch (hermetic). 38/38 tests pass; `node --check` clean on all shipped sources.

## Compatibility

- Node `>=22.13`, zero runtime dependencies (unchanged).
- The official path requires a SuperGrok / X Premium+ tier for the hosted x_search tool; without it (or without credentials) the fallback chain answers instead.
- `cli-chat-proxy` may tighten its `x-grok-client-version` gate over time; a rejection surfaces as an error and the fallback chain takes over.
