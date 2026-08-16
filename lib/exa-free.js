// Exa MCP Free — keyless web search via Exa's hosted MCP endpoint.
//
// This is the free layer's quality engine: no API key, neural/semantic
// retrieval against https://mcp.exa.ai (the `web_search_exa` tool). One search
// = one MCP session (initialize → initialized → tools/call), then parse the
// returned markdown into RawHit-shaped objects.
//
// Ported to dsh-search-boost from the pi-search-boost v0.0.2 engine adapter,
// with the MCP notification fix (202 + empty body must not be parsed as JSON):
// notification responses are detected by the absence of a JSON-RPC `id` and
// short-circuit with an empty payload. Rate-limiting (429) fails loudly so a
// caller can hint `/web_change api` — never a silent empty pool.

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
const EXA_MCP_PROTOCOL = '2025-03-26'
const EXA_MCP_TIMEOUT_MS = 25_000

let exaMcpNextId = 1

export async function exaMcpPost(body, sessionId, signal) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  const timeout = AbortSignal.timeout(EXA_MCP_TIMEOUT_MS)
  let resp
  try {
    resp = await fetch(EXA_MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (err) {
    // fetch can hang past the abort in some Node builds; surface whatever we got
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error('exa-free: MCP request timed out')
    }
    throw err
  }
  if (!resp.ok) {
    if (resp.status === 429) {
      throw new Error('exa-free: rate-limited (429) — run /web_change api or wait a moment and retry')
    }
    throw new Error(`exa-free: MCP http ${resp.status}`)
  }
  const newSession = resp.headers.get('mcp-session-id') ?? sessionId
  const ctype = resp.headers.get('content-type') ?? ''
  const raw = await resp.text()
  // Notifications (no `id`) are answered with 202 + empty body — nothing to parse.
  const isNotification = body.id === undefined
  if (!raw.trim()) {
    if (isNotification) return { json: {}, sessionId: newSession }
    throw new Error('exa-free: empty response body')
  }
  let payload = null
  // SSE transport: the last `data:` line carries the JSON-RPC message.
  if (ctype.includes('text/event-stream') || raw.includes('\ndata: ')) {
    const dataLines = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6))
    payload = dataLines[dataLines.length - 1] ?? null
  } else {
    payload = raw
  }
  if (!payload) {
    if (isNotification) return { json: {}, sessionId: newSession }
    throw new Error('exa-free: empty SSE response')
  }
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    if (isNotification) return { json: {}, sessionId: newSession }
    throw new Error('exa-free: response body not JSON')
  }
  if (parsed?.error) {
    throw new Error(`exa-free: MCP error ${parsed.error.code ?? '?'} ${parsed.error.message ?? ''}`.slice(0, 80))
  }
  return { json: parsed, sessionId: newSession }
}

/** Parse Exa MCP markdown into RawHit-shaped objects; fall back to links. */
export function parseExaFreeText(text) {
  const hits = []
  for (const block of String(text).split(/\n---+\n/)) {
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
    const url = block.match(/^URL:\s*(https?:\/\/\S+)$/m)?.[1]?.trim()
    if (!title || !url) continue
    const hi = block.search(/^Highlights:\s*/m)
    const snippet = hi >= 0
      ? block.slice(hi).replace(/^Highlights:\s*/m, '').replace(/\s+/g, ' ').trim().slice(0, 240)
      : ''
    hits.push({ title, url, snippet, published: null })
  }
  if (hits.length > 0) return hits
  // fallback: markdown links [Title](URL)
  for (const m of String(text).matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    hits.push({ title: m[1].trim().slice(0, 120), url: m[2].trim(), snippet: '', published: null })
  }
  return hits
}

/** Run one web_search_exa call; returns RawHit-shaped objects. */
export async function searchExaFree(query, count, signal) {
  const init = await exaMcpPost(
    {
      jsonrpc: '2.0',
      id: exaMcpNextId++,
      method: 'initialize',
      params: {
        protocolVersion: EXA_MCP_PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'dsh-search-boost', version: '0.0.3' },
      },
    },
    undefined,
    signal,
  )
  if (!init.sessionId) throw new Error('exa-free: no MCP session id (initialize failed)')
  // initialized notification (fire-and-forget; non-fatal)
  try {
    await exaMcpPost({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, init.sessionId, signal)
  } catch { /* notification failure is not fatal */ }
  const call = await exaMcpPost(
    {
      jsonrpc: '2.0',
      id: exaMcpNextId++,
      method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query, numResults: Math.min(count, 10) } },
    },
    init.sessionId,
    signal,
  )
  const text = (call.json?.result?.content ?? [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
  if (!text.trim()) return []
  return parseExaFreeText(text).slice(0, count)
}

/** Always available: keyless, needs no config. */
export const exaFreeAvailable = () => true
