// dsh-search-boost — DeepSeek Harness bundle plugin.
//
// Loaded via cordis.patch.yml rows (see package.json `dsh.bundle` manifest):
// one row mounts this plugin, one repoints the `web` seam's `searchProvider`
// at it, so the built-in `web_search` runs on our free-by-default engine chain
// (Antigravity CLI → Bing → Tavily → Brave → Exa) while keeping the native
// citation cards. Beside the provider, we register our own tools: fused_search
// (multi-engine fusion), fetch_page (focused page reading), x_search (X /
// Twitter: hosted xAI tool ∥ multi-engine parallel instant search, with a
// credential-free multi-engine + guest-GraphQL + oEmbed fallback chain), plus
// deep_research / research_parallel / search_stats.
//
// This plugin runs inside the dsh host process, so it uses Node's fetch /
// child_process directly — no sandbox shell indirection needed.

import { loadKeys, engineRegistry, ENGINE_ORDER } from './lib/engines.js'
import { fusedSearch, makeCache, estimateComplexity, TIER_ENGINES, TIER_ENGINES_FREE, FREE_DOMAIN_ENGINES, domainSearchQuery, searchCacheKey, hostOf, normalizeUrl } from './lib/fusion.js'
import { fetchPage, makePageCache } from './lib/fetch.js'
import { isSsrfError } from './lib/ssrf.js'
import { runXTool, xAuthAvailableSync } from './lib/xsearch.js'
import { fallbackXSearch, hitToPost, cleanJsonValue } from './lib/xfallback.js'
import { authStatus, importFromGrok, importApiKey, logout, piAuthPath, xAuthCacheToken } from './lib/xauth.js'
import { SEARCH_POLICY_SECTION } from './lib/policy.js'
import { researchRound, parallelResearch, setTimer } from './lib/research.js'
import { getLayer, setLayer, LAYER_LABELS } from './lib/layer.js'

export const name = 'dsh-search-boost'
export const inject = ['web', 'tools', 'systemPrompt', 'timer', 'commands']

const SEARCH_CACHE = makeCache()
const PAGE_CACHE = makePageCache()
// Per-kind TTL cache for x_search: real-time X data is cached briefly so
// repeated identical queries do not re-run the slow hosted tool or re-hit
// engines (keyword/semantic 5min, user 10min, thread 15min — mirrors the pi
// extension's TTLs). Keys include layer + auth fingerprint; lookups happen
// after the credential preflight so official vs fallback paths do not cross.
const X_CACHE = {
  keyword: makeCache(5 * 60 * 1000),
  semantic: makeCache(5 * 60 * 1000),
  user: makeCache(10 * 60 * 1000),
  thread: makeCache(15 * 60 * 1000),
}
// single-flight registry: concurrent identical x_search calls share one run
const X_INFLIGHT = new Map()
const stats = { startedAt: new Date().toISOString(), cacheHits: 0, cacheMisses: 0, tierCounts: {}, recent: [] }

/** Drop fusion + x_search caches after layer or credential changes. */
function invalidateSearchCaches() {
  SEARCH_CACHE.clear()
  for (const cache of Object.values(X_CACHE)) cache.clear()
  X_INFLIGHT.clear()
}

function xSearchCacheKey(kind, args, maxResults) {
  return JSON.stringify({
    kind,
    q: args.query ?? null,
    u: args.username ?? null,
    pid: args.post_id ?? null,
    fd: args.from_date ?? null,
    td: args.to_date ?? null,
    m: maxResults,
    ah: args.allowed_x_handles ?? null,
    eh: args.excluded_x_handles ?? null,
    layer: getLayer(),
    auth: xAuthCacheToken(),
  })
}

export function apply(ctx, config = {}) {
  let engines = engineRegistry(loadKeys())
  /** Reload keys from disk/env and rebuild the engine registry (mid-session key edits). */
  const bumpEngines = () => {
    engines = engineRegistry(loadKeys())
    return engines
  }

  const safe = (label, fn) => {
    try {
      fn()
    } catch (err) {
      console.error(`[dsh-search-boost] ${label} registration failed:`, err instanceof Error ? err.message : String(err))
    }
  }
  // Registrations are kept alive for the process lifetime (bundle plugin).
  // NOTE: do NOT hand registration disposers to ctx.effect — the loader's
  // entry fiber commits right after apply() and would run every disposer,
  // silently UNREGISTERING providers/tools/commands/sections. This was
  // empirically reproduced in the DSH host (direct register → FOUND, then
  // ctx.effect(disposer) → NULL). Built-in plugins drop the disposer too.
  const reg = (label, fn) => safe(label, () => {
    fn()
  })
  reg('searchProvider', () => { if (config.searchProvider !== false) return registerSearchProvider(ctx, bumpEngines) })
  reg('fetchProvider', () => { if (config.fetchProvider !== false) return registerFetchProvider(ctx) })
  reg('fused_search', () => { if (config.fusedSearch !== false) return registerFusedSearchTool(ctx, bumpEngines) })
  reg('fetch_page', () => { if (config.fetchPage !== false) return registerFetchPageTool(ctx) })
  reg('x_search', () => { if (config.xSearch !== false) return registerXSearchTool(ctx, bumpEngines) })
  reg('deep_research', () => { if (config.deepResearch !== false) return registerDeepResearchTool(ctx, bumpEngines) })
  reg('research_parallel', () => { if (config.researchParallel !== false) return registerParallelTool(ctx) })
  reg('search_stats', () => { if (config.searchStats !== false) return registerStatsTool(ctx, bumpEngines) })
  reg('policy section', () => ctx.systemPrompt?.section(SEARCH_POLICY_SECTION))
  reg('search status section', () => registerStatusSection(ctx))
  reg('web_change command', () => registerWebChangeCommand(ctx, bumpEngines))
  reg('x-login command', () => registerXLoginCommand(ctx))
  reg('x-logout command', () => registerXLogoutCommand(ctx))
  try {
    const timer =
      typeof ctx.timeout === 'function'
        ? (ms) => ctx.timeout(ms)
        : ctx.get?.('timer')?.timeout?.bind(ctx.get('timer'))
    if (typeof timer === 'function') setTimer((ms) => timer(ms))
  } catch (err) {
    console.error('[dsh-search-boost] timer setup failed:', err instanceof Error ? err.message : String(err))
  }
}

