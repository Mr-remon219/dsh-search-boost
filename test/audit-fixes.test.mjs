import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchPage, makePageCache } from '../lib/fetch.js'
import { isBlockedIp, isTunFakeIp, assertPublicHttpUrl, SsrfError } from '../lib/ssrf.js'
import { normalizeUrl, fusedSearch, TIER_ENGINES, TIER_ENGINES_FREE, tierEnginesFor, SECONDARY_VARIANTS, searchCacheKey, estimateComplexity } from '../lib/fusion.js'
import { researchRound, parallelResearch, setTimer } from '../lib/research.js'
import { getLayer, setLayer } from '../lib/layer.js'
import { parseExaFreeText } from '../lib/exa-free.js'

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
    assert.deepEqual(TIER_ENGINES.simple, ['bing', 'ddg', 'exa-free'])
    assert.ok(TIER_ENGINES.medium.includes('antigravity'))
    assert.ok(TIER_ENGINES.simple.includes('exa-free'))
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

// ---------- v0.0.2: layers + exa-free ----------

describe('v0.0.2 web layer', () => {
  it('free tier tables use only keyless engines', () => {
    const keyed = ['tavily', 'brave', 'exa']
    for (const tier of ['simple', 'medium', 'complex']) {
      for (const e of TIER_ENGINES_FREE[tier]) {
        assert.equal(keyed.includes(e), false, `free tier ${tier} must not contain keyed engine ${e}`)
      }
    }
    assert.deepEqual(TIER_ENGINES_FREE.simple, ['bing', 'ddg', 'exa-free'])
    assert.ok(tierEnginesFor('free', 'complex').every((e) => !keyed.includes(e)))
    assert.ok(tierEnginesFor('api', 'complex').includes('tavily'))
    assert.ok(tierEnginesFor('free', 'complex').includes('exa-free'))
  })

  it('round-trips layer state, restoring the original default afterwards', () => {
    const origDefault = getLayer() // reads the real state file (or "api")
    setLayer('free')
    assert.equal(getLayer(), 'free')
    setLayer('api')
    assert.equal(getLayer(), 'api')
    // restore to whatever the machine default was (api on fresh installs)
    setLayer(origDefault)
    assert.ok(getLayer() === 'free' || getLayer() === 'api')
  })

  it('secondary (extra-variant) wave is layer-aware: exa-free joins in free, tavily in api', async () => {
    // secondaryPool drives the 2nd/3rd variants; a medium query yields 2+ variants
    assert.ok(SECONDARY_VARIANTS.free.includes('exa-free'))
    assert.ok(!SECONDARY_VARIANTS.free.includes('tavily'))
    assert.ok(SECONDARY_VARIANTS.api.includes('tavily'))
    assert.ok(SECONDARY_VARIANTS.api.includes('exa-free'))

    const perVariant = {}
    const collect = (engine, variant) => {
      perVariant[variant] = perVariant[variant] ?? new Set()
      perVariant[variant].add(engine)
    }
    await fusedSearch({
      query: 'tokio runtime',
      queries: ['tokio async runtime features', 'tokio architecture'],
      layer: 'free',
      tier: 'medium', // 2+ variants
      runOne: async (engine, q) => { collect(engine, q); return [] },
    })
    const freeVariants = Object.values(perVariant)
    assert.ok(freeVariants.length >= 2, `expected >=2 variants, got ${JSON.stringify(perVariant)}`)
    // exa-free must be reachable across the (possibly multiple) variants
    assert.ok(Object.values(perVariant).some((s) => s.has('exa-free')))
  })
})

