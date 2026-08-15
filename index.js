// dsh-search-boost — DeepSeek Harness bundle plugin.
//
// Loaded via cordis.patch.yml rows (see package.json `dsh.bundle` manifest):
// one row mounts this plugin, one repoints the `web` seam's `searchProvider`
// at it, so the built-in `web_search` runs on our free-by-default engine chain
// (Antigravity CLI → Bing → Tavily → Brave → Exa) while keeping the native
// citation cards. Beside the provider, we register our own tools: fused_search
// (multi-engine fusion), fetch_page (focused page reading), and x_search (X /
// Twitter via the local Grok Build CLI).
//
// This plugin runs inside the dsh host process, so it uses Node's fetch /
// child_process directly — no sandbox shell indirection needed.

import { loadKeys, engineRegistry, runChain, ENGINE_ORDER } from './lib/engines.js'
import { fusedSearch, makeCache, estimateComplexity } from './lib/fusion.js'
import { fetchPage, makePageCache } from './lib/fetch.js'
import { searchX, grokAvailable } from './lib/grok.js'
import { SEARCH_POLICY_SECTION } from './lib/policy.js'
import { researchRound, parallelResearch, setTimer } from './lib/research.js'

export const name = 'dsh-search-boost'
export const inject = ['web', 'tools', 'systemPrompt']

const SEARCH_CACHE = makeCache()
const PAGE_CACHE = makePageCache()
const stats = { startedAt: new Date().toISOString(), cacheHits: 0, cacheMisses: 0, tierCounts: {}, recent: [] }

export function apply(ctx, config = {}) {
  const keys = loadKeys()
  const engines = engineRegistry(keys)

  const safe = (label, fn) => {
    try {
      fn()
    } catch (err) {
      console.error(`[dsh-search-boost] ${label} registration failed:`, err instanceof Error ? err.message : String(err))
    }
  }
  safe('searchProvider', () => { if (config.searchProvider !== false) registerSearchProvider(ctx, engines) })
  safe('fused_search', () => { if (config.fusedSearch !== false) registerFusedSearchTool(ctx, engines) })
  safe('fetch_page', () => { if (config.fetchPage !== false) registerFetchPageTool(ctx) })
  safe('x_search', () => { if (config.xSearch !== false) registerXSearchTool(ctx) })
  safe('deep_research', () => { if (config.deepResearch !== false) registerDeepResearchTool(ctx, engines) })
  safe('research_parallel', () => { if (config.researchParallel !== false) registerParallelTool(ctx) })
  safe('search_stats', () => { if (config.searchStats !== false) registerStatsTool(ctx) })
  safe('policy section', () => ctx.systemPrompt?.section(SEARCH_POLICY_SECTION))
  try {
    setTimer((ms) => ctx.timeout(ms))
  } catch (err) {
    console.error('[dsh-search-boost] timer setup failed:', err instanceof Error ? err.message : String(err))
  }
}

// ---------- web seam provider (powers the built-in web_search) ----------

function registerSearchProvider(ctx, engines) {
  ctx.web.registerSearchProvider({
    id: 'dsh-search-boost',
    available: () => true,
    async search(request, signal) {
      const count = request.maxResults ?? 6
      const { engine, hits } = await runChain(engines, request.query, Math.min(count, 10), {})
      return {
        content: `[dsh-search-boost] answered via ${engine}`,
        sources: hits.slice(0, count).map((h) => ({
          url: h.url,
          ...(h.title ? { title: h.title } : {}),
          ...(h.snippet ? { snippet: h.snippet.slice(0, 300) } : {}),
          ...(h.published ? { publishedAt: h.published } : {}),
        })),
        truncated: hits.length > count,
      }
    },
  })
}

// ---------- fused_search tool ----------

