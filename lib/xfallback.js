// xfallback — credential-free fallback for x_search, entirely on the
// multi-engine route (v0.0.3). No search-engine HTML scraping, no X login,
// no X API key. Routing by type:
//
//   keyword/semantic → injected multi-engine search (site-restricted to
//                      x.com) → oEmbed full-text enhancement for the top
//                      1-2 status URLs
//   user             → guest GraphQL (X's anonymous web API): structured
//                      profile + recent timeline (full text, engagement)
//                      → engine profile links when guest fails
//   thread           → oEmbed single-post full text
//
// Hardening ported from the pi iteration:
//   - Windows undici defaults to IPv6-first DNS, which times out against some
//     hosts (bing.com, x.com) — every fetch here goes through an IPv4-forced
//     https.Agent (xfetch)
//   - guest token cached on disk (2h TTL, atomic write)
//   - query ids rotate on X redeploys → on 404, re-extract the latest ids
//     from x.com's JS bundles and retry once
//   - new-shape UserByScreenName parsing (rest_id / profile_bio /
//     relationship_counts / verification) with legacy-shape fallback

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as https from 'node:https'
import * as dns from 'node:dns'
import { writeJsonAtomic } from './xauth.js'

// ---------------------------------------------------------------------------
// IPv4-forced fetch (Windows + undici fix)
// ---------------------------------------------------------------------------

const ipv4Agent = new https.Agent({
  lookup: (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, family: 4 }, callback)
  },
})

/** fetch through the IPv4-forced agent (agent is a runtime-only undici option). */
export function xfetch(url, init = {}) {
  return fetch(url, { ...init, agent: ipv4Agent })
}

/** Combine a caller signal with a hard timeout so a stalled server cannot hang the call. */
function withTimeout(signal, ms) {
  if (!signal) return AbortSignal.timeout(ms)
  try {
    return AbortSignal.any([signal, AbortSignal.timeout(ms)])
  } catch {
    return signal
  }
}

const UA_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'

/** Public web bearer shipped by x.com's own JS — not a secret. */
const WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

/** Feature-flag blob required by these operations (validated subset). */
const FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_media_download_video_enabled: false,
  profile_label_improvements_pcf_label_in_profile_enabled: false,
  longform_notetweets_consumption_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  rweb_video_timestamps_enabled: false,
  responsive_web_grok_share_attachment_enabled: true,
  immersive_video_status_linkable_timestamps: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_grok_analysis_button_from_backend: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_annotations_enabled: false,
  post_ctas_fetch_enabled: false,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_twitter_blue_verified_badge_is_enabled: true,
  responsive_web_grok_show_analysis_button: true,
  responsive_web_grok_show_trends_button: false,
  view_counts_everywhere_api_enabled: true,
}

// ---------------------------------------------------------------------------
// guest token (2h disk cache)
// ---------------------------------------------------------------------------

const GUEST_CACHE_FILE = path.join(os.homedir(), '.dsh-search-boost-xguest.json')
const GUEST_TTL_MS = 2 * 3600 * 1000

async function guestToken(signal) {
  try {
    const cached = JSON.parse(fs.readFileSync(GUEST_CACHE_FILE, 'utf8'))
    if (cached?.token && cached?.ts && Date.now() - cached.ts < GUEST_TTL_MS) {
      return cached.token
    }
  } catch { /* miss */ }
  const res = await xfetch('https://api.x.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: { authorization: `Bearer ${WEB_BEARER}`, 'user-agent': UA_CHROME },
    signal: withTimeout(signal, 20000),
  })
  if (!res.ok) throw new Error(`guest token mint failed: http ${res.status}`)
  const d = await res.json().catch(() => null)
  if (!d?.guest_token) throw new Error('guest token mint returned no token')
  try {
    writeJsonAtomic(GUEST_CACHE_FILE, { token: d.guest_token, ts: Date.now() })
  } catch { /* cache is best-effort */ }
  return d.guest_token
}

/** Drop the cached guest token so the next call mints a fresh one. */
function invalidateGuestToken() {
  try {
    fs.unlinkSync(GUEST_CACHE_FILE)
  } catch { /* nothing cached */ }
}

// ---------------------------------------------------------------------------
// GraphQL (guest) — query ids rotate on X redeploys; self-heal on 404
// ---------------------------------------------------------------------------

