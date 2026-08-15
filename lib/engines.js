// Engine layer: free-by-default chain with keyed failover.
//  - antigravity (agy CLI): free, keyless, needs one-time sign-in (macOS/Linux)
//  - bing: free, keyless HTML scraping
//  - tavily / brave / exa: keyed APIs (key from ~/.dsh-search-boost-keys.json or env)
// Engines throw on failure; runChain tries them in order and reports the trail.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const ENGINE_ORDER = ['antigravity', 'bing', 'tavily', 'brave', 'exa']

export function loadKeys() {
  const keys = { tavily: undefined, exa: undefined, brave: undefined }
  const candidates = [
    path.join(os.homedir(), '.dsh-search-boost-keys.json'),
    path.join(process.cwd(), '.search-boost-keys.json'),
  ]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const k of ['tavily', 'exa', 'brave']) {
        if (typeof parsed[k] === 'string' && parsed[k]) keys[k] = parsed[k].trim()
      }
    } catch { /* try next */ }
  }
  if (!keys.tavily && process.env.TAVILY_API_KEY) keys.tavily = process.env.TAVILY_API_KEY.trim()
  if (!keys.exa && process.env.EXA_API_KEY) keys.exa = process.env.EXA_API_KEY.trim()
  if (!keys.brave && process.env.BRAVE_API_KEY) keys.brave = process.env.BRAVE_API_KEY.trim()
  return keys
}

const collapseSpace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ')
const decodeHtml = (s) => String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')

// ---------- Antigravity CLI (free, keyless) ----------
function commandOnPath(bin) {
  const pathEnv = process.env.PATH ?? ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    for (const e of exts) {
      try {
        fs.statSync(path.join(dir, bin + e))
        return true
      } catch { /* keep looking */ }
    }
  }
  return false
}

function agyAvailable() {
  return commandOnPath('agy')
}

// ---------- Bing HTML (free, keyless) ----------
function decodeBingUrl(href) {
  const m = /[?&]u=([^&]+)/.exec(href)
  if (!m) return href
  try {
    let s = m[1]
    try { s = decodeURIComponent(s) } catch { /* raw */ }
    if (s.startsWith('a1')) s = s.slice(2)
    s = s.replace(/-/g, '+').replace(/_/g, '/')
    while (s.length % 4 !== 0) s += '='
    return Buffer.from(s, 'base64').toString('utf8')
  } catch {
    return href
  }
}

async function bingSearch(query, count) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`bing http ${res.status}`)
  const html = await res.text()
  if (!/<li class="b_algo"/.test(html)) throw new Error('bing: no b_algo blocks (challenge page or structure change)')
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || []
  if (blocks.length === 0) throw new Error('bing: no result blocks parsed')
  const hits = []
  for (const block of blocks) {
    if (hits.length >= count) break
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!anchor) continue
    const u = decodeBingUrl(anchor[1].replace(/&amp;/g, '&'))
    if (!/^https?:\/\//i.test(u)) continue
    const title = collapseSpace(decodeHtml(stripTags(anchor[2])))
    if (!title) continue
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    const snippet = p ? collapseSpace(decodeHtml(stripTags(p[1]))) : ''
    const dt = /<span class="news_dt">([^<]*)<\/span>/i.exec(block)
    hits.push({ title, url: u, snippet, published: dt ? dt[1].trim() : null })
  }
  if (hits.length === 0) throw new Error('bing: parsed 0 hits (structure changed)')
  return hits
}

// ---------- Tavily ----------
async function tavilySearch(query, count, opts, keys) {
  const body = {
    api_key: keys.tavily,
    query,
    search_depth: opts.depth ?? 'basic',
    max_results: count,
    include_answer: false,
    include_raw_content: false,
  }
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains.slice(0, 5)
  if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains.slice(0, 5)
  if (opts.recency) body.time_range = opts.recency
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`tavily http ${res.status}`)
  const json = await res.json()
  return (json.results ?? [])
    .filter((r) => r && r.url)
    .slice(0, count)
    .map((r) => ({
      title: collapseSpace(r.title ?? ''),
      url: r.url,
      snippet: collapseSpace(r.content ?? '').slice(0, 240),
      content: r.content,
      published: r.published_date || r.publishedDate || null,
    }))
}

// ---------- Brave ----------
async function braveSearch(query, count, opts, keys) {
  let url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`
  const freshness = { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[opts.recency ?? '']
  if (freshness) url += `&freshness=${freshness}`
  const res = await fetch(url, {
    headers: { 'x-subscription-token': keys.brave, accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`brave http ${res.status}`)
  const json = await res.json()
  return (json.web?.results ?? [])
    .filter((r) => r && r.url)
    .slice(0, count)
    .map((r) => ({
      title: collapseSpace(r.title ?? ''),
      url: r.url,
      snippet: collapseSpace(r.description ?? ''),
      published: r.age || null,
    }))
}

// ---------- Exa ----------
async function exaSearch(query, count, opts, keys) {
  const body = { query, numResults: count, contents: { text: true } }
  if (opts.recency) {
    const days = { day: 1, week: 7, month: 30, year: 365 }[opts.recency]
    body.publishedAfter = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  }
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': keys.exa },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`exa http ${res.status}`)
  const json = await res.json()
  return (json.results ?? [])
    .filter((r) => r && r.url)
    .slice(0, count)
    .map((r) => ({
      title: collapseSpace(r.title ?? ''),
      url: r.url,
      snippet: collapseSpace(r.text ?? '').slice(0, 240),
      content: r.text,
      published: r.publishedDate || null,
    }))
}

export function engineRegistry(keys) {
  return {
    antigravity: {
      available: () => agyAvailable(),
      search: async () => { throw new Error('antigravity engine not yet wired (install agy via https://antigravity.google/cli/install.sh)') },
    },
    bing: {
      available: () => true,
      search: bingSearch,
    },
    tavily: {
      available: () => Boolean(keys.tavily),
      search: (q, n, o) => tavilySearch(q, n, o, keys),
    },
    brave: {
      available: () => Boolean(keys.brave),
      search: (q, n, o) => braveSearch(q, n, o, keys),
    },
    exa: {
      available: () => Boolean(keys.exa),
      search: (q, n, o) => exaSearch(q, n, o, keys),
    },
  }
}

/** Try engines in order; first success wins; throw with the attempt trail. */
export async function runChain(engines, query, count, opts) {
  const attempts = []
  for (const name of ENGINE_ORDER) {
    const engine = engines[name]
    if (!engine?.available()) continue
    try {
      return { engine: name, hits: await engine.search(query, count, opts) }
    } catch (err) {
      attempts.push(`${name}: ${(err instanceof Error ? err.message : String(err)).slice(0, 90)}`)
    }
  }
  throw new Error(`no engine could answer (${attempts.join('; ')})`)
}