function availableEngines(engines, names) {
  return names.filter((e) => engines[e]?.available())
}

function runEngine(engines, engineName, q, n, o) {
  const engine = engines[engineName]
  if (!engine?.available()) throw new Error(`${engineName} unavailable`)
  return engine.search(q, n, o)
}

function layerTierTable(layer) {
  return layer === 'free' ? TIER_ENGINES_FREE : TIER_ENGINES
}

async function runFused(engines, { query, queries, engineList, maxResults, includeDomains, excludeDomains, recency, complexity = 'auto', layer = null, signal }) {
  const active = layer ?? getLayer()
  const resolvedTier = complexity === 'auto' ? estimateComplexity(query) : complexity
  const tierTable = layerTierTable(active)
  const engineNames = availableEngines(engines, engineList ?? tierTable[resolvedTier] ?? tierTable.simple)
  const key = searchCacheKey({
    query,
    queries: queries ?? [],
    engines: engineNames,
    includeDomains: includeDomains ?? [],
    excludeDomains: excludeDomains ?? [],
    recency: recency ?? null,
    maxResults,
    tier: resolvedTier,
    layer: active,
  })
  const cached = SEARCH_CACHE.get(key)
  if (cached) {
    stats.cacheHits++
    stats.recent.unshift({ query, layer: active, tookMs: 0, results: cached.results.length, cacheHit: true })
    if (stats.recent.length > 20) stats.recent.pop()
    return { ...cached, cacheHit: true, tookMs: 0 }
  }
  stats.cacheMisses++
  const result = await fusedSearch({
    query,
    queries,
    engines: engineNames,
    maxResults,
    includeDomains,
    excludeDomains,
    recency,
    tier: resolvedTier,
    layer: active,
    signal,
    runOne: (engineName, q, n, o) => runEngine(engines, engineName, q, n, o),
  })
  result.layer = active
  stats.tierCounts[result.tier] = (stats.tierCounts[result.tier] ?? 0) + 1
  stats.recent.unshift({ query, layer: active, tookMs: result.tookMs, results: result.results.length, cacheHit: false })
  if (stats.recent.length > 20) stats.recent.pop()
  SEARCH_CACHE.set(key, result)
  return result
}

/**
 * Layer-aware multi-engine search restricted to X domains — the "instant"
 * parallel channel of x_search and the credential-free fallback's injected
 * webSearch. Calls the engine registry directly (bypassing the fusion scorer,
 * whose per-domain cap of 2 would truncate an X-only result set).
 */
async function domainSearch(engines, { query, maxResults = 5, includeDomains = ['x.com', 'twitter.com'], signal }) {
  const active = getLayer()
  const keyed = active === 'free' ? [] : ['tavily', 'brave', 'exa']
  const pool = active === 'free' ? FREE_DOMAIN_ENGINES : [...FREE_DOMAIN_ENGINES, ...keyed]
  const names = availableEngines(engines, pool)
  const q = domainSearchQuery(query, includeDomains)
  const n = Math.min(Math.max(maxResults ?? 5, 1), 8)
  const per = Math.max(4, Math.ceil(n * 0.8))
  const opts = { includeDomains, signal }
  const tasks = names.map(async (name) => {
    try {
      return await runEngine(engines, name, q, per, opts)
    } catch {
      return []
    }
  })
  const all = (await Promise.all(tasks)).flat()
  const seen = new Set()
  const out = []
  for (const h of all) {
    if (!h?.url) continue
    const host = hostOf(h.url)
    if (!includeDomains.some((d) => host === d || host.endsWith('.' + d))) continue
    const key = normalizeUrl(h.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ title: h.title ?? '', url: h.url, snippet: h.snippet ?? '', domain: host })
    if (out.length >= n) break
  }
  return out
}

// ---------- web seam fetch provider (powers the built-in web_fetch) ----------

function registerFetchProvider(ctx) {
  return ctx.web.registerFetchProvider({
    id: 'dsh-search-boost',
    available: () => true,
    async fetch(request, signal) {
      try {
        const page = await fetchPage(request.url, undefined, PAGE_CACHE, signal)
        return {
          url: page.url,
          statusCode: 200,
          body: { kind: 'text', content: page.content },
          truncated: page.truncated,
        }
      } catch (err) {
        if (isSsrfError(err)) {
          throw new Error(`dsh-search-boost: ${err instanceof Error ? err.message : String(err)}`)
        }
        throw err
      }
    },
  })
}

// ---------- systemPrompt section: live search status ----------

// One line the model sees in every assembly, so it natively knows the active
// layer and whether x_search uses the official path or the fallback chain —
// no tool call needed to decide /web_change or /x-login routing.
//
// Implemented as a DYNAMIC section (PromptSection.text accepts a function
// evaluated per assembly) instead of systemPrompt.variable: empirically the
// variable() registration path throws inside the real DSH host
// ("Cannot read properties of undefined (reading 'layers')" — the variable
// registry is agent-scope oriented), while section() — including dynamic
// text functions — is verified working on a plain host context (assemble
// renders the per-turn value).
function registerStatusSection(ctx) {
  return ctx.systemPrompt?.section({
    name: 'search:status',
    order: 116, // right after the search policy section (115)
    text: () => {
      const layer = getLayer()
      const x = xAuthAvailableSync()
      const st = authStatus()
      return `search status — layer: ${layer}; x_search: ${x ? 'official path' : 'fallback chain'} (${st.source}); /web_change switches the layer, /x-login|/x-logout switch the x_search path`
    },
  })
}

