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

function blockedHost(hostname) {
  const host = String(hostname ?? '').replace(/\.$/, '').toLowerCase()
  if (!host) return true
  if (BLOCKED_HOSTS.has(host)) return true
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true
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
  for (const rec of records) {
    if (isBlockedIp(rec.address)) {
      throw new SsrfError(`fetch_page: blocked address ${rec.address} (${host})`)
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
