import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackXSearch, splitXTitle, hitToPost, parseOEmbedHtml, decodeUserId, parseUser, parseTweets } from '../lib/xfallback.js'
import { buildXSearchPrompt, salvageJson, normalizePosts } from '../lib/xsearch.js'
import { jwtTier } from '../lib/xauth.js'
import { SEARCH_POLICY_SECTION } from '../lib/policy.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const indexSrc = readFileSync(join(root, 'index.js'), 'utf8')

describe('v0.0.3 x_search title/entity parsing', () => {
  it('splitXTitle: "Author on X: text" → author + text', () => {
    assert.deepEqual(splitXTitle('OpenAI on X: "GPT-5.6 is available starting today"'), {
      author: 'OpenAI',
      text: 'GPT-5.6 is available starting today',
    })
    assert.deepEqual(splitXTitle('plain title without author'), { text: 'plain title without author' })
    assert.deepEqual(splitXTitle(''), { text: '' })
  })

  it('hitToPost extracts status id from the URL and splits the title', () => {
    const p = hitToPost({
      title: 'OpenAI on X: "Previewing Ultrafast mode: GPT-5.6 Sol at up to 14x"',
      url: 'https://x.com/OpenAI/status/2087947721936359705',
      snippet: 'x',
      domain: 'x.com',
    })
    assert.equal(p.id, '2087947721936359705')
    assert.equal(p.author, 'OpenAI')
    assert.match(p.text, /Ultrafast mode/)
  })

  it('parseOEmbedHtml strips tags/scripts and decodes entities', () => {
    const html = '<blockquote lang="en">Full &quot;text&quot; &amp; more &#183; &#x2764; &middot; &hellip; <a href="https://x.com/OpenAI/status/1">x.com</a><script>window.bad()</script></blockquote>'
    const text = parseOEmbedHtml(html)
    assert.match(text, /Full "text" & more · ❤ · …/)
    assert.doesNotMatch(text, /<|>/)
    assert.doesNotMatch(text, /&(?:quot|amp|#183|#x2764|middot|hellip);/)
    assert.doesNotMatch(text, /window\.bad/)
  })

  it('decodeEntities survives malformed entities verbatim', () => {
    const text = parseOEmbedHtml('<p>100% &amp; &#999999999999; &unknown; &amp;amp;</p>')
    assert.match(text, /100% &/)
    assert.match(text, /&unknown;/)
  })
})

describe('v0.0.3 guest GraphQL parsing (new shape)', () => {
  it('decodeUserId handles the base64 "User:123" id', () => {
    assert.equal(decodeUserId(Buffer.from('User:11348282').toString('base64')), '11348282')
    assert.equal(decodeUserId('11348282'), '11348282')
  })

  it('parseUser reads rest_id / profile_bio / relationship_counts / verification', () => {
    const user = parseUser({
      rest_id: '11348282',
      core: { created_at: 'Wed Dec 19 20:20:32 +0000 2007', name: 'NASA', screen_name: 'NASA' },
      profile_bio: { description: 'Making the seemingly impossible, possible. ✨' },
      relationship_counts: { followers: 92305197, following: 119 },
      verification: { verified: false, verified_type: 'Government' },
      verification_info: { is_identity_verified: true },
      legacy: {},
    })
    assert.equal(user.id, '11348282')
    assert.equal(user.username, 'NASA')
    assert.match(user.bio, /seemingly impossible/)
    assert.equal(user.followers, 92305197)
    assert.equal(user.following, 119)
    assert.equal(user.verified, true)
    assert.equal(user.created_at, 'Wed Dec 19 20:20:32 +0000 2007')
  })

  it('parseUser falls back to the legacy shape', () => {
    const user = parseUser({
      id: 'VXNlcjoxMjM0NTY=',
      core: { name: 'Old', screen_name: 'old' },
      legacy: { description: 'legacy bio', followers_count: 10, friends_count: 2 },
      is_blue_verified: false,
    })
    assert.equal(decodeUserId(user.id), '123456')
    assert.equal(user.followers, 10)
    assert.equal(user.verified, false)
  })

  it('parseTweets walks timeline entries (new-shape user_results) with views + media', () => {
    const d = {
      data: {
        user: {
          result: {
            timeline_v2: {
              timeline: {
                instructions: [
                  {
                    type: 'TimelineAddEntries',
                    entries: [
                      {
                        entryId: 't1',
                        content: {
                          entryType: 'TimelineTimelineItem',
                          itemContent: {
                            itemType: 'TimelineTweet',
                            tweet_results: {
                              result: {
                                __typename: 'Tweet',
                                rest_id: '2087947721936359705',
                                core: { user_results: { result: { core: { screen_name: 'OpenAI' } } } },
                                legacy: {
                                  full_text: 'Previewing Ultrafast mode: GPT-5.6 Sol at up to 14x the speed.',
                                  favorite_count: 42,
                                  retweet_count: 7,
                                  reply_count: 3,
                                  extended_entities: { media: [{ media_url_https: 'https://pbs.twimg.com/media/x.jpg' }] },
                                },
                                views: { count: 55030 },
                              },
                            },
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    }
    const posts = parseTweets(d)
    assert.equal(posts.length, 1)
    assert.equal(posts[0].id, '2087947721936359705')
    assert.equal(posts[0].username, 'OpenAI')
    assert.equal(posts[0].views, 55030)
    assert.equal(posts[0].likes, 42)
    assert.equal(posts[0].reposts, 7)
    assert.equal(posts[0].media.length, 1)
    assert.match(posts[0].url, /x\.com\/OpenAI\/status\//)
  })

  it('parseTweets unwraps TweetWithVisibilityResults', () => {
    const d = {
      data: {
        user: {
          result: {
            timeline_v2: {
              timeline: {
                instructions: [
                  {
                    entries: [
                      {
                        content: {
                          entryType: 'TimelineTimelineItem',
                          itemContent: {
                            itemType: 'TimelineTweet',
                            tweet_results: {
                              result: {
                                __typename: 'TweetWithVisibilityResults',
                                tweet: {
                                  rest_id: '1',
                                  core: { user_results: { result: { core: { screen_name: 'nasa' } } } },
                                  legacy: { full_text: 'hidden tweet body' },
                                },
                              },
                            },
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    }
    const posts = parseTweets(d)
    assert.equal(posts.length, 1)
    assert.equal(posts[0].text, 'hidden tweet body')
  })
})

describe('v0.0.3 fallback routing (hermetic, mocked fetch + webSearch)', () => {
  const oembedFor = (id) =>
    `<blockquote>Full post text for ${id} with &quot;quotes&quot; &amp; entities &middot; end</blockquote>`

  it('keyword: engines → oEmbed enhancement for top status URLs', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://publish.x.com/oembed')) {
        const target = new URL(u).searchParams.get('url') ?? ''
        const id = target.match(/status\/(\d+)/)?.[1] ?? '0'
        return new Response(
          JSON.stringify({ author_name: 'OpenAI', author_url: 'https://x.com/OpenAI', html: oembedFor(id) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch in test: ${u}`)
    }
    try {
      const hits = [
        { title: 'OpenAI on X: "GPT-5.6 is available starting today…"', url: 'https://x.com/OpenAI/status/2087947721936359705', snippet: '', domain: 'x.com' },
        { title: 'Second handle on X: "another post"', url: 'https://x.com/Other/status/2088919317257556359', snippet: '', domain: 'x.com' },
        { title: 'a non-status hit', url: 'https://x.com/OpenAI', snippet: 'profile', domain: 'x.com' },
      ]
      const r = await fallbackXSearch({ type: 'keyword', query: 'OpenAI GPT-5.6', limit: 3, webSearch: async () => hits })
      assert.equal(r.via, 'engines+oembed')
      assert.equal(r.data.length, 3)
      const first = r.data[0]
      assert.equal(first.id, '2087947721936359705')
      assert.match(first.text, /Full post text for 2087947721936359705/)
      assert.equal(first.username, 'OpenAI')
      // non-status hit keeps its engine title, no id
      assert.equal(r.data[2].id, '')
      assert.match(r.data[2].text, /a non-status hit/)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('keyword: engine-only via when oEmbed fails (network down)', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('network down') }
    try {
      const hits = [
        { title: 'OpenAI on X: "short"', url: 'https://x.com/OpenAI/status/1', snippet: '', domain: 'x.com' },
      ]
      const r = await fallbackXSearch({ type: 'keyword', query: 'OpenAI', limit: 3, webSearch: async () => hits })
      assert.equal(r.via, 'engines')
      assert.equal(r.data[0].id, '1')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('thread: oEmbed single-post full text', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://publish.x.com/oembed')) {
        return new Response(
          JSON.stringify({ author_name: 'OpenAI', author_url: 'https://x.com/OpenAI', html: oembedFor('123') }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch in test: ${u}`)
    }
    try {
      const r = await fallbackXSearch({ type: 'thread', post_id: 'https://x.com/OpenAI/status/123' })
      assert.equal(r.via, 'oembed')
      assert.equal(r.data[0].id, '123')
      assert.match(r.data[0].text, /Full post text for 123/)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('user: guest GraphQL down → engines profile links', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('all network down') }
    try {
      const r = await fallbackXSearch({
        type: 'user',
        username: '@NASA',
        limit: 2,
        webSearch: async () => [
          { title: 'NASA (@NASA) / X', url: 'https://x.com/NASA', snippet: '', domain: 'x.com' },
        ],
      })
      assert.equal(r.via, 'engines')
      assert.equal(r.data[0].username, 'NASA')
      assert.equal(r.data[0].url, 'https://x.com/NASA')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('keyword: no results → rejects', async () => {
    await assert.rejects(
      () => fallbackXSearch({ type: 'keyword', query: 'nothing', webSearch: async () => [] }),
      /no results/,
    )
  })

  it('user: guest + engines both down → rejects', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('network down') }
    try {
      await assert.rejects(
        () => fallbackXSearch({ type: 'user', username: '@NASA', webSearch: async () => [] }),
        /both failed/,
      )
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('v0.0.4 wiring regression', () => {
  // The x_search tool's engine fan-out must be wired to the engine registry
  // (a missing `engines` param used to blow up inside execute). Hermetic: all
  // fetches are mocked to throw, so no network and no credential state
  // matters — both the parallel and the fallback path converge to a fast
  // 'error' result whose message does NOT mention an engine wiring failure.
  it('x_search execute reaches the fallback chain (no ReferenceError)', async () => {
    const { apply } = await import('../index.js')
    const tools = new Map()
    const commands = new Map()
    const ctx = {
      get: (s) => ({ commands: commandsService, subagents: null }[s]),
      web: { registerSearchProvider: () => {} },
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => {} },
      timeout: (ms) => ms,
    }
    const commandsService = { register: (c) => { commands.set(c.name, c); return c } }
    apply(ctx, {})
    const xTool = tools.get('x_search')
    assert.ok(xTool, 'x_search tool registered')

    const origFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('network down (test)') }
    try {
      const result = await xTool.execute({ type: 'keyword', query: 'wiring probe' }, { signal: undefined })
      assert.equal(result.via, 'error')
      assert.ok(result.error)
      assert.doesNotMatch(result.error, /engines is not defined|ReferenceError/)
      assert.match(result.error, /no results|failed/)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('x_search per-kind TTL cache: repeat call returns cacheHit', async () => {
    const { apply } = await import('../index.js')
    const tools = new Map()
    const ctx = {
      get: (s) => ({ commands: { register: () => {} }, subagents: null }[s]),
      web: { registerSearchProvider: () => {} },
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => {} },
      timeout: (ms) => ms,
    }
    apply(ctx, {})
    const xTool = tools.get('x_search')
    const origFetch = globalThis.fetch
    // deterministic engine response: one bing-style HTML hit per call
    let calls = 0
    globalThis.fetch = async (url) => {
      calls++
      const u = String(url)
      if (u.startsWith('https://www.bing.com/')) {
        return new Response(
          '<li class="b_algo"><h2><a href="https://x.com/OpenAI/status/111">OpenAI on X: &quot;cached probe post&quot;</a></h2><p>probe</p></li>',
          { status: 200 },
        )
      }
      if (u.startsWith('https://publish.x.com/oembed')) {
        return new Response(
          JSON.stringify({ author_name: 'OpenAI', author_url: 'https://x.com/OpenAI', html: '<blockquote>Full cached probe post body &amp; more</blockquote>' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error('unexpected fetch in cache test: ' + u)
    }
    try {
      const args = { type: 'keyword', query: 'cached probe', max_results: 1 }
      const first = await xTool.execute(args, { signal: undefined })
      assert.ok(first.results >= 1, `first call should find the mocked hit (via=${first.via})`)
      const callsAfterFirst = calls
      const second = await xTool.execute(args, { signal: undefined })
      assert.equal(second.cacheHit, true)
      assert.ok(calls <= callsAfterFirst, 'cache hit must not re-fetch')
      assert.deepEqual(second.items, first.items)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('v0.0.5 DSH-native integration', () => {
  // Full mock ctx capturing every DSH surface the plugin now uses.
  function makeMockCtx() {
    const tools = new Map()
    const commands = new Map()
    const sections = []
    const variables = new Map()
    const disposers = []
    const providers = { search: undefined, fetch: undefined }
    const ctx = {
      effect: (d) => disposers.push(d),
      get: (s) => ({ commands: commandsService, subagents: null }[s]),
      web: {
        registerSearchProvider: (p) => { providers.search = p; return () => {} },
        registerFetchProvider: (p) => { providers.fetch = p; return () => {} },
      },
      tools: { register: (t) => { tools.set(t.name, t); return () => {} } },
      systemPrompt: {
        section: (s) => { sections.push(s); return () => {} },
        variable: (name, provider) => { variables.set(name, provider); return () => {} },
      },
      timeout: (ms) => ms,
    }
    const commandsService = { register: (c) => { commands.set(c.name, c); return () => {} } }
    return { ctx, tools, commands, sections, variables, disposers, providers }
  }

  it('registers the web fetch provider and maps fetchPage results into the seam contract', async () => {
    const { apply } = await import('../index.js')
    const mock = makeMockCtx()
    apply(mock.ctx, {})
    assert.ok(mock.providers.fetch, 'fetch provider registered')
    assert.equal(mock.providers.fetch.id, 'dsh-search-boost')
    assert.equal(mock.providers.fetch.available(), true)

    const origFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('https://r.jina.ai/')) {
        return new Response('# Page\n\nhello world body here with enough padding text to clear the short-content fallback threshold comfortably\n\nmore paragraph text to be safe\n\n', { status: 200 })
      }
      throw new Error('unexpected fetch: ' + u)
    }
    try {
      const result = await mock.providers.fetch.fetch({ url: 'https://1.1.1.1/doc' })
      assert.equal(result.url, 'https://1.1.1.1/doc')
      assert.equal(result.statusCode, 200)
      assert.equal(result.body.kind, 'text')
      assert.match(result.body.content, /hello world/)
      assert.equal(result.truncated, false)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('registers a live search:status section (dynamic text evaluated per assembly)', async () => {
    const { apply } = await import('../index.js')
    const mock = makeMockCtx()
    apply(mock.ctx, {})
    const section = mock.sections.find((s) => s.name === 'search:status')
    assert.ok(section, 'search:status section registered')
    assert.equal(section.order, 116)
    assert.equal(typeof section.text, 'function', 'status must be a dynamic per-assembly text function')
    const line = section.text()
    assert.match(line, /search status — layer: (free|api)/)
    assert.match(line, /x_search: (official path|fallback chain)/)
    // evaluated fresh each call
    assert.ok(section.text().length > 0)
  })

  it('search tools declare DSH-native presentation (call views + web result cards)', async () => {
    const { apply } = await import('../index.js')
    const mock = makeMockCtx()
    apply(mock.ctx, {})

    const fused = mock.tools.get('fused_search')
    const call = fused.presentCall({ query: 'tokio latest', max_results: 5 })
    assert.equal(call.card, 'generic')
    assert.equal(call.kind, 'search')
    assert.match(call.title, /fused_search/)

    const value = {
      query: 'tokio',
      results: [{ title: 'Tokio', url: 'https://tokio.rs', snippet: 'async', published: '2026-01-01', domain: 'tokio.rs' }],
      tookMs: 10,
      tier: 'simple',
    }
    const meta = fused.output.presentationMeta({ query: 'tokio', max_results: 5 }, value)
    assert.equal(meta.sources.length, 1)
    assert.equal(meta.sources[0].url, 'https://tokio.rs')
    assert.equal(meta.sources[0].publishedAt, '2026-01-01')
    const view = fused.presentResult({ query: 'tokio' }, { content: [], isError: false, meta })
    assert.equal(view.card, 'web')
    assert.equal(view.kind, 'search')
    assert.equal(view.sources[0].title, 'Tokio')

    const x = mock.tools.get('x_search')
    const xCall = x.presentCall({ type: 'keyword', query: 'ollama' })
    assert.equal(xCall.kind, 'search')
    assert.match(xCall.title, /x_search keyword/)
    const xMeta = x.output.presentationMeta({}, {
      via: 'parallel',
      results: 1,
      items: [{ id: '1', author: 'OpenAI', username: 'OpenAI', text: 'hello from X', url: 'https://x.com/OpenAI/status/1' }],
    })
    assert.equal(xMeta.sources.length, 1)
    assert.equal(xMeta.sources[0].url, 'https://x.com/OpenAI/status/1')
    assert.match(xMeta.sources[0].title, /OpenAI/)
    // user shape: recent_posts flattened into sources
    const userMeta = x.output.presentationMeta({}, {
      via: 'guest-graphql',
      results: 1,
      items: [{ name: 'NASA', username: 'NASA', recent_posts: [{ id: '2', text: 'post body', url: 'https://x.com/NASA/status/2' }] }],
    })
    assert.equal(userMeta.sources.length, 1)
    assert.equal(userMeta.sources[0].url, 'https://x.com/NASA/status/2')
    const xView = x.presentResult({}, { content: [], isError: false, meta: xMeta })
    assert.equal(xView.card, 'web')
    assert.equal(xView.kind, 'search')

    const fetch = mock.tools.get('fetch_page')
    assert.equal(fetch.presentCall({ url: 'https://example.com/a' }).kind, 'fetch')
    const fetchMeta = fetch.output.presentationMeta({}, { url: 'https://example.com/a', via: 'jina', content: 'x', truncated: true })
    const fetchView = fetch.presentResult({}, { content: [], isError: false, meta: fetchMeta })
    assert.equal(fetchView.card, 'web')
    assert.equal(fetchView.kind, 'fetch')
    assert.equal(fetchView.statusCode, 200)
    assert.equal(fetchView.truncated, true)
  })

  it('wires every registration disposer into ctx.effect (Cordis teardown)', async () => {
    const { apply } = await import('../index.js')
    const mock = makeMockCtx()
    apply(mock.ctx, {})
    // search + fetch providers, 6 tools, policy section, status variable, 3 commands
    assert.ok(mock.disposers.length >= 12, `expected >=12 disposers, got ${mock.disposers.length}`)
    assert.ok(mock.disposers.every((d) => typeof d === 'function'))
  })

  it('/x-login never records its raw input (API key hygiene)', async () => {
    const { apply } = await import('../index.js')
    const mock = makeMockCtx()
    apply(mock.ctx, {})
    const login = mock.commands.get('x-login')
    assert.ok(login, '/x-login registered')
    assert.equal(login.recordInput, false, 'API key must not land in the session log')
    // invalid key is rejected without touching any state file (a valid-format
    // key would write real state — never exercised in tests)
    const out = login.handler({ rawInput: '-k not-a-real-key' })
    assert.equal(out.kind, 'error')
    assert.match(out.text, /must start with "xai-"/)
  })

  it('command + prompt metadata passes DSH contract validation', async () => {
    const { apply } = await import('../index.js')
    const mock = makeMockCtx()
    apply(mock.ctx, {})
    // the status contribution must go through section() (dynamic text), NOT
    // systemPrompt.variable() — variable() throws in the real DSH host
    // ("reading 'layers'"); any variable names must still satisfy the pattern
    for (const name of mock.variables.keys()) {
      assert.match(name, /^[a-z][a-z0-9_]*$/, `variable name "${name}" must satisfy the DSH pattern`)
    }
    for (const s of mock.sections) {
      if (s.text !== undefined && typeof s.text !== 'string' && typeof s.text !== 'function') {
        assert.fail(`section "${s.name}" text must be a string or function`)
      }
    }
    // command input hints, when present, must be non-empty (an empty hint made
    // commands.register throw for /x-logout)
    for (const [name, cmd] of mock.commands) {
      if (cmd.input) {
        assert.ok(String(cmd.input.hint ?? '').trim().length > 0, `command "${name}" input hint must not be empty`)
      }
    }
    // /x-logout carries no input descriptor at all now
    assert.equal(mock.commands.get('x-logout').input, undefined)
  })

  it('research tools declare result cards via presentationMeta projection', async () => {
    const { apply } = await import('../index.js')
    const mock = makeMockCtx()
    apply(mock.ctx, {})

    const research = mock.tools.get('deep_research')
    const rMeta = research.output.presentationMeta({}, { round: 2, sources: [{ url: 'https://a.example' }], gaps: ['g1'], suggested_queries: ['q1'] })
    assert.equal(rMeta.round, 2)
    assert.equal(rMeta.sourceCount, 1)
    const rView = research.presentResult({}, { content: [], isError: false, meta: rMeta })
    assert.equal(rView.card, 'generic')
    assert.match(rView.title, /round 2, 1 sources/)

    const parallel = mock.tools.get('research_parallel')
    const pMeta = parallel.output.presentationMeta({}, { sub_tasks: [{}, {}], merged_sources: ['a', 'b', 'c'] })
    assert.equal(pMeta.taskCount, 2)
    assert.equal(pMeta.sourceCount, 3)
    const pView = parallel.presentResult({}, { content: [], isError: false, meta: pMeta })
    assert.match(pView.title, /2 tasks, 3 merged sources/)

    const stats = mock.tools.get('search_stats')
    const sMeta = stats.output.presentationMeta({}, { cacheHits: 5, cacheMisses: 2, layer: 'free', grok: false, x: { source: 'none', official: false } })
    assert.equal(sMeta.cacheHits, 5)
    const sView = stats.presentResult({}, { content: [], isError: false, meta: sMeta })
    assert.match(sView.title, /5 cache hits \/ 2 misses/)
    assert.match(sView.title, /x_search fallback/)

    // no meta → presentResult degrades to undefined (raw content renders)
    assert.equal(research.presentResult({}, { content: [], isError: false }), undefined)
  })
})

describe('v0.0.3 wiring', () => {
  it('index.js no longer imports the removed grok CLI module', () => {
    assert.doesNotMatch(indexSrc, /lib\/grok\.js/)
    assert.match(indexSrc, /lib\/xsearch\.js/)
    assert.match(indexSrc, /lib\/xfallback\.js/)
    assert.match(indexSrc, /lib\/xauth\.js/)
  })

  it('index.js registers /x-login and /x-logout commands', () => {
    assert.match(indexSrc, /registerXLoginCommand\(ctx\)/)
    assert.match(indexSrc, /registerXLogoutCommand\(ctx\)/)
    assert.match(indexSrc, /name: 'x-login'/)
    assert.match(indexSrc, /name: 'x-logout'/)
  })

  it('x_search tool exposes the four modes and credential-free promise', () => {
    const tool = indexSrc.slice(indexSrc.indexOf("name: 'x_search'"), indexSrc.indexOf('// ---------- /x-login'))
    for (const mode of ['keyword', 'semantic', 'user', 'thread']) {
      assert.match(tool, new RegExp(mode))
    }
    assert.match(tool, /xAuthAvailableSync\(\)/)
    assert.match(tool, /Promise\.allSettled/)
    assert.match(tool, /fallbackXSearch/)
  })

  it('<search_balance> policy routes X-specific questions to x_search', () => {
    assert.match(SEARCH_POLICY_SECTION.text, /x_search：X\/Twitter 数据/)
    assert.match(SEARCH_POLICY_SECTION.text, /guest GraphQL 结构化/)
  })
})
