// Page fetch: Jina Reader first (curl UA), local HTML fallback for blocked
// sites, focus filtering to save ~90% of tokens. 24h TTL in-memory cache
// stores the RAW text; focus filtering happens at read time.
//
// Privacy: the Jina path sends the target URL to r.jina.ai (third party).
// Local fallback never follows redirects or DNS names into private space.

import { queryTerms, collapseSpace, normalizeUrl } from './fusion.js'
import { assertPublicHttpUrl, guardedFetch, isSsrfError, mergeSignals, readLimited, SsrfError } from './ssrf.js'

const PAGE_TTL_MS = 24 * 3600 * 1000
const PAGE_MAX_CHARS = 8000
const PAGE_MAX_RAW_BYTES = 500_000

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

export function makePageCache(maxEntries = 100) {
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
      if (maxEntries > 0 && map.size >= maxEntries && !map.has(key)) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
      map.set(key, { ts: Date.now(), value })
    },
    size: () => map.size,
  }
}

function pageResult(url, via, content, focus, cacheHit, started) {
  const focused = focusFilter(content, focus)
  const truncated = focused.length > PAGE_MAX_CHARS
  return {
    url,
    via,
    fetched_at: new Date().toISOString(),
    word_count: collapseSpace(focused).split(/\s+/).length,
    content: truncated ? focused.slice(0, PAGE_MAX_CHARS) : focused,
    truncated,
    cacheHit,
    tookMs: Date.now() - started,
  }
}

export async function fetchPage(url, focus, cache, signal) {
  const started = Date.now()
  const target = String(url ?? '').trim()
  await assertPublicHttpUrl(target)
  const cacheKey = `page:${normalizeUrl(target)}`
  const cached = cache.get(cacheKey)
  if (cached) return pageResult(target, 'cache', cached, focus, true, started)

  let content = ''
  let via = 'jina'
  try {
    const res = await fetch(`https://r.jina.ai/${target}`, {
      headers: { 'user-agent': 'curl/8.5.0', 'x-return-format': 'markdown' },
      signal: mergeSignals(signal, 25000),
    })
    if (!res.ok) throw new Error(`jina http ${res.status}`)
    content = await readLimited(res, PAGE_MAX_RAW_BYTES)
  } catch (err) {
    if (isSsrfError(err) || err instanceof SsrfError) throw err
    via = 'local'
    content = await localFetch(target, signal)
  }
  if (collapseSpace(content).length < 80) {
    via = 'local'
    try {
      content = await localFetch(target, signal)
    } catch (err) {
      if (isSsrfError(err)) throw err
    }
  }

  cache.set(cacheKey, content)
  return pageResult(target, via, content, focus, false, started)
}

async function localFetch(url, signal) {
  const res = await guardedFetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeoutMs: 20000,
    signal,
  })
  if (!res.ok) throw new Error(`local http ${res.status}`)
  return htmlToText(await readLimited(res, PAGE_MAX_RAW_BYTES))
}
