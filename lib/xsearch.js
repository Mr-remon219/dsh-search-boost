// x_search primary path (v0.0.3): the hosted xAI x_search tool via a direct
// Responses-API POST — no grok subprocess is ever spawned.
//
//   grok-session → https://cli-chat-proxy.grok.com/v1/responses
//                  (grok's OIDC login imported by /x-login; token refresh via
//                   the IdP with best-effort sync back to grok's file)
//   api-key      → https://api.x.ai/v1/responses (XAI_API_KEY)
//
// The hosted tool runs server-side; the final message is driven to a
// structured JSON template (posts / user / thread) that we salvage and
// normalize. When the official path is unavailable or rejected, callers
// degrade to the credential-free chain (lib/xfallback.js).

import { readPiAuth, jwtTier, refreshOidcToken, savePiAuth, syncGrokAuthKey } from './xauth.js'

/** Server gate: cli-chat-proxy refuses requests below this CLI version. */
const CLIENT_VERSION = '1.0.4'
const INTERNAL_BASE = 'https://cli-chat-proxy.grok.com/v1/responses'
const PUBLIC_BASE = 'https://api.x.ai/v1/responses'
export const DEFAULT_X_MODEL = 'grok-4.6'
const PRIMARY_TIMEOUT_MS = 75_000

/**
 * Fast synchronous credential probe (no network): is the official hosted
 * x_search path usable right now? Only XAI_API_KEY env or the /x-login local
 * copy count — ~/.grok/auth.json is NOT auto-consumed; the official path must
 * be explicitly enabled with /x-login. Returns false when nothing is
 * available, so the caller can route straight to the multi-engine fallback
 * chain instead of waiting on a timeout.
 */
export function xAuthAvailableSync() {
  const envKey = process.env.XAI_API_KEY
  if (envKey && envKey.startsWith('xai-')) return true
  return Boolean(readPiAuth()?.key)
}

/** "Author on X: text" → { author, text } — shared with the fallback chain (defined in xfallback.js). */

const statusId = (url) => (String(url ?? '').match(/\/status\/(\d+)/)?.[1]) ?? ''

/** Combine a caller signal with a hard timeout so a stalled server cannot hang the call. */
function withTimeout(signal, ms) {
  if (!signal) return AbortSignal.timeout(ms)
  try {
    return AbortSignal.any([signal, AbortSignal.timeout(ms)])
  } catch {
    return signal
  }
}

function buildKeywordPrompt(params) {
  const bits = [`query: "${params.query}"`]
  if (params.from_date) bits.push(`from_date: ${params.from_date}`)
  if (params.to_date) bits.push(`to_date: ${params.to_date}`)
  if (params.allowed_x_handles?.length) bits.push(`allowed_x_handles: ${JSON.stringify(params.allowed_x_handles.slice(0, 20))}`)
  if (params.excluded_x_handles?.length) bits.push(`excluded_x_handles: ${JSON.stringify(params.excluded_x_handles.slice(0, 20))}`)
  return bits.join('; ')
}

const POST_FIELDS = 'id, author, username, text, url, likes, reposts, replies, views, media'

export function buildXSearchPrompt(kind, params, maxResults) {
  const n = Math.max(1, Math.min(Math.floor(maxResults ?? 5), 20))
  switch (kind) {
    case 'keyword':
      return `Call the x_keyword_search tool with ${buildKeywordPrompt(params)} (${n} results). Then output ONLY a JSON array of ${n} objects with keys ${POST_FIELDS} — one object per real post you actually saw, most relevant first. Never fabricate posts. No prose, no markdown fences.`
    case 'semantic':
      return `Call the x_semantic_search tool with query: "${params.query}" (${n} results). Then output ONLY a JSON array of ${n} objects with keys ${POST_FIELDS} — one object per real post you actually saw, most relevant first. Never fabricate posts. No prose, no markdown fences.`
    case 'user': {
      const handle = params.username ?? params.query
      return `Call the x_user_search tool for the account "${handle}". Then output ONLY one JSON object with keys: id, name, username, followers, following, verified, bio, created_at, url, recent_posts (an array of up to ${n} of the account's recent posts, each with keys ${POST_FIELDS}). Use only real account data you actually saw. No prose, no markdown fences.`
    }
    case 'thread': {
      const id = String(params.post_id ?? '').match(/\d+/)?.[0] ?? params.post_id
      return `Call the x_thread_fetch tool for post id ${id}. Then output ONLY a JSON array of the full conversation's posts in chronological order, each with keys ${POST_FIELDS} and an extra key in_reply_to (the id of the post it replies to, or null). Use only real posts from the thread you actually saw. No prose, no markdown fences.`
    }
    default:
      throw new Error(`x_search: unknown type "${kind}"`)
  }
}

/** Balanced top-level JSON spans in a string, string-literal aware. */
function topLevelJsonSpans(text) {
  const spans = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) {
          spans.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  return spans
}

export function salvageJson(text) {
  const clean = String(text ?? '').replace(/```json|```/g, '').trim()
  const tryParse = (t) => { try { return JSON.parse(t) } catch { return null } }
  const direct = tryParse(clean)
  if (direct !== null) return direct
  for (const span of topLevelJsonSpans(clean)) {
    const parsed = tryParse(span)
    if (parsed !== null) return parsed
  }
  return null
}

const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : [])