// ---------- web seam provider (powers the built-in web_search) ----------

function registerSearchProvider(ctx, bumpEngines) {
  return ctx.web.registerSearchProvider({
    id: 'dsh-search-boost',
    available: () => true,
    async search(request, signal) {
      const engines = bumpEngines()
      const count = Math.max(1, Math.min(request.maxResults ?? 6, 10))
      // Parallel fan-out over available engines for the query's complexity
      // tier (simple = bing+ddg+exa-free; agy and keyed engines join on
      // medium+). Shares the same 6h cache as fused_search. NOTE: do not add a deepseek-native
      // engine here — ctx.web.search resolves the configured seam (which is
      // this provider after our patch) and would recurse into itself.
      const result = await runFused(engines, {
        query: request.query,
        maxResults: count,
        complexity: 'auto',
        signal,
      })
      if (result.results.length === 0) {
        const errs = Object.entries(result.engineStats)
          .filter(([, v]) => v.errors > 0)
          .map(([k, v]) => `${k}: ${v.note ?? 'error'}`)
        throw new Error(`dsh-search-boost: no engine could answer (${errs.join('; ') || 'all engines unavailable'})`)
      }
      const summary = result.results.map((h, i) => {
        const when = h.published ? ` (${h.published})` : ''
        return `${i + 1}. ${h.title} — ${h.domain}${when}`
      }).join('\n')
      return {
        content: summary || `[dsh-search-boost] ${result.results.length} sources`,
        sources: result.results.map((h) => ({
          url: h.url,
          ...(h.title ? { title: h.title } : {}),
          ...(h.snippet ? { snippet: h.snippet } : {}),
          ...(h.published ? { publishedAt: h.published } : {}),
        })),
        truncated: Boolean(result.truncated),
      }
    },
  })
}

// ---------- fused_search tool ----------

function registerFusedSearchTool(ctx, bumpEngines) {
  return ctx.tools.register({
    name: 'fused_search',
    description:
      'Multi-engine fused web search in parallel (free legs: Antigravity CLI / Bing / DuckDuckGo / Exa MCP — all keyless; ' +
      'keyed Tavily / Brave / Exa join in the api layer). The active layer (free = keyless only, api = full pool) is switched with /web_change. ' +
      'CALL THIS BEFORE ANSWERING any fact that may be stale or external to the conversation: versions, release dates, ' +
      'current status, prices, API changes, benchmarks, comparisons, or anything quoted from another source — do not answer from memory. ' +
      'Beyond a trivial one-line lookup, prefer this over web_search: it runs query variants across engines, dedupes URLs, ' +
      'cross-ranks with per-engine provenance, applies include/exclude domain filters, recency decay, and caches results (6h TTL). ' +
      'Supports Grok-style queries: site:domain, -site:domain, "phrase", A OR B. For time-sensitive facts pass recency="day|week|month|year".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The search query (supports site:, -site:, "phrase", A OR B).' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Optional extra query variants (max 3 total).' },
        engines: { type: 'array', items: { type: 'string', enum: ENGINE_ORDER }, description: 'Engines to use (default by complexity tier and active layer; see /web_change).' },
        max_results: { type: 'number', description: 'Max results to return (default 6, max 10).' },
        include_domains: { type: 'array', items: { type: 'string' }, description: 'Only keep results from these domains (subdomain match).' },
        exclude_domains: { type: 'array', items: { type: 'string' }, description: 'Drop results from these domains (subdomain match).' },
        recency: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Recency window; older results decay exponentially.' },
        complexity: { type: 'string', enum: ['auto', 'simple', 'medium', 'complex'], description: 'Search budget (auto by default).' },
        layer: { type: 'string', enum: ['free', 'api'], description: 'Override the active layer for this call only (default: current /web_change layer).' },
      },
      required: ['query'],
    },
    // DSH-native UI: pending tool-call card (kind 'search' → magnifier icon)
    presentCall: (args) => ({
      card: 'generic',
      title: `fused_search: "${String(args?.query ?? '').slice(0, 60)}"`,
      kind: 'search',
      rawInput: args?.query,
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          queriesUsed: { type: 'array', items: { type: 'string' } },
          tier: { type: 'string' },
          layer: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
          engineStats: { type: 'object' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' }, url: { type: 'string' }, domain: { type: 'string' },
                snippet: { type: 'string' }, score: { type: 'number' }, engines: { type: 'array', items: { type: 'string' } },
                published: { type: 'string' },
              },
              required: ['title', 'url', 'domain'],
            },
          },
          tookMs: { type: 'number' },
          cacheHit: { type: 'boolean' },
          truncated: { type: 'boolean' },
        },
        required: ['query', 'results'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderFused(value),
      }],
      // DSH-native: lossless structured projection for the tool/result event;
      // presentResult narrows it back into a native web citation card.
      presentationMeta: (args, value) => ({
        sources: (value.results ?? []).map((r) => ({
          url: r.url,
          ...(r.title ? { title: r.title } : {}),
          ...(r.snippet ? { snippet: r.snippet } : {}),
          ...(r.published ? { publishedAt: r.published } : {}),
        })),
        truncated: Boolean(value.truncated),
      }),
    },
    // DSH-native UI: completed call → native web-result card with citation list
    presentResult: (args, result) => {
      const meta = result.meta
      if (!meta || !Array.isArray(meta.sources)) return undefined
      return {
        card: 'web',
        kind: 'search',
        title: `fused_search: ${meta.sources.length} sources`,
        sources: meta.sources,
        truncated: Boolean(meta.truncated),
      }
    },
    timeoutMs: 90000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const engines = bumpEngines()
      // DSH validates executed values as lossless JSON — strip any stray
      // undefined (e.g. optional published dates) before returning
      return cleanJsonValue(await runFused(engines, {
        query: args.query,
        queries: args.queries,
        engineList: args.engines,
        maxResults: Math.max(1, Math.min(args.max_results ?? 6, 10)),
        includeDomains: args.include_domains,
        excludeDomains: args.exclude_domains,
        recency: args.recency,
        complexity: args.complexity ?? 'auto',
        layer: args.layer ?? null,
        signal: exec?.signal,
      }))
    },
  })
}

