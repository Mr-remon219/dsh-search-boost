import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchPage, makePageCache } from '../lib/fetch.js'
import { isBlockedIp, isTunFakeIp, assertPublicHttpUrl, SsrfError } from '../lib/ssrf.js'
import { normalizeUrl, fusedSearch, TIER_ENGINES, searchCacheKey, estimateComplexity } from '../lib/fusion.js'
import { researchRound, parallelResearch, setTimer } from '../lib/research.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const indexSrc = readFileSync(join(root, 'index.js'), 'utf8')

describe('P0-1 SSRF', () => {
  it('blocks loopback, private, link-local and mapped IPv6', () => {
    assert.equal(isBlockedIp('127.0.0.1'), true)
    assert.equal(isBlockedIp('10.0.0.5'), true)
    assert.equal(isBlockedIp('192.168.1.1'), true)
    assert.equal(isBlockedIp('169.254.169.254'), true)
    assert.equal(isBlockedIp('172.16.0.1'), true)
    assert.equal(isBlockedIp('::1'), true)
    assert.equal(isBlockedIp('::ffff:127.0.0.1'), true)
    assert.equal(isBlockedIp('8.8.8.8'), false)
  })

  it('classifies TUN fake-ip range and blocks it as a literal target', () => {
    // RFC 2544 benchmark range used by Clash/mihomo/sing-box TUN fake-ip
    assert.equal(isTunFakeIp('198.18.0.191'), true)
    assert.equal(isTunFakeIp('198.19.255.1'), true)
    assert.equal(isTunFakeIp('10.0.0.1'), false)
    assert.equal(isTunFakeIp('1.1.1.1'), false)
    assert.equal(isTunFakeIp('::1'), false)
    // literal IPs in the range stay blocked — only hostname resolution
    // into the range gets the TUN carve-out
    assert.equal(isBlockedIp('198.18.0.1'), true)
    assert.equal(isBlockedIp('198.19.0.1'), true)
  })

  it('rejects literal TUN fake-ip URLs but allows TUN hostname resolution', async () => {
    await assert.rejects(() => assertPublicHttpUrl('http://198.18.0.1/'), SsrfError)
    await assert.rejects(() => assertPublicHttpUrl('http://198.19.0.1/'), SsrfError)
    // github.com resolves via Clash TUN fake-ip on this machine and to real
    // public IPs elsewhere — both must pass the guard
    await assert.doesNotReject(() => assertPublicHttpUrl('https://github.com/'))
  })

  it('rejects localhost and credentialed URLs before any fetch', async () => {
    await assert.rejects(() => assertPublicHttpUrl('http://localhost/admin'), SsrfError)
    await assert.rejects(() => assertPublicHttpUrl('http://user:pass@example.com/'), SsrfError)
    await assert.rejects(() => assertPublicHttpUrl('file:///etc/passwd'), SsrfError)
  })

  it('does not return loopback body from fetch_page', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('INTERNAL ADMIN TOKEN=s3cr3t-abcdef')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      await assert.rejects(
        () => fetchPage(`http://127.0.0.1:${port}/admin`, null, makePageCache()),
        (err) => err instanceof SsrfError && !String(err.message).includes('s3cr3t'),
      )
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('P0-2 research_parallel budget', () => {
  it('returns timeout when ctx.timeout is missing', async () => {
    setTimer(null)
    const never = new Promise(() => {})
    const subagents = {
      list: () => ['spawn'],
      start: async () => ({ result: never, dispose: async () => {} }),
    }
    const started = Date.now()
    const result = await parallelResearch({
      query: 'budget-probe',
      maxSeconds: 1,
      subQueries: ['one-angle'],
      subagents,
      agent: {},
    })
    const ms = Date.now() - started
    assert.ok(ms < 2000, `expected return under 2s, took ${ms}ms`)
    assert.equal(result.sub_tasks[0].status, 'timeout')
  })
})

describe('P0-3 / P1-7 URL identity', () => {
  it('keeps path and query case on the dedup key', () => {
    const raw = 'https://raw.githubusercontent.com/nodejs/node/main/README.md?Foo=Bar#Section'
    const key = normalizeUrl(raw)
    assert.match(key, /\/README\.md/)
    assert.doesNotMatch(key, /\/readme\.md/)
    assert.match(key, /Foo=Bar/)
    assert.doesNotMatch(key, /foo=bar/)
  })

  it('returns the first-seen original URL and merges www with apex', async () => {
    const raw = 'https://raw.githubusercontent.com/nodejs/node/main/README.md?Foo=Bar#Section'
    const fused = await fusedSearch({
      query: 'hello world test page',
      engines: ['bing', 'ddg'],
      tier: 'simple',
      maxResults: 6,
      runOne: async (engine) => {
        if (engine === 'bing') {
          return [{ title: 'README', url: raw, snippet: 'hello world test page' }]
        }
        return [{ title: 'README', url: 'https://www.raw.githubusercontent.com/nodejs/node/main/README.md?Foo=Bar', snippet: 'hello world test page' }]
      },
    })
    assert.equal(fused.results.length, 1)
    assert.match(fused.results[0].url, /\/README\.md/)
    assert.doesNotMatch(fused.results[0].url, /\/readme\.md/)
    assert.deepEqual(fused.results[0].engines.sort(), ['bing', 'ddg'])
  })
})

describe('P1-4 fetch_page cache key', () => {
  it('reuses raw cache across focus values', async () => {
    const hits = []
    const orig = globalThis.fetch
    globalThis.fetch = async (url) => {
      hits.push(String(url))
      if (String(url).startsWith('https://r.jina.ai/')) {
        return new Response('# Title\n\nalpha paragraph here\n\nbeta paragraph here\n\n', { status: 200 })
      }
      return orig(url)
    }
    try {
      const cache = makePageCache()
      const first = await fetchPage('https://1.1.1.1/doc', 'alpha', cache)
      const second = await fetchPage('https://1.1.1.1/doc', 'beta', cache)
      assert.equal(first.cacheHit, false)
      assert.equal(second.cacheHit, true)
      assert.equal(hits.filter((u) => u.startsWith('https://r.jina.ai/')).length, 1)
    } finally {
      globalThis.fetch = orig
    }
  })
})

describe('P1-5 deep_research tier', () => {
  it('forces complex tier and only calls provided engines', async () => {
    const invoked = []
    const query = 'tokio release notes'
    assert.equal(estimateComplexity(query), 'medium')
    const result = await researchRound({
      query,
      maxSources: 4,
      engines: ['bing', 'ddg'],
      runOne: async (engine, q) => {
        invoked.push(engine)
        return [{ title: `${engine} hit`, url: `https://example.com/${engine}`, snippet: `${q} tokio release` }]
      },
    })
    assert.deepEqual([...new Set(invoked)].sort(), ['bing', 'ddg'])
    assert.ok(result.queriesUsed.length >= 1)
  })
})

describe('P1-6 cache key includes tier', () => {
  it('differs across simple and complex', () => {
    const base = { query: 'tokio', queries: [], engines: ['bing'], includeDomains: [], excludeDomains: [], recency: null, maxResults: 6 }
    assert.notEqual(searchCacheKey({ ...base, tier: 'simple' }), searchCacheKey({ ...base, tier: 'complex' }))
  })
})

describe('P1-8 / P1-9 / P1-11 / P1-13 wiring', () => {
  it('drops agy from simple and shares cache + signal + ddg stats', () => {
    assert.deepEqual(TIER_ENGINES.simple, ['bing', 'ddg'])
    assert.ok(TIER_ENGINES.medium.includes('antigravity'))
    const provider = indexSrc.slice(indexSrc.indexOf('function registerSearchProvider'), indexSrc.indexOf('// ---------- fused_search tool'))
    assert.equal(/tier: 'simple'/.test(provider), false)
    assert.equal(/runFused\(/.test(provider), true)
    assert.match(provider, /\bsignal\b/)
    assert.match(indexSrc, /ddg:\s*true/)
  })

  it('forwards abort signal into runOne opts', async () => {
    const ac = new AbortController()
    let seen
    await fusedSearch({
      query: 'signal probe',
      engines: ['bing'],
      tier: 'simple',
      signal: ac.signal,
      runOne: async (_e, _q, _n, o) => {
        seen = o.signal
        return []
      },
    })
    assert.equal(seen, ac.signal)
  })
})