function registerFusedSearchTool(ctx, engines) {
  ctx.tools.register({
    name: 'fused_search',
    description:
      'Multi-engine fused web search (Antigravity CLI free → Bing → Tavily → Brave → Exa, parallel where possible). ' +
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
        engines: { type: 'array', items: { type: 'string', enum: ENGINE_ORDER }, description: 'Engines to use (default by complexity tier).' },
        max_results: { type: 'number', description: 'Max results to return (default 6, max 10).' },
        include_domains: { type: 'array', items: { type: 'string' }, description: 'Only keep results from these domains (subdomain match).' },
        exclude_domains: { type: 'array', items: { type: 'string' }, description: 'Drop results from these domains (subdomain match).' },
        recency: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Recency window; older results decay exponentially.' },
        complexity: { type: 'string', enum: ['auto', 'simple', 'medium', 'complex'], description: 'Search budget (auto by default).' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          tier: { type: 'string' },
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
        },
        required: ['query', 'results'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderFused(value),
      }],
    },
    timeoutMs: 90000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const maxResults = Math.min(args.max_results ?? 6, 10)
      const key = JSON.stringify({ v: 1, q: args.query, qs: args.queries ?? [], e: args.engines ?? [], id: args.include_domains ?? [], xd: args.exclude_domains ?? [], rec: args.recency ?? null, m: maxResults })
      const cached = SEARCH_CACHE.get(key)
      if (cached) {
        stats.cacheHits++
        stats.recent.unshift({ query: args.query, tookMs: 0, results: cached.results.length, cacheHit: true })
        if (stats.recent.length > 20) stats.recent.pop()
        return { ...cached, cacheHit: true, tookMs: 0 }
      }
      stats.cacheMisses++
      const tier = args.complexity ?? 'auto'
      const result = await fusedSearch({
        query: args.query,
        queries: args.queries,
        engines: args.engines,
        maxResults,
        includeDomains: args.include_domains,
        excludeDomains: args.exclude_domains,
        recency: args.recency,
        tier,
        runOne: async (engineName, q, n, o) => {
          const engine = engines[engineName]
          if (!engine?.available()) throw new Error(`${engineName} unavailable`)
          return engine.search(q, n, o)
        },
      })
      stats.tierCounts[result.tier] = (stats.tierCounts[result.tier] ?? 0) + 1
      stats.recent.unshift({ query: args.query, tookMs: result.tookMs, results: result.results.length, cacheHit: false })
      if (stats.recent.length > 20) stats.recent.pop()
      SEARCH_CACHE.set(key, result)
      return result
    },
  })
}

function renderFused(value) {
  const lines = []
  lines.push(`**fused_search: "${value.query}"** — tier ${value.tier}, ${value.results.length} hits, ${value.tookMs}ms${value.cacheHit ? ' (cache hit)' : ''}`)
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
  return lines.join('\n')
}

// ---------- fetch_page tool ----------

function registerFetchPageTool(ctx) {
  ctx.tools.register({
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
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return fetchPage(String(args.url).trim(), args.focus, PAGE_CACHE)
    },
  })
}

// ---------- x_search tool ----------

function registerXSearchTool(ctx) {
  ctx.tools.register({
    name: 'x_search',
    description:
      'Search X (Twitter) posts through the local Grok Build CLI. Use for questions about posts, threads, accounts, or discussions on X: ' +
      'what someone posted, reactions to an event, sentiment in a community. Returns structured evidence with a summary and per-post items with URLs. ' +
      'Requires Grok Build installed and signed in (~/.grok/auth.json).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What to look for on X (accounts, topics, time bounds in plain words).' },
        max_results: { type: 'number', description: 'Maximum number of result items (default 8).' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' }, source: { type: 'string' }, summary: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' },
                source: { type: 'string' }, published_at: { type: 'string' },
              },
              required: ['title', 'url'],
            },
          },
          uncertainty: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'items'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderX(value),
      }],
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (typeof args?.query !== 'string' || args.query.trim() === '') {
        throw new Error('x_search needs a non-empty string "query".')
      }
      return searchX(args.query, Math.floor(args.max_results ?? 8), exec.signal)
    },
  })
}