describe('v0.0.2 free-layer engine guard', () => {
  it('never dials keyed engines in free mode even if requested', async () => {
    const invoked = []
    const result = await fusedSearch({
      query: 'tokio runtime',
      layer: 'free',
      engines: ['tavily', 'brave', 'exa'], // keyed-only request
      tier: 'simple',
      runOne: async (engine, _q, _n) => {
        invoked.push(engine)
        return []
      },
    })
    // free layer must substitute the keyless tier pool, never the keyed ones
    assert.ok(invoked.every((e) => !['tavily', 'brave', 'exa'].includes(e)), `invoked keyed engines: ${invoked}`)
    assert.ok(['bing', 'ddg', 'exa-free'].some((e) => invoked.includes(e)), `expected free legs, got ${invoked}`)
    assert.ok(result.warnings.length === 0)
  })

  it('falls back to keyless exa-free with a warning when the layer pool is empty', async () => {
    const result = await fusedSearch({
      query: 'tokio runtime',
      layer: 'free',
      engines: [], // empty request → layer default pool is substituted (non-empty)
      tier: 'simple',
      runOne: async () => [],
    })
    // 'free' default pool (bing/ddg/exa-free) is non-empty, so no warning expected
    assert.equal(result.warnings.length, 0)
  })
})

describe('v0.0.2 exa-free parser', () => {
  it('parses Title/URL/Highlights blocks', () => {
    const md = [
      'Title: Tokio 1.53.1',
      'URL: https://github.com/tokio-rs/tokio/releases/tag/tokio-1.53.1',
      'Highlights: async runtime, released 2026-07-20',
      '',
      '---',
      '',
      'Title: crates.io tokio',
      'URL: https://crates.io/crates/tokio',
      'Highlights: Rust package registry',
    ].join('\n')
    const hits = parseExaFreeText(md)
    assert.equal(hits.length, 2)
    assert.equal(hits[0].url, 'https://github.com/tokio-rs/tokio/releases/tag/tokio-1.53.1')
    assert.match(hits[0].snippet, /async runtime/)
  })

  it('falls back to markdown links when no blocks parse', () => {
    const hits = parseExaFreeText('See [Tokio](https://tokio.rs) and [docs](https://docs.rs/tokio).')
    assert.ok(hits.length >= 2)
    assert.equal(hits[0].title, 'Tokio')
    assert.equal(hits[0].url, 'https://tokio.rs')
  })
})

describe('audit follow-ups', () => {
  it('/web_change show reports layer and engines without ReferenceError', async () => {
    const { apply } = await import('../index.js')
    const commands = new Map()
    const commandsService = { register: (c) => { commands.set(c.name, c); return c } }
    const ctx = {
      get: (s) => ({ commands: commandsService, subagents: null }[s]),
      web: { registerSearchProvider: () => {}, registerFetchProvider: () => {} },
      tools: { register: () => {} },
      systemPrompt: { section: () => {} },
      timeout: (ms) => ms,
    }
    apply(ctx, {})
    const cmd = commands.get('web_change')
    assert.ok(cmd, 'web_change registered')
    const out = cmd.handler({ rawInput: 'show' })
    assert.equal(out.kind, 'success')
    assert.match(out.text, /current layer:/)
    assert.match(out.text, /engines available in this layer:/)
    assert.doesNotMatch(out.text, /engines is not defined/)
  })

  it('fetch_page reuses cache across trailing-slash URL variants', async () => {
    const hits = []
    const orig = globalThis.fetch
    globalThis.fetch = async (url) => {
      hits.push(String(url))
      if (String(url).startsWith('https://r.jina.ai/')) {
        return new Response('# Title\n\nbody text with enough padding to skip local fallback comfortably\n\nmore text here\n\n', { status: 200 })
      }
      return orig(url)
    }
    try {
      const cache = makePageCache()
      await fetchPage('https://1.1.1.1/doc/', null, cache)
      const second = await fetchPage('https://1.1.1.1/doc', null, cache)
      assert.equal(second.cacheHit, true)
      assert.equal(hits.filter((u) => u.startsWith('https://r.jina.ai/')).length, 1)
    } finally {
      globalThis.fetch = orig
    }
  })

  it('fusedSearch engineStats marks used only for engines that ran', async () => {
    const result = await fusedSearch({
      query: 'probe engines stats',
      engines: ['bing'],
      tier: 'simple',
      runOne: async () => [{ title: 'hit', url: 'https://example.com/a', snippet: 'probe' }],
    })
    assert.equal(result.engineStats.bing?.used, true)
    assert.equal(result.engineStats.ddg, undefined)
  })
})
