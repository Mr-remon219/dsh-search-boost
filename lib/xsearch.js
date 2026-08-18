// x_search primary path: direct Responses-API POST aligned with the local
// Grok Build install (~/.grok -- models_cache.json, auth.json, cli-chat-proxy).
//
//   grok-session -> https://cli-chat-proxy.grok.com/v1/responses
//                  (OIDC from /x-login import of ~/.grok/auth.json)
//   api-key      -> https://api.x.ai/v1/responses (XAI_API_KEY)
//
// Wire format matches Grok Build / pi-search-boost: structured input messages,
// reasoning.effort, hosted-tool filters on the tool object, x-grok-client-* headers.
// When unavailable, callers degrade to lib/xfallback.js.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readPiAuth, jwtTier, refreshOidcToken, savePiAuth, syncGrokAuthKey } from './xauth.js'

const GROK_DIR = path.join(os.homedir(), '.grok')
const MODELS_CACHE_FILE = path.join(GROK_DIR, 'models_cache.json')

/** Read client version + default model from the local grok install when present. */
export function readGrokClientInfo() {
  try {
    const cache = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, 'utf8'))
    const version = String(cache?.grok_version ?? '1.0.4')
    const defaultModel = cache?.models?.['grok-4.6'] ? 'grok-4.6'
      : (cache?.models && Object.keys(cache.models)[0]) || 'grok-4.6'
    return { version, defaultModel, authMethod: cache?.auth_method ?? null }
  } catch {
    return { version: '1.0.4', defaultModel: 'grok-4.6', authMethod: null }
  }
}

const GROK_CLIENT = readGrokClientInfo()
/** Server gate: cli-chat-proxy refuses requests below this CLI version. */
const CLIENT_VERSION = GROK_CLIENT.version
const INTERNAL_BASE = 'https://cli-chat-proxy.grok.com/v1'
const PUBLIC_BASE = 'https://api.x.ai/v1'
export const DEFAULT_X_MODEL = GROK_CLIENT.defaultModel
const PRIMARY_TIMEOUT_MS = 90_000

export function xAuthAvailableSync() {
  const envKey = process.env.XAI_API_KEY
  if (envKey && envKey.startsWith('xai-')) return true
  return Boolean(readPiAuth()?.key)
}

const statusId = (url) => (String(url ?? '').match(/\/status\/(\d+)/)?.[1]) ?? ''

function withTimeout(signal, ms) {
  if (!signal) return AbortSignal.timeout(ms)
  try {
    return AbortSignal.any([signal, AbortSignal.timeout(ms)])
  } catch {
    return signal
  }
}

function grokSessionHeaders() {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch
  return {
    'user-agent': `grok-shell/${CLIENT_VERSION} (${process.platform}; ${arch})`,
    'x-grok-client-version': CLIENT_VERSION,
    'x-grok-client-identifier': 'grok-shell',
  }
}

/** Drive the model toward one X sub-tool + structured JSON (Grok Build prompt style). */
export function buildXSearchPrompt(kind, params, maxResults) {
  const n = Math.max(1, Math.min(Math.floor(maxResults ?? 5), 20))
  const isUser = kind === 'user'
  const schema = isUser
    ? '{"id":str,"name":str,"username":str,"bio":str,"followers":num,"following":num,"verified":bool,"url":str,"recent_posts":[...]}'
    : '{"id":str,"author":str,"username":str,"text":str,"url":str,"likes":num,"reposts":num,"replies":num,"views":num,"media":[str]}'
  const dateNote = [params.from_date && `from_date=${params.from_date}`, params.to_date && `to_date=${params.to_date}`]
    .filter(Boolean)
    .join(', ')
  let task
  switch (kind) {
    case 'keyword':
      task = `Search X posts with the keyword query: ${JSON.stringify(params.query ?? params.username ?? '')}`
      break
    case 'semantic':
      task = `Search X posts semantically related to: ${JSON.stringify(params.query ?? '')}`
      break
    case 'user':
      task = `Search X USER ACCOUNTS (not posts) matching: ${JSON.stringify(params.username ?? params.query ?? '')}`
      break
    case 'thread': {
      const id = String(params.post_id ?? '').match(/\d+/)?.[0] ?? params.post_id
      task = `Fetch the full X conversation (root post, parent, replies) for post id: ${id}`
      break
    }
    default:
      throw new Error(`x_search: unknown type "${kind}"`)
  }
  return [
    'You have the x_search tool. Use it now for this task:',
    task,
    dateNote ? `Restrict the search range to: ${dateNote}.` : '',
    params.allowed_x_handles?.length ? `Only consider posts from these handles: ${params.allowed_x_handles.join(', ')}.` : '',
    params.excluded_x_handles?.length ? `Exclude posts from these handles: ${params.excluded_x_handles.join(', ')}.` : '',
    '',
    isUser
      ? 'After the tool returns, your ENTIRE reply must be ONLY one valid JSON object (no prose, no fences) with keys: id, name, username, followers, following, verified, bio, created_at, url, recent_posts (array of posts).'
      : `After the tool returns, your ENTIRE reply must be ONLY a valid JSON array (no prose, no fences) of up to ${n} items, each shaped like:`,
    isUser ? '' : schema,
    isUser ? '' : 'Return most relevant first. If the tool found nothing, reply []. Never fabricate posts.',
  ].filter(Boolean).join('\n')
}