function renderX(value) {
  const lines = []
  if (value.status === 'degraded') {
    lines.push(`[X was unreachable; a ${value.source} search answered second-hand. Treat as indirect evidence.]`)
  }
  lines.push(value.summary)
  const items = value.items ?? []
  if (items.length > 0) {
    lines.push('', 'Results:')
    items.forEach((item, index) => {
      const dated = item.published_at ? ` (${item.published_at})` : ''
      lines.push(`${index + 1}. ${item.title}${dated} — ${item.url}`)
      if (item.snippet) lines.push(`   ${item.snippet}`)
    })
  }
  const uncertainty = value.uncertainty ?? []
  if (uncertainty.length > 0) {
    lines.push('', `Uncertain: ${uncertainty.join('; ')}`)
  }
  return lines.join('\n')
}

// ---------- deep_research tool ----------

function registerDeepResearchTool(ctx, engines) {
  ctx.tools.register({
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
      },
      required: ['query'],
    },
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
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return researchRound({
        query: args.query,
        queries: args.queries,
        maxSources: Math.min(args.max_sources ?? 8, 12),
        recency: args.recency,
        runOne: async (engineName, q, n, o) => {
          const engine = engines[engineName]
          if (!engine?.available()) throw new Error(`${engineName} unavailable`)
          return engine.search(q, n, o)
        },
      })
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
  ctx.tools.register({
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
    },
    timeoutMs: 310000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const subagents = ctx.get('subagents')
      return parallelResearch({
        query: args.query,
        goal: args.goal,
        subQueries: args.sub_queries,
        maxSeconds: args.max_seconds,
        maxSources: args.max_sources,
        subagents,
        agent: exec.agent,
        signal: exec.signal,
      })
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

// ---------- search_stats tool ----------

function registerStatsTool(ctx) {
  ctx.tools.register({
    name: 'search_stats',
    description: 'dsh-search-boost audit: cache hits/misses, tier distribution, engine availability, and the most recent searches.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          startedAt: { type: 'string' }, cacheHits: { type: 'number' }, cacheMisses: { type: 'number' },
          tierCounts: { type: 'object' }, engines: { type: 'object' }, grok: { type: 'boolean' },
          recent: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['startedAt'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `**dsh-search-boost stats** (since ${value.startedAt})\n` +
          `cache: ${value.cacheHits} hits / ${value.cacheMisses} misses\n` +
          `tiers: ${JSON.stringify(value.tierCounts)}\n` +
          `engines: ${JSON.stringify(value.engines)}\n` +
          `grok (X): ${value.grok ? 'ready' : 'not available'}\n` +
          `recent: ${value.recent.map((r) => `"${r.query}"(${r.tookMs}ms,${r.results}r${r.cacheHit ? ',hit' : ''})`).join(' | ')}`,
      }],
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    async execute() {
      const keys = loadKeys()
      return {
        startedAt: stats.startedAt,
        cacheHits: stats.cacheHits,
        cacheMisses: stats.cacheMisses,
        tierCounts: stats.tierCounts,
        engines: {
          antigravity: await pathExists('agy'),
          bing: true,
          tavily: Boolean(keys.tavily),
          brave: Boolean(keys.brave),
          exa: Boolean(keys.exa),
        },
        grok: grokAvailable(),
        recent: stats.recent.slice(0, 10),
      }
    },
  })
}

const pathCache = new Map()
async function pathExists(bin) {
  if (pathCache.has(bin)) return pathCache.get(bin)
  const fs = await import('node:fs')
  const path = await import('node:path')
  const pathEnv = process.env.PATH ?? ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  let found = false
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    for (const e of exts) {
      try {
        fs.statSync(path.join(dir, bin + e))
        found = true
        break
      } catch { /* keep looking */ }
    }
    if (found) break
  }
  pathCache.set(bin, found)
  return found
}
