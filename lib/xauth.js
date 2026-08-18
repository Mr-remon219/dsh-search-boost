// xAI credential chain for x_search — explicit opt-in model (v0.0.3).
//
// The official hosted x_search path (lib/xsearch.js) is enabled ONLY by:
//   1. XAI_API_KEY env (public api.x.ai), or
//   2. a local copy written by `/x-login` (~/.dsh-search-boost-xauth.json).
// ~/.grok/auth.json is NEVER auto-consumed — `/x-login` imports it explicitly,
// `/x-logout` removes the local copy. grok CLI's own login is untouched.
//
// Zero external dependencies: node built-ins only.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** The sign-in file Grok Build / grok CLI writes. */
export function grokAuthFile() {
  return path.join(os.homedir(), '.grok', 'auth.json')
}

/** The /x-login credential copy this plugin owns. */
export function piAuthPath() {
  return path.join(os.homedir(), '.dsh-search-boost-xauth.json')
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Write a JSON file atomically (tmp + rename), creating the parent dir. */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Read grok's auth file (~/.grok/auth.json — a map of issuer::clientId →
 * auth entry). Returns the first entry or null. The grok CLI keeps this file;
 * we only ever READ it here (plus best-effort sync-back on refresh).
 */
export function readGrokAuth() {
  const parsed = readJson(grokAuthFile())
  if (!parsed || typeof parsed !== 'object') return null
  for (const key of Object.keys(parsed)) {
    const entry = parsed[key]
    if (entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key) {
      return { ...entry, entryKey: key }
    }
  }
  return null
}

/**
 * Best-effort sync refreshed tokens back into grok's auth file so the grok
 * CLI (if the user uses it) keeps a valid session after we rotate tokens.
 */
export function syncGrokAuthKey(newKey, newRefreshToken) {
  try {
    const file = grokAuthFile()
    const parsed = readJson(file)
    if (!parsed || typeof parsed !== 'object') return
    for (const key of Object.keys(parsed)) {
      const entry = parsed[key]
      if (entry && typeof entry === 'object' && typeof entry.key === 'string') {
        entry.key = newKey
        if (newRefreshToken) entry.refresh_token = newRefreshToken
        writeJsonAtomic(file, parsed)
        return
      }
    }
  } catch { /* best-effort */ }
}

/** Read the /x-login local copy. Returns the auth entry or null. */
export function readPiAuth() {
  return readJson(piAuthPath())
}

/** Persist the /x-login local copy (atomic). */
export function savePiAuth(entry) {
  writeJsonAtomic(piAuthPath(), entry)
}

/** Remove the /x-login local copy. Returns true if a file was removed. */
export function logout() {
  try {
    fs.unlinkSync(piAuthPath())
    return true
  } catch {
    return false // not present or already gone
  }
}

/**
 * `/x-login` (bare): import the grok CLI's login into our own directory.
 * Throws when grok is not signed in.
 */
export function importFromGrok() {
  const grok = readGrokAuth()
  if (!grok) {
    throw new Error(`no grok login found at ${grokAuthFile()} — run \`grok login\` first (or use /x-login -k <XAI_API_KEY>)`)
  }
  const entry = {
    kind: 'grok-session',
    key: grok.key,
    refresh_token: grok.refresh_token ?? undefined,
    email: grok.email ?? undefined,
    user_id: grok.user_id ?? undefined,
    oidc_issuer: grok.oidc_issuer ?? 'https://auth.x.ai',
    oidc_client_id: grok.oidc_client_id ?? undefined,
    expires_at: grok.expires_at ?? undefined,
    auth_mode: grok.auth_mode ?? undefined,
    imported_at: new Date().toISOString(),
  }
  savePiAuth(entry)
  return entry
}

/** `/x-login -k <key>`: store an API key (public api.x.ai path). */
export function importApiKey(key) {
  const trimmed = String(key ?? '').trim()
  if (!trimmed.startsWith('xai-')) {
    throw new Error('XAI_API_KEY must start with "xai-" (get one at console.x.ai)')
  }
  const entry = { kind: 'api-key', key: trimmed, imported_at: new Date().toISOString() }
  savePiAuth(entry)
  return entry
}

/** Decode a JWT payload (middle segment, base64url) without dependencies. */
export function jwtTier(token) {
  try {
    const parts = String(token).split('.')
    if (parts.length !== 3) return null
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4 !== 0) b64 += '='
    const claims = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    const tier = claims.tier ?? claims.membership_tier ?? claims.plan ?? claims.role ?? null
    const exp = typeof claims.exp === 'number' ? claims.exp : null
    return { exp, tier, claims }
  } catch {
    return null
  }
}