/** Normalize model output into the post shape shared with the fallback chain. */
export function normalizePosts(raw) {
  return toArr(raw)
    .filter((p) => p && typeof p === 'object' && (p.text || p.url || p.username))
    .map((p) => {
      const out = {
        id: String(p.id ?? statusId(p.url) ?? ''),
        author: p.author ?? p.username ?? p.name ?? undefined,
        username: p.username ?? undefined,
        text: String(p.text ?? p.snippet ?? ''),
        url: p.url ?? (p.id ? `https://x.com/i/status/${p.id}` : ''),
      }
      for (const k of ['likes', 'reposts', 'replies', 'views']) {
        if (p[k] != null) out[k] = typeof p[k] === 'number' ? p[k] : Number(p[k]) || 0
      }
      if (Array.isArray(p.media) && p.media.length) out.media = p.media
      if (p.in_reply_to != null) out.in_reply_to = String(p.in_reply_to)
      return out
    })
}

function normalizeUser(raw) {
  // defensive: some runs return an array even for user mode — take the first
  const u = Array.isArray(raw) ? (raw[0] ?? {}) : (raw && typeof raw === 'object' ? raw : {})
  const posts = normalizePosts(u.recent_posts ?? [])
  return {
    id: String(u.id ?? ''),
    name: u.name ?? u.username ?? '',
    username: u.username ?? '',
    followers: u.followers,
    following: u.following,
    verified: Boolean(u.verified),
    bio: String(u.bio ?? ''),
    created_at: u.created_at ? String(u.created_at) : undefined,
    url: u.url ?? (u.username ? `https://x.com/${u.username}` : ''),
    recent_posts: posts,
  }
}

/**
 * Run one hosted x_search. Returns { type, data, tookMs, credential, model }.
 * data is an array of posts (keyword/semantic/thread) or [user] (user).
 * Throws with a descriptive error when the official path is unavailable or
 * the server rejects the request — callers then use the fallback chain.
 */
export async function runXTool(params, signal) {
  const started = Date.now()
  const kind = params.type
  const envKey = process.env.XAI_API_KEY
  let entry = null
  let credential = 'grok-session'
  let baseUrl = INTERNAL_BASE
  let headers

  if (envKey && envKey.startsWith('xai-')) {
    credential = 'api-key'
    baseUrl = PUBLIC_BASE
    headers = { authorization: `Bearer ${envKey}` }
  } else {
    entry = readPiAuth()
    if (!entry?.key) {
      throw new Error('official x_search is not enabled: run /x-login (imports your grok login) or /x-login -k <XAI_API_KEY>. Until then x_search uses the multi-engine / guest-GraphQL / oEmbed fallback chain only.')
    }
    if (entry.kind === 'api-key') {
      credential = 'api-key'
      baseUrl = PUBLIC_BASE
      headers = { authorization: `Bearer ${entry.key}` }
    } else {
      // grok-session via the cli-chat-proxy (same endpoint the grok CLI uses)
      const claims = jwtTier(entry.key)
      const nearExpiry = claims?.exp && claims.exp * 1000 < Date.now() + 60_000
      if (nearExpiry && entry.refresh_token) {
        const refreshed = await refreshOidcToken(entry, signal)
        if (refreshed?.key) {
          entry = refreshed
          savePiAuth({ ...refreshed })
          syncGrokAuthKey(refreshed.key, refreshed.refresh_token)
        }
      }
      headers = {
        authorization: `Bearer ${entry.key}`,
        'user-agent': `grok-shell/${CLIENT_VERSION} (${process.platform}; ${process.arch})`,
        'x-grok-client-version': CLIENT_VERSION,
        'x-grok-client-identifier': 'grok-shell',
      }
    }
  }

  const prompt = buildXSearchPrompt(kind, params, params.max_results)
  const body = {
    model: params.model ?? DEFAULT_X_MODEL,
    tools: [{ type: 'x_search' }],
    input: prompt,
    stream: false,
  }

  const postOnce = async (authHeaders) => {
    let res
    try {
      res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify(body),
        signal: withTimeout(signal, PRIMARY_TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(`xAI API request failed: ${err?.cause?.code ?? (err instanceof Error ? err.message : String(err))}`)
    }
    return { res, text: await res.text() }
  }

  let { res, text } = await postOnce(headers)
  // 401 with a refresh token → rotate once and retry (clock skew / server-side
  // revocation that the pre-flight expiry check missed)
  if (res.status === 401 && credential === 'grok-session' && entry?.refresh_token) {
    const refreshed = await refreshOidcToken(entry, signal)
    if (refreshed?.key) {
      entry = refreshed
      savePiAuth({ ...refreshed })
      syncGrokAuthKey(refreshed.key, refreshed.refresh_token)
      headers = {
        authorization: `Bearer ${entry.key}`,
        'user-agent': `grok-shell/${CLIENT_VERSION} (${process.platform}; ${process.arch})`,
        'x-grok-client-version': CLIENT_VERSION,
        'x-grok-client-identifier': 'grok-shell',
      }
      ;({ res, text } = await postOnce(headers))
    }
  }
  if (!res.ok) {
    throw new Error(`xAI API http ${res.status}: ${text.slice(0, 200)}`)
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`xAI API returned non-JSON (${text.slice(0, 120)})`)
  }
  const output = json.output ?? []
  const finalMessage = [...output].reverse().find((o) => o?.type === 'message')
  const content = finalMessage?.content ?? []
  const finalText = content
    .filter((c) => c?.type === 'output_text' || c?.type === 'text')
    .map((c) => c.text)
    .join('\n')
  const parsed = salvageJson(finalText)
  if (parsed === null) {
    throw new Error('xAI hosted x_search produced no structured result')
  }

  const data = kind === 'user' ? [normalizeUser(parsed)] : normalizePosts(parsed)
  if (data.length === 0) {
    throw new Error('xAI hosted x_search returned 0 results')
  }
  return { type: kind, data, tookMs: Date.now() - started, credential, model: json.model ?? params.model ?? DEFAULT_X_MODEL }
}
