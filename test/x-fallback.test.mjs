import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackXSearch, splitXTitle, hitToPost, parseOEmbedHtml, decodeUserId, parseUser, parseTweets } from '../lib/xfallback.js'
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
