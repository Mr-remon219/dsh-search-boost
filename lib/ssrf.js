// SSRF guard for fetch_page / local HTML fallback.
// Reject credentials, non-http(s), localhost names, and loopback / private /
// link-local / ULA / multicast addresses. Callers must re-check every redirect hop.

import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

const v4 = new BlockList()
v4.addSubnet('0.0.0.0', 8, 'ipv4')
v4.addSubnet('10.0.0.0', 8, 'ipv4')
v4.addSubnet('100.64.0.0', 10, 'ipv4')
v4.addSubnet('127.0.0.0', 8, 'ipv4')
v4.addSubnet('169.254.0.0', 16, 'ipv4')
v4.addSubnet('172.16.0.0', 12, 'ipv4')
v4.addSubnet('192.168.0.0', 16, 'ipv4')
// RFC 2544 benchmark range. Only TUN proxies (Clash/mihomo/sing-box fake-ip)
// ever answer with it — as a LITERAL target in the URL it is always blocked;
// hostname resolution into this range is handled by the TUN carve-out below.
v4.addSubnet('198.18.0.0', 15, 'ipv4')
v4.addSubnet('224.0.0.0', 4, 'ipv4')
v4.addAddress('255.255.255.255', 'ipv4')

const v6 = new BlockList()
v6.addAddress('::', 'ipv6')
v6.addAddress('::1', 'ipv6')
v6.addSubnet('fe80::', 10, 'ipv6')
v6.addSubnet('fc00::', 7, 'ipv6')
v6.addSubnet('ff00::', 8, 'ipv6')

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
])

export class SsrfError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SsrfError'
  }
}

export function isSsrfError(err) {
  return err instanceof SsrfError || (err instanceof Error && err.name === 'SsrfError')
}

export function isBlockedIp(address) {
  const family = isIP(address)
  if (family === 4) return v4.check(address, 'ipv4')
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
    if (mapped) return v4.check(mapped[1], 'ipv4')
    return v6.check(address, 'ipv6')
  }
  return true
}

/**
 * Clash/mihomo/sing-box TUN mode answers EVERY DNS query with a synthetic IP
 * from 198.18.0.0/15 (RFC 2544 benchmark range — used only by TUN proxies).
 * Blocking that range on hostname resolution would make every real page
 * lookup fail on TUN machines ("resolves to private IP 198.18.0.x") while the
 * connection would actually be routed by the TUN device to the real host.
 * The guard therefore treats an all-fake-ip hostname answer as "public via
 * TUN" — while literal private IPs, loopback, metadata and RFC1918 stay
 * blocked (and a literal 198.18/15 IP in the URL is also blocked).
 */
export function isTunFakeIp(ip) {
  if (isIP(ip) !== 4) return false
  const [a, b] = ip.split('.').map(Number)
  return a === 198 && (b === 18 || b === 19)
}

/** Opt out of the TUN carve-out (defense in depth) with DSH_SEARCH_ALLOW_TUN_FAKEIP=0. */
const ALLOW_TUN_FAKE_IP = process.env.DSH_SEARCH_ALLOW_TUN_FAKEIP !== '0'

function blockedHost(hostname) {
  const host = String(hostname ?? '').replace(/\.$/, '').toLowerCase()
  if (!host) return true
  if (BLOCKED_HOSTS.has(host)) return true
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  return false
}

export async function assertPublicHttpUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url).trim())
  } catch {
    throw new SsrfError('fetch_page: invalid url')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError('fetch_page: url must be http(s)')
  }
  if (parsed.username || parsed.password) {
    throw new SsrfError('fetch_page: url must not include credentials')
  }
  const host = parsed.hostname
  if (blockedHost(host)) {
    throw new SsrfError(`fetch_page: blocked host ${host}`)
  }
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`fetch_page: blocked address ${host}`)
    return parsed
  }
  let records
  try {
    records = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new SsrfError(`fetch_page: dns lookup failed for ${host}`)
  }
  if (!records || records.length === 0) {
    throw new SsrfError(`fetch_page: dns lookup failed for ${host}`)
  }
  // TUN fake-ip environment: every A answer lands in 198.18/15 and nothing
  // else is private — the connection goes through the TUN device, so allow.
  // Anything mixed (loopback / RFC1918 / metadata) still blocks below.
  const viaTun =
    ALLOW_TUN_FAKE_IP &&
    records.length > 0 &&
    records.some((rec) => isTunFakeIp(rec.address)) &&
    records.every((rec) => isBlockedIp(rec.address) === isTunFakeIp(rec.address))
  if (!viaTun) {
    for (const rec of records) {
      if (isBlockedIp(rec.address)) {
        throw new SsrfError(`fetch_page: blocked address ${rec.address} (${host})`)
      }
    }
  }
  return parsed
}

export function mergeSignals(userSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (userSignal && typeof userSignal.addEventListener === 'function') {
    try {
      return AbortSignal.any([userSignal, timeout])
    } catch {
      return timeout
    }
  }
  return timeout
}

export async function guardedFetch(url, { headers, timeoutMs = 20000, signal, maxHops = 5 } = {}) {
  let current = String(url).trim()
  const combined = mergeSignals(signal, timeoutMs)
  for (let hop = 0; hop < maxHops; hop++) {
    await assertPublicHttpUrl(current)
    const res = await fetch(current, { headers, signal: combined, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error(`redirect without location (${res.status})`)
      current = new URL(loc, current).href
      continue
    }
    return res
  }
  throw new Error('fetch_page: too many redirects')
}

export async function readLimited(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text()
    if (Buffer.byteLength(text) > maxBytes) throw new Error('fetch_page: response too large')
    return text
  }
  const reader = res.body.getReader()
  const chunks = []
  let n = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > maxBytes) {
      try { await reader.cancel() } catch { /* ignore */ }
      throw new Error('fetch_page: response too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}
