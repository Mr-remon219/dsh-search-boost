# v0.0.4 — full optimization pass

## Fixes

- **Critical: `x_search` engine wiring** — `registerXSearchTool(ctx)` never received the engine registry, so every engine fan-out inside the tool (`domainSearch(engines, …)`) threw `ReferenceError: engines is not defined`. The tool could only ever return hosted-tool results (or an error) — the multi-engine parallel channel and the entire credential-free chain were dead inside the real tool. Caught by a new mock-ctx smoke that executes the tool end-to-end; a hermetic regression test now guards it.
- **Dead imports removed** — `jwtTier`/`tierName` in `index.js`, `splitXTitle` in `lib/xsearch.js`.

## Hardening

- **Hard timeouts everywhere** — every X-path fetch now combines the caller's `AbortSignal` with `AbortSignal.timeout` (`AbortSignal.any`), so a stalled server can no longer hang the call when a caller signal is present (previously `signal ?? timeout` meant "no timeout" whenever a signal was supplied).
- **401 self-heal on the official path** — a `401` from cli-chat-proxy (clock skew / server-side revocation missed by the pre-flight expiry check) now triggers one OIDC refresh + retry for grok-sessions.
- **Guest-token 401/403 self-heal** — a server-side-invalidated guest token is dropped from the disk cache, re-minted and retried once.
- **Entity decoding** — hex entities (`&#x…;`) and common named entities (`&middot;`, `&rsquo;`, `&ldquo;`, `&hellip;`, `&ndash;`, `&mdash;`, …) now decode in oEmbed text; malformed entities pass through verbatim instead of throwing.

## Performance

- **Per-kind TTL cache for `x_search`** — repeated identical queries short-circuit before the credential preflight (keyword/semantic 5min, user 10min, thread 15min), avoiding re-running the 30-50s hosted tool or re-hitting engines. Cache hits report `cacheHit: true` and `tookMs: 0`. Verified live: first call 7.0s → second call 0ms with identical items.

## Tests

- 41/41 pass (new: engine-wiring regression with mocked fetch, TTL-cache regression with a mocked engine response, malformed/hex entity decoding).