const USER_BY_SCREEN_NAME = 'Gb-d6r0vxPOADdG62OEBpQ'
const USER_TWEETS = 'SXVCYB8XHSS25nzIljNtZA'

// mutable: refreshQueryIds() re-extracts these from x.com's JS bundles
const queryIds = { UserByScreenName: USER_BY_SCREEN_NAME, UserTweets: USER_TWEETS }

function graphqlUrl(op, variables) {
  const qid = queryIds[op] ?? ''
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(FEATURES),
  })
  return `https://x.com/i/api/graphql/${qid}/${op}?${params.toString()}`
}

/** Re-extract current query ids from x.com's JS bundles. Returns true if any were found. */
export async function refreshQueryIds(signal) {
  try {
    const page = await xfetch('https://x.com/home', {
      headers: { 'user-agent': UA_CHROME },
      signal: withTimeout(signal, 20000),
    })
    const html = await page.text()
    const bundles = [...html.matchAll(/src="(https:\/\/abs\.twimg\.com\/[^"]+\.js)"/g)]
      .map((m) => m[1])
      .slice(0, 6)
    let found = 0
    for (const bundle of bundles) {
      const res = await xfetch(bundle, { signal: withTimeout(signal, 20000) })
      const js = await res.text()
      for (const m of js.matchAll(/"operationName":"(UserByScreenName|UserTweets)","queryId":"([A-Za-z0-9_-]+)"/g)) {
        queryIds[m[1]] = m[2]
        found++
      }
      for (const m of js.matchAll(/"queryId":"([A-Za-z0-9_-]+)","operationName":"(UserByScreenName|UserTweets)"/g)) {
        queryIds[m[2]] = m[1]
        found++
      }
    }
    return found > 0
  } catch {
    return false
  }
}

async function graphqlGet(op, variables, signal) {
  let token = await guestToken(signal)
  const headers = () => ({
    authorization: `Bearer ${WEB_BEARER}`,
    'x-guest-token': token,
    'x-twitter-client-language': 'en',
    referer: 'https://x.com/',
    'user-agent': UA_CHROME,
  })
  const attempt = async () => {
    const res = await xfetch(graphqlUrl(op, variables), {
      headers: headers(),
      signal: withTimeout(signal, 25000),
    })
    if (!res.ok) throw new Error(`graphql ${op} http ${res.status}`)
    return res.json()
  }
  try {
    return await attempt()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/404/.test(msg)) {
      // query id rotated → self-heal by re-extracting from x.com's JS bundles
      const refreshed = await refreshQueryIds(signal)
      if (refreshed) return attempt()
    }
    if (/(401|403)/.test(msg)) {
      // guest token invalidated server-side → re-mint once and retry
      invalidateGuestToken()
      token = await guestToken(signal)
      return attempt()
    }
    throw err
  }
}

/** "User:11348282" (base64) → "11348282"; digit-only input passes through. */
export function decodeUserId(b64) {
  const s = String(b64)
  if (/^\d+$/.test(s)) return s
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8')
    const m = /:(\d+)$/.exec(decoded)
    return m ? m[1] : decoded
  } catch {
    return s
  }
}

/**
 * New-shape UserByScreenName result (rest_id / profile_bio /
 * relationship_counts / verification) with legacy-shape fallback.
 */
export function parseUser(u) {
  if (!u || typeof u !== 'object') return null
  const core = u.core ?? {}
  const legacy = u.legacy ?? {}
  const rel = u.relationship_counts ?? {}
  const verif = u.verification ?? {}
  const verifInfo = u.verification_info ?? {}
  let id = String(u.rest_id ?? u.id ?? '')
  if (id && /^[A-Za-z0-9+/]+={0,2}$/.test(id) && !/^\d+$/.test(id)) id = decodeUserId(id)
  return {
    id,
    name: String(core.name ?? legacy.name ?? ''),
    username: String(core.screen_name ?? legacy.screen_name ?? ''),
    bio: String(u.profile_bio?.description ?? legacy.description ?? ''),
    followers: rel.followers ?? legacy.followers_count,
    following: rel.following ?? legacy.friends_count,
    verified: Boolean(u.is_blue_verified ?? (verif.verified || verif.verified_type || verifInfo.is_identity_verified)),
    created_at: String(core.created_at ?? legacy.created_at ?? ''),
    recent_posts: [],
  }
}

