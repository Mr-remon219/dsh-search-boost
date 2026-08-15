// Page fetch: Jina Reader first (curl UA), local HTML fallback for blocked
// sites, focus filtering to save ~90% of tokens. 24h TTL in-memory cache
// stores the RAW text; focus filtering happens at read time.

import { queryTerms, collapseSpace } from './fusion.js'

const PAGE_TTL_MS = 24 * 3600 * 1000
const PAGE_MAX_CHARS = 8000

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
}

function htmlToText(html) {
  let s = String(html ?? '')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeHtml(s)
  return collapseSpace(s)
}

function focusFilter(text, focus) {
  if (!focus) return text
  const terms = queryTerms(focus)
  if (terms.length === 0) return text
  const paras = String(text ?? '').split(/\n{2,}/)
  const out = []
  for (let i = 0; i < paras.length; i++) {
    const low = paras[i].toLowerCase()
    const hit = terms.some((t) => low.includes(t))
    if (hit) {
      if (i > 0 && out[out.length - 1] !== paras[i - 1]) out.push(paras[i - 1])
      out.push(paras[i])
      if (i + 1 < paras.length) out.push(paras[i + 1])
    }
  }
  return out.join('\n\n')
}

export function makePageCache() {
  const map = new Map()
  return {
    get(key) {
      const entry = map.get(key)
      if (!entry) return undefined
      if (Date.now() - entry.ts > PAGE_TTL_MS) {
        map.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key, value) {
      map.set(key, { ts: Date.now(), value })
    },
  }
}

export async function fetchPage(url, focus, cache) {
  const started = Date.now()
  if (!/^https?:\/\//i.test(url)) throw new Error('fetch_page: url must be http(s)')
  const cacheKey = `page:${url}#${focus ?? ''}`
  const cached = cache.get(cacheKey)
  if (cached) {
    const focused = focusFilter(cached, focus)
    return {
      url, via: 'cache', fetched_at: new Date().toISOString(),
      word_count: collapseSpace(focused).split(/\s+/).length,
      content: focused.length > PAGE_MAX_CHARS ? focused.slice(0, PAGE_MAX_CHARS) : focused,
      truncated: focused.length > PAGE_MAX_CHARS,
      cacheHit: true, tookMs: Date.now() - started,
    }
  }

  let content = ''
  let via = 'jina'
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'user-agent': 'curl/8.5.0', 'x-return-format': 'markdown' },
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) throw new Error(`jina http ${res.status}`)
    content = await res.text()
  } catch {
    via = 'local'
    content = await localFetch(url)
  }
  if (collapseSpace(content).length < 80) {
    via = 'local'
    try {
      content = await localFetch(url)
    } catch { /* keep jina content */ }
  }

  cache.set(cacheKey, content)
  const focused = focusFilter(content, focus)
  const truncated = focused.length > PAGE_MAX_CHARS
  return {
    url, via, fetched_at: new Date().toISOString(),
    word_count: collapseSpace(focused).split(/\s+/).length,
    content: truncated ? focused.slice(0, PAGE_MAX_CHARS) : focused,
    truncated, cacheHit: false, tookMs: Date.now() - started,
  }
}

async function localFetch(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`local http ${res.status}`)
  return htmlToText(await res.text())
}
