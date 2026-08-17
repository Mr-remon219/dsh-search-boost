#!/usr/bin/env node
/**
 * Large-scale free-engine benchmark: many queries × many engines.
 * Writes JSON report to scripts/engine-benchmark-report.json
 *
 *   node scripts/engine-benchmark.mjs
 *   node scripts/engine-benchmark.mjs --quick   # subset for CI smoke
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as https from 'node:https'
import * as dns from 'node:dns'
import { fileURLToPath } from 'node:url'
import { loadKeys, engineRegistry } from '../lib/engines.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPORT = path.join(__dirname, 'engine-benchmark-report.json')
const QUICK = process.argv.includes('--quick')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'
const ipv4Agent = new https.Agent({
  lookup: (hostname, options, callback) => dns.lookup(hostname, { ...options, family: 4 }, callback),
})
const htmlFetch = (url, init = {}) => fetch(url, { ...init, agent: ipv4Agent })

/** @type {{ id: string, q: string, kind: string }[]} */
const QUERIES_FULL = [
  { id: 'tech-simple', q: 'nodejs async await tutorial', kind: 'general' },
  { id: 'tech-version', q: 'rust 1.85 release notes', kind: 'general' },
  { id: 'tech-compare', q: 'tokio vs async-std performance benchmark', kind: 'general' },
  { id: 'tech-niche', q: 'deepseek harness cordis plugin', kind: 'general' },
  { id: 'news-recent', q: 'OpenAI GPT latest announcement 2026', kind: 'general' },
  { id: 'docs-official', q: 'typescript 5.8 release site:typescriptlang.org', kind: 'site' },
  { id: 'cn-tech', q: 'Vue 3.5 新特性', kind: 'cn' },
  { id: 'cn-general', q: '如何学习机器学习', kind: 'cn' },
  { id: 'short-tail', q: 'docker compose', kind: 'general' },
  { id: 'long-tail', q: 'how to configure nginx reverse proxy websocket ssl', kind: 'general' },
  { id: 'x-keyword', q: 'nodejs', kind: 'x' },
  { id: 'x-site', q: 'site:x.com OpenAI GPT', kind: 'x' },
  { id: 'x-site-user', q: 'site:x.com from:elonmusk AI', kind: 'x' },
  { id: 'error-prone', q: 'C++20 concepts tutorial', kind: 'general' },
  { id: 'api-docs', q: 'fetch API MDN', kind: 'general' },
]

const QUERIES = QUICK
  ? QUERIES_FULL.filter((q) => ['tech-simple', 'x-keyword', 'x-site', 'cn-tech', 'docs-official'].includes(q.id))
  : QUERIES_FULL

function decodeYahooUrl(href) {
  const m = /[?&/]RU=([^/&]+)/i.exec(String(href ?? ''))
  if (!m) return href
  try { return decodeURIComponent(m[1]) } catch { return href }
}

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const strip = (s) => collapse(String(s ?? '').replace(/<[^>]*>/g, ' '))
const dec = (s) => strip(String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' '))

async function yahooSearch(query, count, signal) {
  const res = await htmlFetch(`https://search.yahoo.com/search?p=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': UA }, signal,
  })
  if (!res.ok) throw new Error(`yahoo http ${res.status}`)
  const html = await res.text()
  const blocks = html.split(/<div class="dd fst algo /).slice(1)
  const hits = []
  for (const block of blocks) {
    if (hits.length >= count) break
    const anchor = /compTitle[\s\S]*?<a[^>]+href="([^"]+)"/i.exec(block)
    if (!anchor) continue
    const u = decodeYahooUrl(anchor[1].replace(/&amp;/g, '&'))
    if (!/^https?:\/\//i.test(u)) continue
    const titleM = /<h3[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(block)
    const title = titleM ? dec(titleM[1]) : ''
    if (!title) continue
    const snippetM = /class="[^"]*compText[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    hits.push({ title, url: u, snippet: snippetM ? dec(snippetM[1]).slice(0, 240) : '' })
  }
  if (!hits.length) throw new Error('yahoo: 0 hits')
  return hits
}

async function ddgLiteSearch(query, count, signal) {
  const res = await htmlFetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': UA }, signal,
  })
  if (!res.ok) throw new Error(`ddg-lite http ${res.status}`)
  const html = await res.text()
  const hits = []
  for (const m of html.matchAll(/<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let u = m[1].replace(/&amp;/g, '&')
    const uddg = /[?&]uddg=([^&]+)/.exec(u)
    if (uddg) {
      try { u = decodeURIComponent(uddg[1]) } catch { /* keep */ }
    }
    if (!/^https?:\/\//i.test(u) || /duckduckgo\.com/.test(u)) continue
    const title = dec(m[2])
    if (!title) continue
    hits.push({ title, url: u, snippet: '' })
    if (hits.length >= count) break
  }
  if (!hits.length) throw new Error('ddg-lite: 0 hits')
  return hits
}

async function wikipediaSearch(query, count, signal) {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${count}&namespace=0&format=json`
  const res = await htmlFetch(url, { signal })
  if (!res.ok) throw new Error(`wikipedia http ${res.status}`)
  const [, titles, descs, urls] = await res.json()
  if (!titles?.length) throw new Error('wikipedia: 0 hits')
  return titles.map((title, i) => ({ title, url: urls[i], snippet: descs[i] ?? '' }))
}

async function googleNewsSearch(query, count, signal) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
  const res = await htmlFetch(url, { headers: { 'user-agent': UA }, signal })
  if (!res.ok) throw new Error(`googlenews http ${res.status}`)
  const xml = await res.text()
  const hits = []
  for (const m of xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>/gi)) {
    const title = dec(m[1].replace(/<!\[CDATA\[|\]\]>/g, ''))
    let u = m[2].trim().replace(/<!\[CDATA\[|\]\]>/g, '')
    if (!title || !u) continue
    hits.push({ title, url: u, snippet: '' })
    if (hits.length >= count) break
  }
  if (!hits.length) throw new Error('googlenews: 0 hits')
  return hits
}