function tweetToPost(t) {
  if (!t || typeof t !== 'object') return null
  const inner = t.__typename === 'TweetWithVisibilityResults' && t.tweet ? t.tweet : t
  const legacy = inner.legacy ?? {}
  const userRes = inner.core?.user_results?.result
  const userCore = userRes?.core ?? userRes?.legacy ?? {}
  const username = String(userCore.screen_name ?? userCore.name ?? '')
  const id = String(inner.rest_id ?? inner.id_str ?? legacy.id_str ?? '')
  const text = String(legacy.full_text ?? legacy.text ?? '')
  if (!id && !text) return null
  const views = inner.views?.count ?? inner.views?.state
  const media = (legacy.extended_entities?.media ?? [])
    .map((m) => m.media_url_https ?? m.url)
    .filter(Boolean)
  return {
    id,
    author: username,
    username,
    text,
    url: id ? (username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/status/${id}`) : '',
    likes: legacy.favorite_count,
    reposts: legacy.retweet_count,
    replies: legacy.reply_count,
    views: typeof views === 'number' ? views : undefined,
    media,
  }
}

/** Walk a UserTweets response and pull out timeline tweet posts (new-shape safe). */
export function parseTweets(d) {
  const out = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const n of node) walk(n)
      return
    }
    if (node.entryType === 'TimelineTimelineItem' && node.itemContent?.itemType === 'TimelineTweet') {
      const post = tweetToPost(node.itemContent.tweet_results?.result)
      if (post) out.push(post)
      return
    }
    // parsed JSON trees are acyclic — walk every key
    for (const k of Object.keys(node)) walk(node[k])
  }
  walk(d)
  return out
}

/** Structured profile + recent timeline for one account (anonymous). */
export async function guestUser(username, limit = 3, signal) {
  const handle = String(username ?? '').replace(/^@/, '').trim()
  if (!handle) throw new Error('guestUser requires a username')
  const d1 = await graphqlGet('UserByScreenName', { screen_name: handle, withSafetyModeUserFields: true }, signal)
  const u = d1?.data?.user?.result
  if (!u) throw new Error(`guest GraphQL: user "${handle}" not found`)
  const user = parseUser(u)
  try {
    const d2 = await graphqlGet(
      'UserTweets',
      {
        userId: user.id,
        count: Math.max(Math.min(limit ?? 3, 5), 1) * 3,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withVideos: true,
      },
      signal,
    )
    user.recent_posts = parseTweets(d2).slice(0, limit)
  } catch { /* timeline is optional */ }
  return user
}

// ---------------------------------------------------------------------------
// oEmbed (zero-auth single-post full text)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  middot: '·', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  hellip: '…', ndash: '–', mdash: '—', trade: '™', copy: '©', reg: '®',
}

const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return _m }
    })
    .replace(/&#(\d+);/g, (_m, n) => {
      try { return String.fromCodePoint(Number(n)) } catch { return _m }
    })
    .replace(/&([a-z0-9]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)

/** Extract readable text from the oEmbed `html` blockquote. */
export function parseOEmbedHtml(html) {
  const withoutScripts = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  return decodeEntities(withoutScripts.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Full text of one post via publish.x.com oEmbed (zero auth). Returns null on failure. */
export async function oembedPost(postId, signal) {
  const id = String(postId ?? '').match(/\d+/)?.[0] ?? String(postId ?? '')
  if (!id) throw new Error('oEmbed requires a numeric post id')
  const url = `https://x.com/i/status/${id}`
  const oembedUrl = `https://publish.x.com/oembed?format=json&url=${encodeURIComponent(url)}`
  const res = await xfetch(oembedUrl, {
    headers: { 'user-agent': UA_CHROME },
    signal: withTimeout(signal, 20000),
  })
  if (!res.ok) return null
  const d = await res.json().catch(() => null)
  if (!d || typeof d !== 'object') return null
  const text = parseOEmbedHtml(d.html ?? '')
  const handle = (d.author_url ?? '').match(/x\.com\/([^/?#]+)/)?.[1]
  return {
    id,
    author: d.author_name,
    username: handle,
    text,
    url,
    likes: undefined,
    reposts: undefined,
    replies: undefined,
    views: undefined,
    media: [],
  }
}

// ---------------------------------------------------------------------------
// fallback router
// ---------------------------------------------------------------------------

/** "Author on X: text" title → {author, text}. */
export function splitXTitle(title) {
  const m = /^(.+?)\s+on\s+X:\s*(.+)$/.exec(String(title ?? ''))
  if (m) return { author: m[1], text: m[2].replace(/^"|"$/g, '') }
  return { text: String(title ?? '') }
}

const statusId = (url) => String(url ?? '').match(/\/status\/(\d+)/)?.[1] ?? ''

/** Engine hit → post (title/snippet; oEmbed may upgrade it later). */
export function hitToPost(h) {
  const title = h.title ?? h.snippet ?? ''
  const { author, text } = splitXTitle(title)
  const url = h.url ?? ''
  return {
    id: statusId(url),
    author: author ?? undefined,
    username: undefined,
    text: text || (h.snippet ?? ''),
    url,
  }
}

/**
 * Credential-free fallback, routed by type. `webSearch` is injected by the
 * host (index.js) — the fused multi-engine route restricted to x.com — and is
 * tried first for keyword/semantic/user; guest GraphQL backs the user case
 * with structured data; oEmbed upgrades top status URLs to full text.
 */
export async function fallbackXSearch({ type, query, username, post_id, limit = 3, webSearch, signal }) {
  const max = Math.min(Math.max(limit ?? 3, 1), 5)

  // ---- thread: oEmbed (single post; engines cannot rebuild a thread tree) ----
  if (type === 'thread') {
    const id = String(post_id ?? '').match(/\d+/)?.[0] ?? post_id
    if (!id) throw new Error('fallback thread requires post_id')
    const post = await oembedPost(id, signal)
    if (!post) throw new Error('fallback thread: oEmbed returned nothing')
    return { type: 'thread', data: [post], via: 'oembed' }
  }

  // ---- user: guest GraphQL (structured), then engines profile links ----
  if (type === 'user') {
    const handle = String(username ?? query ?? '').replace(/^@/, '').trim()
    if (!handle) throw new Error('fallback user requires username')
    try {
      const user = await guestUser(handle, max, signal)
      if (user) return { type: 'user', data: [user], via: 'guest-graphql' }
    } catch { /* guest failed → engines */ }
    if (webSearch) {
      try {
        const hits = await webSearch(`site:x.com ${handle}`, max)
        const profiles = hits
          .filter((h) => h.url && !/\/status\//.test(h.url))
          .map((h) => ({
            id: '',
            name: h.title ?? '',
            username: (h.url ?? '').split('/').filter(Boolean).pop(),
            bio: '',
            recent_posts: [],
            url: h.url ?? '',
          }))
        if (profiles.length) return { type: 'user', data: profiles, via: 'engines' }
      } catch { /* engines down */ }
    }
    throw new Error('fallback user: guest GraphQL and engines both failed')
  }

  // ---- keyword / semantic: engines → oEmbed enhancement ----
  const q = String(query ?? '').trim()
  if (!q) throw new Error(`fallback ${type} requires query`)
  if (webSearch) {
    try {
      const hits = await webSearch(q, max)
      const posts = hits.filter((h) => h.title || h.snippet).map(hitToPost)
      if (posts.length) {
        // oEmbed enhancement: full text for the top 1-2 status URLs (parallel, best-effort)
        const targets = posts.filter((p) => p.id).slice(0, 2)
        const enhanced = await Promise.all(
          targets.map(async (p) => {
            try {
              const full = await oembedPost(p.id, signal)
              if (!full) return p
              return { ...p, author: full.author ?? p.author, username: full.username ?? p.username, text: full.text }
            } catch {
              return p
            }
          }),
        )
        const byId = new Map(enhanced.map((p) => [p.id, p]))
        const merged = posts.map((p) => (p.id ? byId.get(p.id) ?? p : p))
        const upgraded = merged.some((p) => p.id && p.text.length > 40)
        return { type, data: merged, via: upgraded ? 'engines+oembed' : 'engines' }
      }
    } catch { /* engines down */ }
  }
  throw new Error(`fallback ${type} found no results (multi-engine route unavailable)`)
}