// Best-effort tier display: the numeric `tier` claim scales with plan access
// (tier 1 here carries the hosted x_search tools → highest tier).
const TIER_NAMES = {
  1: 'supergrok',
  2: 'premium+',
  3: 'standard',
  4: 'free',
  supergrok: 'supergrok',
  'premium+': 'premium+',
  standard: 'standard',
  free: 'free',
  SuperGrok: 'supergrok',
}

export function tierName(tier) {
  if (tier == null) return 'unknown'
  return TIER_NAMES[tier] ?? String(tier)
}

function expDetail(entry) {
  if (!entry?.expires_at) return ''
  const ms = Date.parse(entry.expires_at)
  if (Number.isNaN(ms)) return ''
  const age = ms - Date.now()
  if (age <= 0) return ', EXPIRED'
  return `, expires ${new Date(ms).toISOString().slice(0, 16)}Z (${Math.max(1, Math.round(age / 60000))}min)`
}

/**
 * Stable fingerprint for x_search cache keys — distinguishes env key,
 * /x-login api-key, grok-session, and the credential-free fallback path.
 */
export function xAuthCacheToken() {
  const envKey = process.env.XAI_API_KEY
  if (envKey?.startsWith('xai-')) return `env:${envKey.slice(0, 12)}`
  const entry = readPiAuth()
  if (!entry?.key) return 'none'
  if (entry.kind === 'api-key') return `pi-key:${entry.key.slice(0, 12)}`
  return `pi-grok:${entry.key.slice(-20)}`
}

/**
 * Current credential chain for display (`/x-login status` / search_stats).
 * Priority: XAI_API_KEY env → /x-login copy → (present-but-not-imported grok).
 */
export function authStatus() {
  const envKey = process.env.XAI_API_KEY
  if (envKey && envKey.startsWith('xai-')) {
    return { source: 'env', detail: `XAI_API_KEY env (${envKey.slice(0, 8)}…, public api.x.ai)` }
  }
  const entry = readPiAuth()
  if (entry?.key) {
    if (entry.kind === 'api-key') {
      return { source: 'pi', detail: `~/.dsh-search-boost-xauth.json (api-key ${entry.key.slice(0, 8)}…, public api.x.ai), imported ${entry.imported_at?.slice(0, 10) ?? '?'}` }
    }
    const claims = jwtTier(entry.key)
    return {
      source: 'pi',
      detail: `~/.dsh-search-boost-xauth.json (grok-session, ${entry.email ?? entry.user_id ?? '?'}, tier=${tierName(claims?.tier)})${expDetail(entry)}`,
    }
  }
  const grok = readGrokAuth()
  if (grok) {
    const claims = jwtTier(grok.key)
    return {
      source: 'grok',
      detail: `${grokAuthFile()} (${grok.email ?? grok.user_id ?? '?'}, tier=${tierName(claims?.tier)})${expDetail(grok)} — NOT imported; run /x-login to enable the official x_search path`,
    }
  }
  return { source: 'none', detail: 'no credentials — run /x-login (imports your grok login) or set XAI_API_KEY' }
}

/**
 * OIDC refresh at the IdP (standard OAuth2 token endpoint, discovered from
 * the entry's oidc_issuer). Returns the updated auth entry fields
 * { key, refresh_token?, expires_at? } or null when no refresh token exists.
 * Never throws for business outcomes (invalid grant etc.) — returns null.
 */
export async function refreshOidcToken(entry, signal) {
  if (entry?.kind !== 'grok-session' || !entry.refresh_token) return null
  const issuer = entry.oidc_issuer ?? 'https://auth.x.ai'
  const tokenEndpoint = `${issuer.replace(/\/+$/, '')}/oauth2/token`
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: entry.oidc_client_id ?? '',
    refresh_token: entry.refresh_token,
  })
  let res
  try {
    res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: signal ?? AbortSignal.timeout(20000),
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  let json
  try {
    json = await res.json()
  } catch {
    return null
  }
  if (!json.access_token) return null
  const out = { ...entry, key: json.access_token }
  if (json.refresh_token) out.refresh_token = json.refresh_token
  if (json.expires_in) out.expires_at = new Date(Date.now() + json.expires_in * 1000).toISOString()
  return out
}
