// Fusion scoring, query preprocessing, and TTL cache.
// Ported from the session-level plugin (plugin-host.js) — same proven math:
// rank weight + cross-engine bonus + domain quality + term relevance +
// Grok-style half-life recency decay + min_score pruning + per-domain cap.

export const CACHE_TTL_MS = 6 * 3600 * 1000

// Free engines run in parallel on every tier (bing + ddg curl scrapes, plus
// agy CLI where installed); keyed engines (tavily/brave/exa) join per tier.
export const TIER_ENGINES = {
  simple: ['bing', 'ddg', 'antigravity'],
  medium: ['bing', 'ddg', 'antigravity', 'tavily'],
  complex: ['bing', 'ddg', 'antigravity', 'tavily', 'brave', 'exa'],
}
export const TIER_VARIANTS = { simple: 1, medium: 2, complex: 3 }

const RESEARCH_SIGNALS =
  /compare|comparison|comparative|versus|vs\.?|difference|architecture|design|implement|how to|why|what is the best|review|benchmark|survey|tutorial|guide|optimization|performance|最新|综述|对比|区别|架构|设计|实现|原理|怎么|如何|选型|方案/i

const RECENCY_HALF_LIFE_DAYS = { day: 0.5, week: 3, month: 15, year: 90 }

const ENGINE_WEIGHT = { bing: 1.0, ddg: 1.0, antigravity: 1.0, tavily: 1.2, exa: 1.2, brave: 1.1 }
const JUNK_DOMAINS = new Set([
  'pinterest.com', 'pinterest.ca', 'instagram.com', 'facebook.com', 'facebook.net',
  'tiktok.com', 'linkedin.com', 'x.com', 'twitter.com', 'youtube.com',
])
const AUTHORITATIVE_TLDS = ['.gov', '.edu', '.mil']

export const collapseSpace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

export function hostOf(url) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(String(url))
  return m ? m[1].toLowerCase().replace(/^www\./, '') : ''
}

export function normalizeUrl(url) {
  let s = String(url).trim()
  const hash = s.indexOf('#')
  const noFrag = hash >= 0 ? s.slice(0, hash) : s
  const q = noFrag.indexOf('?')
  if (q >= 0) {
    const base = noFrag.slice(0, q)
    const kept = noFrag.slice(q + 1).split('&').filter((kv) => {
      const k = kv.split('=')[0].toLowerCase()
      return !/^(utm_|via|ref|fpr|pk_|mtm_|gclid|fbclid|mc_cid|mc_eid)/.test(k)
    })
    s = kept.length > 0 ? `${base}?${kept.join('&')}` : base
  } else {
    s = noFrag
  }
  return s.replace(/\/+$/, '').toLowerCase()
}

const domainMatches = (domain, d) => domain === d || domain.endsWith('.' + d)