async function braveHtmlSearch(query, count, signal) {
  const res = await htmlFetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': UA }, signal,
  })
  if (!res.ok) throw new Error(`brave-html http ${res.status}`)
  const html = await res.text()
  const hits = []
  for (const m of html.matchAll(/<a[^>]+class="[^"]*snippet-title[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const u = m[1].replace(/&amp;/g, '&')
    const title = dec(m[2])
    if (title && /^https?:\/\//i.test(u)) hits.push({ title, url: u, snippet: '' })
    if (hits.length >= count) break
  }
  if (!hits.length) throw new Error('brave-html: 0 hits')
  return hits
}

async function mojeekSearch(query, count, signal) {
  const res = await htmlFetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': UA }, signal,
  })
  if (!res.ok) throw new Error(`mojeek http ${res.status}`)
  const html = await res.text()
  const hits = []
  for (const m of html.matchAll(/<a[^>]+class="title"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const u = m[1].replace(/&amp;/g, '&')
    const title = dec(m[2])
    if (title && /^https?:\/\//i.test(u)) hits.push({ title, url: u, snippet: '' })
    if (hits.length >= count) break
  }
  if (!hits.length) throw new Error('mojeek: 0 hits')
  return hits
}

async function searxSearch(base, query, count, signal) {
  const res = await htmlFetch(`${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, {
    headers: { 'user-agent': UA, accept: 'application/json' }, signal,
  })
  if (!res.ok) throw new Error(`searx http ${res.status}`)
  const ct = res.headers.get('content-type') ?? ''
  const raw = await res.text()
  if (!ct.includes('json') && raw.trimStart().startsWith('<')) {
    throw new Error('searx: HTML not JSON')
  }
  const json = JSON.parse(raw)
  const hits = (json.results ?? []).filter((r) => r.url).slice(0, count)
    .map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? '').slice(0, 240) }))
  if (!hits.length) throw new Error('searx: 0 hits')
  return hits
}

const SEARX_BASES = [
  'https://searx.be',
  'https://opnxng.com',
  'https://search.inetol.net',
  'https://search.bus-hit.me',
]

const CANDIDATES = {
  yahoo: (q, n, sig) => yahooSearch(q, n, sig),
  'ddg-lite': (q, n, sig) => ddgLiteSearch(q, n, sig),
  wikipedia: (q, n, sig) => wikipediaSearch(q, n, sig),
  googlenews: (q, n, sig) => googleNewsSearch(q, n, sig),
  'brave-html': (q, n, sig) => braveHtmlSearch(q, n, sig),
  mojeek: (q, n, sig) => mojeekSearch(q, n, sig),
  ...Object.fromEntries(SEARX_BASES.map((b) => [`searx:${new URL(b).hostname}`, (q, n, sig) => searxSearch(b, q, n, sig)])),
}

const EXISTING = ['bing', 'ddg', 'exa-free', 'antigravity']
const COUNT = 5
const TIMEOUT_MS = 55000

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function xHits(hits) {
  return hits.filter((h) => /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(hostOf(h.url)))
}

async function probeOne(name, searchFn, query) {
  const t0 = Date.now()
  try {
    const hits = await searchFn(query.q, COUNT, AbortSignal.timeout(TIMEOUT_MS))
    const domains = hits.map((h) => hostOf(h.url)).filter(Boolean)
    const x = xHits(hits)
    return {
      ok: true,
      ms: Date.now() - t0,
      count: hits.length,
      xCount: x.length,
      domains,
      top: hits.slice(0, 2).map((h) => ({ title: h.title.slice(0, 70), url: h.url, domain: hostOf(h.url) })),
    }
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: (err instanceof Error ? err.message : String(err)).slice(0, 140) }
  }
}

const keys = loadKeys()
const registry = engineRegistry(keys)

const allEngines = {
  ...Object.fromEntries(
    EXISTING.filter((n) => registry[n]?.available()).map((n) => [
      n,
      (q, c, sig) => registry[n].search(q, c, { signal: sig }),
    ]),
  ),
  ...CANDIDATES,
}

console.log(`Benchmark (${QUICK ? 'quick' : 'full'}): ${QUERIES.length} queries × ${Object.keys(allEngines).length} engines\n`)

const matrix = {}
const summary = {}

for (const name of Object.keys(allEngines)) {
  summary[name] = { ok: 0, fail: 0, totalMs: 0, totalHits: 0, totalXHits: 0, xOk: 0, errors: {}, byKind: {} }
}

for (const query of QUERIES) {
  matrix[query.id] = { kind: query.kind, q: query.q }
  process.stdout.write(`[${query.id}] ${query.q.slice(0, 48)}… `)
  const rowResults = []
  for (const [name, fn] of Object.entries(allEngines)) {
    const r = await probeOne(name, fn, query)
    matrix[query.id][name] = r
    const s = summary[name]
    if (!s.byKind[query.kind]) s.byKind[query.kind] = { ok: 0, fail: 0 }
    if (r.ok) {
      s.ok++
      s.byKind[query.kind].ok++
      s.totalMs += r.ms
      s.totalHits += r.count
      s.totalXHits += r.xCount ?? 0
      if (query.kind === 'x' && (r.xCount ?? 0) > 0) s.xOk++
    } else {
      s.fail++
      s.byKind[query.kind].fail++
      const key = r.error ?? 'unknown'
      s.errors[key] = (s.errors[key] ?? 0) + 1
    }
    rowResults.push({ name, ...r })
  }
  const ok = rowResults.filter((r) => r.ok).map((r) => r.name)
  console.log(`${ok.length}/${rowResults.length} ok`)
  await new Promise((r) => setTimeout(r, QUICK ? 200 : 600))
}

for (const name of Object.keys(summary)) {
  const s = summary[name]
  const n = s.ok + s.fail
  s.successRate = n ? Math.round((s.ok / n) * 1000) / 10 : 0
  s.avgMs = s.ok ? Math.round(s.totalMs / s.ok) : null
  s.avgHits = s.ok ? Math.round((s.totalHits / s.ok) * 10) / 10 : 0
  const xQueries = QUERIES.filter((q) => q.kind === 'x').length
  s.xSuccessRate = xQueries ? Math.round((s.xOk / xQueries) * 1000) / 10 : 0
}

const ranked = Object.entries(summary)
  .map(([name, s]) => ({ name, ...s }))
  .sort((a, b) => b.successRate - a.successRate || b.xSuccessRate - a.xSuccessRate || (a.avgMs ?? 99999) - (b.avgMs ?? 99999))

/** Recommend free-layer pool: >=80% overall, >=66% on x queries, not antigravity */
const KEEP_THRESHOLD = QUICK ? 60 : 75
const X_THRESHOLD = QUICK ? 33 : 66
const recommended = ranked
  .filter((r) => r.name !== 'antigravity')
  .filter((r) => r.successRate >= KEEP_THRESHOLD)
  .filter((r) => r.xSuccessRate >= X_THRESHOLD || r.name === 'exa-free')
  .map((r) => r.name)

const rejected = ranked
  .filter((r) => !recommended.includes(r.name))
  .map((r) => ({ name: r.name, successRate: r.successRate, xSuccessRate: r.xSuccessRate, reason: r.name === 'antigravity' ? 'platform-specific CLI' : 'below threshold' }))

const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  quick: QUICK,
  queries: QUERIES,
  engines: Object.keys(allEngines).length,
  thresholds: { successRate: KEEP_THRESHOLD, xSuccessRate: X_THRESHOLD },
  recommendedFreeLayer: recommended,
  rejected,
  summary: Object.fromEntries(ranked.map((r) => [r.name, r])),
  ranked: ranked.map(({ name, successRate, xSuccessRate, avgMs, avgHits, ok, fail }) =>
    ({ name, successRate, xSuccessRate, avgMs, avgHits, ok, fail })),
  matrix,
}

fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))

console.log('\n=== RANKING (success %, x-site %, avg ms) ===')
for (const r of ranked) {
  console.log(
    `${String(r.successRate).padStart(5)}%  x=${String(r.xSuccessRate).padStart(5)}%  ` +
    `${String(r.avgMs ?? '-').padStart(6)}ms  ${r.name}`,
  )
}

console.log('\n=== RECOMMENDED FREE LAYER ===')
console.log(recommended.join(', ') || '(none)')
console.log('\n=== REJECTED ===')
for (const r of rejected) {
  console.log(`  ${r.name}: ${r.successRate}% / x=${r.xSuccessRate}% — ${r.reason}`)
}

console.log(`\nReport: ${REPORT}`)