/** Hosted x_search tool config -- filters on the tool object (Grok Build wire format). */
export function buildXToolConfig(params) {
  if (params.allowed_x_handles?.length && params.excluded_x_handles?.length) {
    throw new Error('allowed_x_handles and excluded_x_handles are mutually exclusive')
  }
  const cfg = { type: 'x_search' }
  if (params.allowed_x_handles?.length) cfg.allowed_x_handles = params.allowed_x_handles.slice(0, 20)
  if (params.excluded_x_handles?.length) cfg.excluded_x_handles = params.excluded_x_handles.slice(0, 20)
  if (params.from_date) cfg.from_date = params.from_date
  if (params.to_date) cfg.to_date = params.to_date
  return cfg
}

export function extractJsonPayload(raw) {
  const trimmed = String(raw ?? '').trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(trimmed)
  if (fenced) return fenced[1].trim()
  const inline = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (inline) return inline[1].trim()
  return trimmed
}

/** Balanced top-level JSON spans -- tracks both `{`/`}` and `[`/`]`. */
function topLevelJsonSpans(text) {
  const spans = []
  const stack = []
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
    else if (ch === '{' || ch === '[') {
      if (stack.length === 0) start = i
      stack.push(ch)
    } else if (ch === '}' || ch === ']') {
      const open = stack[stack.length - 1]
      const match = (ch === '}' && open === '{') || (ch === ']' && open === '[')
      if (match) {
        stack.pop()
        if (stack.length === 0 && start >= 0) {
          spans.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  return spans
}

function looksLikeUserProfile(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const hasIdentity = Boolean(obj.username || obj.name || obj.id)
  const looksLikePost = Boolean(obj.text || obj.url)
    && obj.recent_posts == null
    && obj.followers == null
    && obj.following == null
    && obj.bio == null
  return hasIdentity && !looksLikePost
}

function acceptDirectParse(val, kind) {
  if (val === null) return undefined
  if (kind === 'user') {
    if (Array.isArray(val)) {
      if (val.length === 0) return null
      const profile = val.find(looksLikeUserProfile)
      return profile ?? null
    }
    if (val && typeof val === 'object') return looksLikeUserProfile(val) ? val : null
    return null
  }
  return val
}

/** Kind-aware JSON salvage: posts kinds prefer arrays; user prefers profile objects. */
export function salvageJsonForKind(text, kind) {
  const clean = extractJsonPayload(String(text ?? '').replace(/```json|```/g, '').trim())
  const tryParse = (t) => { try { return JSON.parse(t) } catch { return null } }
  const direct = tryParse(clean)
  const directAccepted = acceptDirectParse(direct, kind)
  if (directAccepted !== undefined) return directAccepted

  const spans = topLevelJsonSpans(clean)
  if (kind === 'user') {
    for (const span of spans) {
      if (!span.startsWith('{')) continue
      const parsed = tryParse(span)
      if (parsed && looksLikeUserProfile(parsed)) return parsed
    }
    return null
  }

  const arrays = spans.filter((s) => s.startsWith('['))
  for (const span of arrays) {
    const parsed = tryParse(span)
    if (parsed !== null) return parsed
  }
  for (const span of spans) {
    const parsed = tryParse(span)
    if (parsed !== null) return parsed
  }
  return null
}

export function salvageJson(text) {
  return salvageJsonForKind(text, 'keyword')
}

export function parseFinalMessage(json) {
  const output = json.output ?? []
  let text = ''
  for (let i = output.length - 1; i >= 0; i--) {
    const o = output[i]
    if (o?.type !== 'message') continue
    let msgText = ''
    for (const c of o.content ?? []) {
      if ((c?.type === 'output_text' || c?.type === 'text') && c.text) msgText += c.text
    }
    if (msgText.trim()) {
      text = msgText
      break
    }
  }
  const raw = text.trim()
  const salvaged = salvageJson(raw)
  if (salvaged !== null) return { raw, data: salvaged }
  try {
    return { raw, data: JSON.parse(extractJsonPayload(raw)) }
  } catch {
    return { raw, data: raw }
  }
}

function entitlementRejected(raw, data) {
  if (Array.isArray(data) || (data && typeof data === 'object')) return false
  const lower = String(raw ?? '').toLowerCase()
  return lower.includes('subscription required')
    || lower.includes('not entitled')
    || lower.includes('x tools are not available')
    || lower.includes('no access to x')
}

const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : [])

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

async function resolveCredentials(signal) {
  const envKey = process.env.XAI_API_KEY
  if (envKey && envKey.startsWith('xai-')) {
    return {
      credential: 'api-key',
      baseUrl: PUBLIC_BASE,
      headers: { authorization: `Bearer ${envKey}` },
      entry: null,
    }
  }
  let entry = readPiAuth()
  if (!entry?.key) {
    throw new Error('official x_search is not enabled: run /x-login (imports your grok login) or /x-login -k <XAI_API_KEY>. Until then x_search uses the multi-engine / guest-GraphQL / oEmbed fallback chain only.')
  }
  if (entry.kind === 'api-key') {
    return {
      credential: 'api-key',
      baseUrl: PUBLIC_BASE,
      headers: { authorization: `Bearer ${entry.key}` },
      entry,
    }
  }
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
  return {
    credential: 'grok-session',
    baseUrl: INTERNAL_BASE,
    headers: { authorization: `Bearer ${entry.key}`, ...grokSessionHeaders() },
    entry,
  }
}

export async function runXTool(params, signal) {
  const started = Date.now()
  const kind = params.type
  let { credential, baseUrl, headers, entry } = await resolveCredentials(signal)

  const prompt = buildXSearchPrompt(kind, params, params.max_results)
  const body = {
    model: params.model ?? DEFAULT_X_MODEL,
    reasoning: { effort: params.reasoning_effort ?? 'low' },
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    tools: [buildXToolConfig(params)],
    stream: false,
  }

  const postOnce = async (authHeaders) => {
    let res
    try {
      res = await fetch(`${baseUrl}/responses`, {
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
  if (res.status === 401 && credential === 'grok-session' && entry?.refresh_token) {
    const refreshed = await refreshOidcToken(entry, signal)
    if (refreshed?.key) {
      entry = refreshed
      savePiAuth({ ...refreshed })
      syncGrokAuthKey(refreshed.key, refreshed.refresh_token)
      headers = { authorization: `Bearer ${entry.key}`, ...grokSessionHeaders() }
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
  const { raw: finalText, data: parsed0 } = parseFinalMessage(json)
  let parsed = salvageJsonForKind(finalText, kind)
  if (parsed === null) {
    if (kind === 'user') {
      if (parsed0 && typeof parsed0 === 'object' && !Array.isArray(parsed0)) parsed = parsed0
    } else {
      parsed = parsed0
    }
  }
  if (entitlementRejected(finalText, parsed)) {
    throw new Error(`x_search rejected: ${finalText.slice(0, 400)}`)
  }
  if (parsed === null || parsed === undefined || (typeof parsed === 'string' && !parsed.trim())) {
    throw new Error('xAI hosted x_search produced no structured result')
  }

  const data = kind === 'user' ? [normalizeUser(parsed)] : normalizePosts(parsed)
  if (data.length === 0) {
    throw new Error('xAI hosted x_search returned 0 results')
  }
  return { type: kind, data, tookMs: Date.now() - started, credential, model: json.model ?? params.model ?? DEFAULT_X_MODEL }
}