function renderFused(value) {
  const lines = []
  lines.push(`**fused_search: "${value.query}"** — layer ${value.layer ?? 'api'}, tier ${value.tier}, ${value.results.length} hits, ${value.tookMs}ms${value.cacheHit ? ' (cache hit)' : ''}`)
  for (const [i, r] of value.results.entries()) {
    const eng = r.engines.join('+')
    lines.push(`${i + 1}. [${r.score}] ${r.title} — ${r.domain} (${eng})${r.published ? `, ${r.published}` : ''}`)
    lines.push(`   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet.slice(0, 200)}`)
  }
  const errs = Object.entries(value.engineStats ?? {}).filter(([, v]) => v.errors > 0)
  if (errs.length > 0) {
    lines.push(`engine errors: ${errs.map(([k, v]) => `${k}(${v.errors}: ${v.note ?? ''})`).join(', ')}`)
  }
  for (const w of value.warnings ?? []) {
    lines.push(`WARNING: ${w}`)
  }
  return lines.join('\n')
}

// ---------- fetch_page tool ----------

function registerFetchPageTool(ctx) {
  return ctx.tools.register({
    name: 'fetch_page',
    description:
      'Fetch and extract the full text content of one URL (Jina Reader markdown first, local HTML extraction fallback for blocked sites like github.com). ' +
      'Pass focus="<topic>" to keep only the paragraphs around that topic and save ~90% of tokens. Results are cached 24h.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'The http(s) URL to fetch.' },
        focus: { type: 'string', description: 'Optional topic to keep: only paragraphs containing these terms (plus context) are returned.' },
      },
      required: ['url'],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `fetch_page: ${hostOf(String(args?.url ?? '')) || String(args?.url ?? '').slice(0, 60)}`,
      kind: 'fetch',
      rawInput: args?.url,
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' }, via: { type: 'string' }, fetched_at: { type: 'string' },
          word_count: { type: 'number' }, content: { type: 'string' }, truncated: { type: 'boolean' },
          cacheHit: { type: 'boolean' }, tookMs: { type: 'number' },
        },
        required: ['url', 'via', 'content'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `**fetch_page: ${value.url}** — via ${value.via}, ${value.word_count} words, ${value.tookMs}ms${value.cacheHit ? ' (cache)' : ''}${value.truncated ? ' (truncated)' : ''}\n\n${value.content}`,
      }],
      presentationMeta: (_args, value) => ({
        url: value.url,
        via: value.via,
        statusCode: 200, // both fetch paths throw on non-2xx
        truncated: Boolean(value.truncated),
      }),
    },
    presentResult: (args, result) => {
      const meta = result.meta
      if (!meta || typeof meta.url !== 'string') return undefined
      return {
        card: 'web',
        kind: 'fetch',
        title: `fetch_page: ${meta.url}`,
        url: meta.url,
        statusCode: meta.statusCode ?? 200,
        truncated: Boolean(meta.truncated),
      }
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return cleanJsonValue(await fetchPage(String(args.url).trim(), args.focus, PAGE_CACHE, exec?.signal))
    },
  })
}

// ---------- x_search tool ----------

const X_MODES = ['keyword', 'semantic', 'user', 'thread']