export function queryTerms(text) {
  const out = []
  const lower = String(text ?? '').toLowerCase()
  for (const m of lower.match(/[a-z0-9][a-z0-9\-_.]{1,}/g) || []) {
    if (m.length >= 2 && !/^\d+$/.test(m)) out.push(m)
  }
  for (const run of lower.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

export function preprocessQuery(raw) {
  let q = String(raw ?? '').trim()
  const includeDomains = []
  const excludeDomains = []
  q = q.replace(/(?:^|\s)(-?)site:([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi, (_m, neg, d) => {
    ;(neg ? excludeDomains : includeDomains).push(d.toLowerCase())
    return ' '
  })
  const alternatives = []
  const orParts = q.split(/\s+OR\s+/i)
  if (orParts.length > 1) {
    q = orParts[0]
    for (const part of orParts.slice(1)) {
      const sub = preprocessQuery(part)
      alternatives.push(sub.cleaned, ...sub.alternatives)
      includeDomains.push(...sub.includeDomains)
      excludeDomains.push(...sub.excludeDomains)
    }
  }
  q = q.replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim()
  return {
    cleaned: q,
    includeDomains: [...new Set(includeDomains)],
    excludeDomains: [...new Set(excludeDomains)],
    alternatives: [...new Set(alternatives.filter((a) => a && a !== q))],
  }
}

export function estimateComplexity(query) {
  if (RESEARCH_SIGNALS.test(query)) return 'complex'
  const n = queryTerms(query).length
  if (n <= 2) return 'simple'
  if (n <= 4) return 'medium'
  return 'complex'
}

export function parseDate(raw) {
  if (!raw) return null
  const t = String(raw).trim()
  let m = /(\d{4})年(\d{1,2})月(\d{1,2})?日?/.exec(t)
  if (m) {
    const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3] ? m[3].padStart(2, '0') : '01'}`
    return Number.isNaN(Date.parse(d)) ? null : d
  }
  m = /([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/.exec(t)
  if (m) {
    const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const d = `${m[3]}-${String(MON.indexOf(m[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`
    return Number.isNaN(Date.parse(d)) ? null : d
  }
  m = /(\d{4}-\d{2}-\d{2})/.exec(t)
  if (m) return m[1]
  return null
}

/**
 * Run a fused search: N engines in parallel on the primary query, then merge,
 * score and prune. `runOne(engine, query, count, opts)` returns RawHit[].
 */
export async function fusedSearch({ query, queries, engines, maxResults = 6, includeDomains = [], excludeDomains = [], recency, tier = 'auto', runOne }) {
  const started = Date.now()
  const resolvedTier = tier === 'auto' ? estimateComplexity(query) : tier
  const engineNames = (engines ?? TIER_ENGINES[resolvedTier]).filter((e) => runOne)

  const parsed = [query, ...(queries ?? [])].map(preprocessQuery)
  includeDomains = [
    ...includeDomains,
    ...parsed.flatMap((p) => p.includeDomains),
  ].map((d) => d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, ''))
  excludeDomains = [
    ...excludeDomains,
    ...parsed.flatMap((p) => p.excludeDomains),
  ].map((d) => d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, ''))

  const variantPool = [...new Set(parsed.flatMap((p) => [p.cleaned, ...p.alternatives]).filter(Boolean))]
  if (variantPool.length === 0) variantPool.push(query)
  const variants = variantPool.slice(0, TIER_VARIANTS[resolvedTier])

  const maxPerEngine = Math.max(4, Math.ceil(maxResults * 0.75))
  const perEngineHits = new Map()
  const engineStats = {}
  for (const e of engineNames) engineStats[e] = { used: true, errors: 0 }

  const tasks = []
  for (const e of engineNames) tasks.push({ engine: e, query: variants[0] })
  for (let i = 1; i < variants.length; i++) {
    for (const e of ['bing', 'ddg', 'tavily']) {
      if (engineNames.includes(e)) tasks.push({ engine: e, query: variants[i] })
    }
  }

  await Promise.all(tasks.map(async (task) => {
    const key = `${task.engine}\u0000${task.query}`
    try {
      const hits = await runOne(task.engine, task.query, maxPerEngine, { includeDomains, excludeDomains, recency, depth: resolvedTier === 'complex' ? 'advanced' : 'basic' })
      perEngineHits.set(key, hits)
    } catch (err) {
      engineStats[task.engine].errors++
      engineStats[task.engine].note = (err instanceof Error ? err.message : String(err)).slice(0, 120)
      perEngineHits.set(key, [])
    }
  }))

  // merge
  const merged = new Map()
  for (const task of tasks) {
    const hits = perEngineHits.get(`${task.engine}\u0000${task.query}`) ?? []
    hits.forEach((hit, rank) => {
      const norm = normalizeUrl(hit.url)
      if (!/^https?:\/\//i.test(norm)) return
      const domain = hostOf(norm)
      if (!domain) return
      if (excludeDomains.some((d) => domainMatches(domain, d))) return
      if (includeDomains.length > 0 && !includeDomains.some((d) => domainMatches(domain, d))) return
      const existing = merged.get(norm)
      const score = (ENGINE_WEIGHT[task.engine] ?? 1.0) * Math.max(0, 1 - rank / 10)
      const published = hit.published ? parseDate(hit.published) : null
      if (existing) {
        if (!existing.engines.includes(task.engine)) existing.engines.push(task.engine)
        existing.score += score
        if (rank === 0) existing.snippet = existing.snippet || hit.snippet
        if (existing.published == null && published) existing.published = published
        if (hit.content && (!existing.content || existing.content.length > hit.content.length)) existing.content = hit.content
      } else {
        merged.set(norm, { title: hit.title || norm, url: norm, domain, snippet: hit.snippet ?? '', engines: [task.engine], score, published, content: hit.content })
      }
    })
  }

  // score
  const halfLifeMs = recency ? RECENCY_HALF_LIFE_DAYS[recency] * 86400000 : undefined
  const relTerms = queryTerms(query)
  const ranked = [...merged.values()]
    .map((r) => {
      const cross = Math.min(2.4, (r.engines.length - 1) * 0.8)
      const hay = `${r.title} ${r.snippet}`.toLowerCase()
      let termHits = 0
      for (const t of relTerms) {
        if (t.length >= 2 && hay.includes(t.toLowerCase())) termHits++
      }
      const rel = termHits > 0 ? Math.min(termHits, 3) * 0.25 : -0.6
      let rec = 0
      if (halfLifeMs !== undefined) {
        if (r.published) {
          const t = Date.parse(r.published)
          if (!Number.isNaN(t)) {
            const ageMs = Date.now() - t
            rec = ageMs > 0 ? 0.6 * Math.pow(0.5, ageMs / halfLifeMs) : 0.6
          } else {
            rec = -0.1
          }
        } else {
          rec = -0.1
        }
      }
      const bonus = (() => {
        if (AUTHORITATIVE_TLDS.some((t) => r.domain.endsWith(t))) return 0.6
        if (r.domain === 'wikipedia.org' || r.domain === 'github.com') return 0.4
        if (JUNK_DOMAINS.has(r.domain)) return -0.5
        return 0
      })()
      return { ...r, score: Math.round((r.score + cross + rel + rec + bonus) * 100) / 100 }
    })
    .sort((a, b) => b.score - a.score)

  // prune: per-domain cap 2, min_score 0
  // Borrowed from xai-org/x-algorithm (Apache-2.0, X For You feed):
  //  - repeated-author decay  → repeated-domain decay: a 2nd result from the
  //    same domain scores 0.7x instead of being hard-cut, so variety wins
  //    when two same-domain hits are both strong
  //  - out-of-network discount → single-engine discount: a result found by
  //    only one engine gets 0.9x (the X feed discounts content outside the
  //    viewer's network; our analog is "found by exactly one engine")
  const REPEATED_DOMAIN_DECAY = 0.7
  const SINGLE_ENGINE_DISCOUNT = 0.9
  const perDomain = new Map()
  const discounted = []
  for (const r of ranked) {
    let s = r.score
    if (r.engines.length <= 1) s *= SINGLE_ENGINE_DISCOUNT
    const n = perDomain.get(r.domain) ?? 0
    if (n > 0) s *= Math.pow(REPEATED_DOMAIN_DECAY, n)
    perDomain.set(r.domain, n + 1)
    discounted.push({ ...r, score: Math.round(s * 100) / 100 })
  }
  discounted.sort((a, b) => b.score - a.score)
  const capped = []
  const cappedDomains = new Map()
  for (const r of discounted) {
    if (r.score < 0) continue
    const n = cappedDomains.get(r.domain) ?? 0
    if (n >= 2) continue
    cappedDomains.set(r.domain, n + 1)
    capped.push(r)
    if (capped.length >= maxResults) break
  }

  const clean = capped.map((r) => {
    const item = { title: r.title, url: r.url, domain: r.domain, snippet: r.snippet, score: r.score, engines: r.engines }
    if (r.published) item.published = r.published
    return item
  })

  return {
    query,
    tier: resolvedTier,
    engineStats,
    results: clean,
    tookMs: Date.now() - started,
    cacheHit: false,
  }
}

/** In-memory TTL cache keyed by JSON of inputs. */
export function makeCache(ttlMs = CACHE_TTL_MS) {
  const map = new Map()
  return {
    get(key) {
      const entry = map.get(key)
      if (!entry) return undefined
      if (Date.now() - entry.ts > ttlMs) {
        map.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key, value) {
      map.set(key, { ts: Date.now(), value })
    },
    size: () => map.size,
  }
}