function registerXSearchTool(ctx, bumpEngines) {
  return ctx.tools.register({
    name: 'x_search',
    description:
      'Search X (Twitter) in real time: posts, users, threads. keyword/semantic run as PARALLEL instant search — the hosted xAI x_search tool ' +
      '(grok login enabled via /x-login, or XAI_API_KEY) runs alongside the fused multi-engine route (site-restricted to x.com) and the results are merged, deduped by status id/url. ' +
      'Works even with NO credentials (routes straight to the multi-engine route + oEmbed full-text enhancement, ~2s); user mode gets a structured profile + recent timeline ' +
      'via X\'s anonymous guest GraphQL; thread mode via oEmbed. Four modes: keyword (X advanced syntax), semantic (natural language), user (accounts), thread (conversation by post id). ' +
      'Enable the official path with /x-login, disable it with /x-logout.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: X_MODES, description: 'Which X search mode: keyword (X advanced syntax), semantic (natural language), user (accounts), thread (conversation by post id).' },
        query: { type: 'string', description: 'The search query (keyword/semantic) or the target handle for user.' },
        username: { type: 'string', description: 'Target account for type=user.' },
        post_id: { type: 'string', description: 'Post id or x.com/.../status/<id> URL for type=thread.' },
        max_results: { type: 'number', description: 'Max results (default 5, max 10).' },
        from_date: { type: 'string', description: 'YYYY-MM-DD lower bound (keyword/semantic).' },
        to_date: { type: 'string', description: 'YYYY-MM-DD upper bound (keyword/semantic).' },
        allowed_x_handles: { type: 'array', items: { type: 'string' }, description: 'Hosted-tool handle filter (max 20).' },
        excluded_x_handles: { type: 'array', items: { type: 'string' }, description: 'Hosted-tool handle exclusion (max 20, mutually exclusive with allowed).' },
      },
      required: [],
    },
    presentCall: (args) => {
      const kind = X_MODES.includes(args?.type) ? args.type : 'keyword'
      const subj = args?.query ?? args?.username ?? args?.post_id ?? ''
      return { card: 'generic', title: `x_search ${kind}: "${String(subj).slice(0, 60)}"`, kind: 'search', rawInput: subj }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          via: { type: 'string' },
          results: { type: 'number' },
          tookMs: { type: 'number' },
          credential: { type: 'string' },
          note: { type: 'string' },
          error: { type: 'string' },
          cacheHit: { type: 'boolean' },
          inFlight: { type: 'boolean' },
          xResults: { type: 'number' },
          engineResults: { type: 'number' },
          items: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['via'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderX(value),
      }],
      presentationMeta: (_args, value) => {
        const sources = []
        for (const it of value.items ?? []) {
          const posts = Array.isArray(it.recent_posts) ? it.recent_posts : [it]
          for (const p of posts) {
            const text = String(p.text ?? '')
            const url = p.url ?? (p.id ? `https://x.com/i/status/${p.id}` : '')
            if (!url) continue
            sources.push({
              url,
              title: (p.author ? `${p.author}${p.username ? ` (@${p.username})` : ''}: ` : '') + text.slice(0, 120),
              ...(text ? { snippet: text.slice(0, 300) } : {}),
            })
          }
        }
        return { sources, truncated: false }
      },
    },
    presentResult: (args, result) => {
      const meta = result.meta
      if (!meta || !Array.isArray(meta.sources)) return undefined
      return {
        card: 'web',
        kind: 'search',
        title: `x_search: ${meta.sources.length} posts`,
        sources: meta.sources,
        truncated: Boolean(meta.truncated),
      }
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const started = Date.now()
      const signal = exec?.signal
      const kind = X_MODES.includes(args?.type) ? args.type : 'keyword'
      const subj = args.query ?? args.username ?? args.post_id ?? ''
      if (!subj) throw new Error('x_search: provide query (keyword/semantic/user) or post_id (thread).')
      const maxResults = Math.min(Math.max(args.max_results ?? 5, 1), 10)
      const engines = bumpEngines()

      const cacheKey = xSearchCacheKey(kind, args, maxResults)
      // single-flight: concurrent identical calls share one execution instead
      // of stampeding the hosted tool / engines
      const inFlight = X_INFLIGHT.get(cacheKey)
      if (inFlight) {
        return inFlight.then((out) => ({ ...out, cacheHit: false, inFlight: true, tookMs: 0 }))
      }

      const task = (async () => {
        const remember = (out) => {
          // DSH validates executed values as lossless JSON — strip stray
          // undefined (oEmbed/enhancement posts may carry undefined likes etc.)
          if (Array.isArray(out.items)) out.items = cleanJsonValue(out.items)
          if (out.via !== 'error' && out.results > 0) X_CACHE[kind].set(cacheKey, out)
          return out
        }

        const engineSearch = (q, n) => domainSearch(engines, { query: q, maxResults: n, signal })
        const webSearch = (q, n) =>
          engineSearch(q, n).then((hits) => hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet, domain: h.domain })))

        // the fallback chain: multi-engine (x.com) + oEmbed; guest GraphQL for user
        const runFallback = async (primaryErr) => {
          try {
            const fb = await fallbackXSearch({
              type: kind,
              query: args.query,
              username: args.username,
              post_id: args.post_id,
              limit: maxResults,
              signal,
              webSearch,
            })
            const items = Array.isArray(fb.data) ? fb.data : [fb.data]
            return remember({
              via: `fallback:${fb.via}`,
              results: items.length,
              tookMs: Date.now() - started,
              credential: `fallback:${fb.via}`,
              note: `primary failed: ${String(primaryErr).slice(0, 200)}`,
              items,
            })
          } catch (fbErr) {
            const msg = `${String(primaryErr)} | fallback: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`
            return { via: 'error', results: 0, tookMs: Date.now() - started, error: msg, items: [] }
          }
        }

        // preflight (sync, zero network): no official credentials → straight to
        // the multi-engine chain instead of waiting on a primary-path timeout
        if (!xAuthAvailableSync()) {
          const cachedNoAuth = X_CACHE[kind].get(cacheKey)
          if (cachedNoAuth) return { ...cachedNoAuth, cacheHit: true, tookMs: 0 }
          return runFallback('no xAI credentials (official path disabled — /x-login enables it)')
        }

        const cached = X_CACHE[kind].get(cacheKey)
        if (cached) return { ...cached, cacheHit: true, tookMs: 0 }

        // keyword/semantic: PARALLEL instant search — hosted x_search ∥ multi-engine
        if (kind === 'keyword' || kind === 'semantic') {
          const engQuery = args.query ?? (args.username ? `from:${args.username}` : subj)
          const [xOutcome, engOutcome] = await Promise.allSettled([
            runXTool(
              {
                type: kind,
                query: args.query,
                username: args.username,
                post_id: args.post_id,
                from_date: args.from_date,
                to_date: args.to_date,
                allowed_x_handles: args.allowed_x_handles,
                excluded_x_handles: args.excluded_x_handles,
                max_results: maxResults,
              },
              signal,
            ),
            engineSearch(engQuery, maxResults),
          ])
          if (xOutcome.status === 'fulfilled') {
            const xPosts = Array.isArray(xOutcome.value.data) ? xOutcome.value.data : []
            // engine results supplement: dedupe against x results by id/url
            const extra = engOutcome.status === 'fulfilled'
              ? engOutcome.value
                  .filter((h) => h.title || h.snippet)
                  .map(hitToPost)
                  .filter((p) => !xPosts.some((x) => {
                    if (x.id && p.id && x.id === p.id) return true
                    if (x.url && p.url && normalizeUrl(x.url) === normalizeUrl(p.url)) return true
                    return false
                  }))
              : []
            const merged = [...xPosts, ...extra]
            const credential = xOutcome.value.credential + (extra.length ? ' + multi-engine parallel' : '')
            return remember({
              via: 'parallel',
              results: merged.length,
              tookMs: Date.now() - started,
              credential,
              xResults: xPosts.length,
              engineResults: extra.length,
              items: merged,
            })
          }
          return runFallback(xOutcome.reason instanceof Error ? xOutcome.reason.message : String(xOutcome.reason))
        }

        // user/thread: serial primary path, fallback chain on failure
        try {
          const res = await runXTool(
            {
              type: kind,
              query: args.query,
              username: args.username,
              post_id: args.post_id,
              max_results: maxResults,
            },
            signal,
          )
          const items = Array.isArray(res.data) ? res.data : [res.data]
          return remember({ via: res.credential, results: items.length, tookMs: res.tookMs, credential: res.credential, items })
        } catch (err) {
          return runFallback(err instanceof Error ? err.message : String(err))
        }
      })()

      X_INFLIGHT.set(cacheKey, task)
      try {
        return await task
      } finally {
        X_INFLIGHT.delete(cacheKey)
      }
    },
  })
}

function renderItem(item) {
  if (Array.isArray(item.recent_posts)) {
    // user shape: profile + recent posts
    const posts = item.recent_posts.slice(0, 3)
    const followers = item.followers != null ? item.followers : '?'
    return `${item.name} (@${item.username}) — followers ${followers}, verified ${item.verified ?? false}\n  bio: ${item.bio ?? ''}\n  recent: ${posts.map((p) => String(p.text).slice(0, 80)).join(' | ') || '(none)'}`
  }
  const author = item.author ? item.author + (item.username ? ` (@${item.username})` : '') + ': ' : ''
  return `${author}${item.text || item.url}`
}

function renderX(value) {
  const lines = []
  lines.push(`**x_search** — via ${value.via}, ${value.results} result(s), ${value.tookMs}ms${value.cacheHit ? ' (cache hit)' : ''}`)
  if (value.note) lines.push(`note: ${value.note}`)
  if (value.error) {
    lines.push(`ERROR: ${value.error}`)
    return lines.join('\n')
  }
  for (const [i, item] of (value.items ?? []).entries()) {
    lines.push(`${i + 1}. ${renderItem(item)}`)
  }
  return lines.join('\n')
}

// ---------- /x-login / /x-logout commands ----------

function registerXLoginCommand(ctx) {
  const commands = ctx.get('commands')
  if (!commands) {
    console.error('[dsh-search-boost] commands service unavailable — /x-login not registered')
    return
  }
  return commands.register({
    name: 'x-login',
    description: 'Enable the official hosted x_search path: /x-login (import your grok login from ~/.grok/auth.json), /x-login -k <XAI_API_KEY> (public api.x.ai), /x-login status. /x-logout disables it again.',
    input: { hint: '[-k <XAI_API_KEY> | status]' },
    // the API key lives in the state file, not the session log — never record
    // the raw input (DSH idiom: the domain event owns the payload)
    recordInput: false,
    handler: ({ rawInput }) => {
      const parts = String(rawInput ?? '').trim().split(/\s+/)
      try {
        if (parts[0] === 'status') {
          const st = authStatus()
          return { kind: 'success', text: `x-login status — ${st.source}: ${st.detail}` }
        }
        if (parts[0] === '-k') {
          const key = parts[1] ?? ''
          importApiKey(key)
          invalidateSearchCaches()
          return { kind: 'success', text: `x-login: API key saved → ${piAuthPath()} (public api.x.ai will be used for x_search)` }
        }
        const entry = importFromGrok()
        invalidateSearchCaches()
        return {
          kind: 'success',
          text: `x-login: grok login imported → ${piAuthPath()} (${entry.email ?? entry.user_id ?? '?'}); official hosted x_search enabled. /x-logout disables it.`,
        }
      } catch (err) {
        return { kind: 'error', text: `x-login failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  })
}

function registerXLogoutCommand(ctx) {
  const commands = ctx.get('commands')
  if (!commands) {
    console.error('[dsh-search-boost] commands service unavailable — /x-logout not registered')
    return
  }
  return commands.register({
    name: 'x-logout',
    description: 'Remove the /x-login credentials: the official hosted x_search path is disabled and x_search uses only the multi-engine / guest-GraphQL / oEmbed fallback chain. grok CLI\'s own login is untouched. Usage: /x-logout',
    handler: () => {
      const removed = logout()
      invalidateSearchCaches()
      return {
        kind: 'success',
        text: removed
          ? 'x-logout: /x-login credentials removed — x_search now uses the multi-engine / guest-GraphQL / oEmbed fallback chain only.\nRun /x-login to re-enable the official hosted x_search path. (grok CLI\'s own login is untouched.)'
          : 'x-logout: no /x-login credentials found — x_search is already on the fallback chain. Run /x-login to enable the official path.',
      }
    },
  })
}

// ---------- deep_research tool ----------

function registerDeepResearchTool(ctx, bumpEngines) {
  return ctx.tools.register({
    name: 'deep_research',
    description:
      'Step-mode deep research: ONE round of complex fused search + coverage analysis (which query terms each source covers) ' +
      '+ cross-domain corroboration stats + coverage gaps + suggested next queries. ' +
      'You (the agent) drive the loop: call it again with suggested_queries until gaps is empty, then synthesize the final answer with citations. ' +
      'For single-source claims or when a snippet is thin, verify with fetch_page on the top URLs before citing. ' +
      'Use for multi-source synthesis, comparisons, surveys, or any question needing corroborated evidence. ' +
      'Stop when gaps is empty or after max_rounds rounds (3 max) — do not loop on the same query.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The research question.' },
        goal: { type: 'string', description: 'Optional: what the final answer must establish.' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Optional extra query variants for round 1.' },
        max_sources: { type: 'number', description: 'Max sources to analyze (default 8).' },
        recency: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Recency window for round 1.' },
        layer: { type: 'string', enum: ['free', 'api'], description: 'Override the active layer for this call (default: current /web_change layer).' },
      },
      required: ['query'],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `deep_research: "${String(args?.query ?? '').slice(0, 60)}"`,
      kind: 'search',
      rawInput: args?.query,
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          round: { type: 'number' }, query: { type: 'string' },
          queriesUsed: { type: 'array', items: { type: 'string' } },
          tookMs: { type: 'number' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' }, url: { type: 'string' }, domain: { type: 'string' },
                snippet: { type: 'string' }, covered: { type: 'number' }, total: { type: 'number' },
                corroborated: { type: 'boolean' }, engines: { type: 'array', items: { type: 'string' } },
                published: { type: 'string' },
              },
              required: ['title', 'url', 'domain'],
            },
          },
          gaps: { type: 'array', items: { type: 'string' } },
          suggested_queries: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['query', 'sources', 'gaps', 'suggested_queries'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderResearch(value),
      }],
      presentationMeta: (_args, value) => ({
        round: value.round,
        sourceCount: (value.sources ?? []).length,
        gapsCount: (value.gaps ?? []).length,
        suggestedCount: (value.suggested_queries ?? []).length,
      }),
    },
    presentResult: (args, result) => {
      const meta = result.meta
      if (!meta) return undefined
      return {
        card: 'generic',
        title: `deep_research: round ${meta.round}, ${meta.sourceCount} sources, ${meta.gapsCount} gaps${meta.suggestedCount ? `, ${meta.suggestedCount} suggested` : ''}`,
      }
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const engines = bumpEngines()
      const active = args.layer ?? getLayer()
      return cleanJsonValue(await researchRound({
        query: args.query,
        queries: args.queries,
        maxSources: Math.min(args.max_sources ?? 8, 12),
        recency: args.recency,
        layer: active,
        engines: availableEngines(engines, layerTierTable(active).complex),
        runOne: (engineName, q, n, o) => runEngine(engines, engineName, q, n, o),
        signal: exec?.signal,
      }))
    },
  })
}

function renderResearch(value) {
  const lines = []
  lines.push(`**deep_research round ${value.round}: "${value.query}"** — ${value.tookMs}ms`)
  lines.push(`sources (${value.sources.length}):`)
  for (const s of value.sources) {
    lines.push(`- [${s.covered}/${s.total}] ${s.corroborated ? '✅佐证' : '⚠️单源'} ${s.title} — ${s.domain}${s.published ? ` (${s.published})` : ''}`)
    lines.push(`  ${s.url}`)
    if (s.snippet) lines.push(`  ${s.snippet}`)
  }
  lines.push(`gaps: ${value.gaps.length === 0 ? 'none' : value.gaps.join(', ')}`)
  if (value.suggested_queries.length > 0) {
    lines.push(`suggested next queries: ${value.suggested_queries.join(' | ')}`)
  }
  return lines.join('\n')
}

// ---------- research_parallel tool ----------

function registerParallelTool(ctx) {
  return ctx.tools.register({
    name: 'research_parallel',
    description:
      'Parallel multi-agent research: decompose a question into sub-queries (or take yours), spawn one subagent per sub-query ' +
      '(each with its own context window, inheriting fused_search/fetch_page), run them in parallel under a time budget, ' +
      'and merge their findings and sources. Use for large multi-angle research where one agent would be slow or shallow. ' +
      'Pass 2-4 independent sub_queries covering different angles; when omitted, 3 heuristic angles are derived.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The research question.' },
        goal: { type: 'string', description: 'Optional: what the final answer must establish.' },
        sub_queries: { type: 'array', items: { type: 'string' }, description: 'Optional 2-4 independent sub-queries.' },
        max_seconds: { type: 'number', description: 'Time budget in seconds (default 120, max 300).' },
        max_sources: { type: 'number', description: 'Max results per subagent search (default 6).' },
      },
      required: ['query'],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `research_parallel: "${String(args?.query ?? '').slice(0, 60)}"`,
      kind: 'search',
      rawInput: args?.query,
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          sub_tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          merged_sources: { type: 'array', items: { type: 'string' } },
          took_ms: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['query', 'sub_tasks', 'merged_sources'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderParallel(value),
      }],
      presentationMeta: (_args, value) => ({
        taskCount: (value.sub_tasks ?? []).length,
        sourceCount: (value.merged_sources ?? []).length,
      }),
    },
    presentResult: (args, result) => {
      const meta = result.meta
      if (!meta) return undefined
      return {
        card: 'generic',
        title: `research_parallel: ${meta.taskCount} tasks, ${meta.sourceCount} merged sources`,
      }
    },
    timeoutMs: 310000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const subagents = ctx.get('subagents')
      return cleanJsonValue(await parallelResearch({
        query: args.query,
        goal: args.goal,
        subQueries: args.sub_queries,
        maxSeconds: args.max_seconds,
        maxSources: args.max_sources,
        subagents,
        agent: exec.agent,
        signal: exec.signal,
      }))
    },
  })
}

function renderParallel(value) {
  const lines = []
  lines.push(`**research_parallel: "${value.query}"** — ${value.sub_tasks.length} tasks, ${value.took_ms}ms`)
  lines.push(`merged sources (${value.merged_sources.length}):`)
  for (const u of value.merged_sources.slice(0, 12)) lines.push(`- ${u}`)
  for (const st of value.sub_tasks) {
    lines.push(`\n--- [${st.status}] ${st.title} ---`)
    lines.push(st.output.slice(0, 1200))
  }
  return lines.join('\n')
}

// ---------- /web_change command ----------

// Switches the active search layer at runtime (free = keyless engines only;
// api = full pool). Persisted to ~/.dsh-search-boost-layer.json, so the
// choice survives reloads. Uses the host `commands` service (registered via
// ctx.commands.register) — the same seam built-in slash commands use.
function registerWebChangeCommand(ctx, bumpEngines) {
  const commands = ctx.get('commands')
  if (!commands) {
    console.error('[dsh-search-boost] commands service unavailable — /web_change not registered')
    return
  }
  const show = () => {
    const engines = bumpEngines()
    const layer = getLayer()
    const keys = loadKeys()
    const names = layer === 'free'
      ? FREE_DOMAIN_ENGINES
      : [...FREE_DOMAIN_ENGINES, 'antigravity', 'tavily', 'brave', 'exa']
    const actual = availableEngines(engines, names)
    const avail = Object.entries({
      bing: engines.bing?.available(),
      ddg: engines.ddg?.available(),
      yahoo: engines.yahoo?.available(),
      'exa-free': engines['exa-free']?.available(),
      antigravity: engines.antigravity?.available(),
      tavily: Boolean(keys.tavily),
      brave: Boolean(keys.brave),
      exa: Boolean(keys.exa),
    }).filter(([, v]) => v).map(([k]) => k)
    return [
      `current layer: **${layer}** — ${LAYER_LABELS[layer]}`,
      `engines available in this layer: ${actual.join(', ') || '(none)'}`,
      `all engines now: ${avail.join(', ') || '(none)'}`,
      `usage: /web_change [free|api|show]`,
    ].join('\n')
  }
  return commands.register({
    name: 'web_change',
    description: 'Switch search layer: free (keyless bing/ddg/yahoo/exa-free) vs api (full pool incl. agy + keyed tavily/brave/exa). Usage: /web_change [free|api|show]',
    input: { hint: 'free | api | show' },
    handler: ({ rawInput }) => {
      const cmd = rawInput.trim().toLowerCase()
      try {
        if (cmd === 'free' || cmd === 'api') {
          setLayer(cmd)
          invalidateSearchCaches()
          return { kind: 'success', text: `web layer → **${cmd}** — ${LAYER_LABELS[cmd]}. Future searches use this layer.` }
        }
        if (cmd === 'show' || cmd === '') {
          return { kind: 'success', text: show() }
        }
        return { kind: 'error', text: 'usage: /web_change [free|api|show]' }
      } catch (err) {
        return { kind: 'error', text: `web_change failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  })
}

// ---------- search_stats tool ----------

function registerStatsTool(ctx, bumpEngines) {
  return ctx.tools.register({
    name: 'search_stats',
    description: 'dsh-search-boost audit: cache hits/misses, tier distribution, engine availability, and the most recent searches.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    presentCall: () => ({
      card: 'generic',
      title: 'dsh-search-boost stats',
      kind: 'other',
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          startedAt: { type: 'string' }, cacheHits: { type: 'number' }, cacheMisses: { type: 'number' },
          tierCounts: { type: 'object' }, engines: { type: 'object' }, grok: { type: 'boolean' },
          x: { type: 'object', additionalProperties: true },
          layer: { type: 'string' },
          caches: { type: 'object', additionalProperties: true },
          recent: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['startedAt'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `**dsh-search-boost stats** (since ${value.startedAt})\n` +
          `layer: ${value.layer ?? 'api'} (switch with /web_change)\n` +
          `cache: ${value.cacheHits} hits / ${value.cacheMisses} misses\n` +
          `tiers: ${JSON.stringify(value.tierCounts)}\n` +
          `engines: ${JSON.stringify(value.engines)}\n` +
          `x_search: ${value.grok ? 'official path ready' : 'fallback chain only'} (${value.x?.source ?? '?'}${value.x?.official ? ', enabled' : ', disabled'})\n` +
          `recent: ${value.recent.map((r) => `"${r.query}"(${r.tookMs}ms,${r.results}r${r.cacheHit ? ',hit' : ''})`).join(' | ')}`,
      }],
      presentationMeta: (_args, value) => ({
        cacheHits: value.cacheHits,
        cacheMisses: value.cacheMisses,
        layer: value.layer ?? 'api',
        xOfficial: Boolean(value.grok),
      }),
    },
    presentResult: (args, result) => {
      const meta = result.meta
      if (!meta) return undefined
      return {
        card: 'generic',
        title: `search stats: ${meta.cacheHits} cache hits / ${meta.cacheMisses} misses (${meta.layer}, x_search ${meta.xOfficial ? 'official' : 'fallback'})`,
      }
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    async execute() {
      const engines = bumpEngines()
      const xSource = authStatus()
      return cleanJsonValue({
        startedAt: stats.startedAt,
        layer: getLayer(),
        cacheHits: stats.cacheHits,
        cacheMisses: stats.cacheMisses,
        tierCounts: stats.tierCounts,
        engines: {
          bing: engines.bing?.available() ?? false,
          ddg: engines.ddg?.available() ?? false,
          yahoo: engines.yahoo?.available() ?? false,
          'exa-free': engines['exa-free']?.available() ?? false,
          antigravity: engines.antigravity?.available() ?? false,
          tavily: engines.tavily?.available() ?? false,
          brave: engines.brave?.available() ?? false,
          exa: engines.exa?.available() ?? false,
        },
        caches: {
          search: SEARCH_CACHE.size(),
          page: PAGE_CACHE.size(),
          x_keyword: X_CACHE.keyword.size(),
          x_semantic: X_CACHE.semantic.size(),
          x_user: X_CACHE.user.size(),
          x_thread: X_CACHE.thread.size(),
        },
        grok: xAuthAvailableSync(),
        x: { official: xAuthAvailableSync(), source: xSource.source },
        recent: stats.recent.slice(0, 10),
      })
    },
  })
}
