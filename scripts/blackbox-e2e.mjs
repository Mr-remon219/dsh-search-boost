#!/usr/bin/env node
/**
 * User-perspective black-box E2E for dsh-search-boost.
 *
 * Simulates the DSH bundle host contract (mock ctx + apply()) and exercises
 * every user-facing surface against live free engines (bing / ddg / exa-free).
 * No DSH CLI or API keys required.
 *
 * Usage: node scripts/blackbox-e2e.mjs
 *        npm run test:e2e
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { getLayer, setLayer } from '../lib/layer.js'
import { isSsrfError } from '../lib/ssrf.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT_DIR = '/opt/cursor/artifacts'
const report = { startedAt: new Date().toISOString(), steps: [], summary: {} }

function step(name, fn) {
  const started = Date.now()
  return Promise.resolve(fn())
    .then((detail) => {
      const entry = { name, ok: true, ms: Date.now() - started, ...detail }
      report.steps.push(entry)
      console.log(`✓ ${name} (${entry.ms}ms)`)
      return entry
    })
    .catch((err) => {
      const entry = { name, ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) }
      report.steps.push(entry)
      console.error(`✗ ${name}: ${entry.error}`)
      return entry
    })
}

function makeMockCtx() {
  const tools = new Map()
  const commands = new Map()
  const sections = []
  const providers = { search: null, fetch: null }
  const commandsService = { register: (c) => { commands.set(c.name, c); return c } }
  const timerService = { timeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
  const ctx = {
    effect: () => {},
    get: (name) => {
      if (name === 'commands') return commandsService
      if (name === 'subagents') return null
      if (name === 'timer') return timerService
      return undefined
    },
    web: {
      registerSearchProvider: (p) => { providers.search = p; return () => {} },
      registerFetchProvider: (p) => { providers.fetch = p; return () => {} },
    },
    tools: { register: (t) => { tools.set(t.name, t); return () => {} } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    timeout: (ms) => timerService.timeout(ms),
  }
  return { ctx, tools, commands, sections, providers }
}

async function main() {
  console.log('== dsh-search-boost black-box E2E (user journey) ==\n')

  const mock = makeMockCtx()
  apply(mock.ctx, {})

  await step('plugin surfaces registered', () => {
    const toolNames = ['fused_search', 'fetch_page', 'x_search', 'deep_research', 'research_parallel', 'search_stats']
    for (const n of toolNames) {
      if (!mock.tools.has(n)) throw new Error(`missing tool: ${n}`)
    }
    for (const n of ['web_change', 'x-login', 'x-logout']) {
      if (!mock.commands.has(n)) throw new Error(`missing command: ${n}`)
    }
    if (!mock.providers.search) throw new Error('search provider not registered')
    if (!mock.providers.fetch) throw new Error('fetch provider not registered')
    if (!mock.sections.some((s) => s.name === 'search:policy')) throw new Error('policy section missing')
    if (!mock.sections.some((s) => s.name === 'search:status')) throw new Error('status section missing')
    return { tools: toolNames.length, commands: 3 }
  })

  await step('/web_change show', () => {
    const out = mock.commands.get('web_change').handler({ rawInput: 'show' })
    if (out.kind !== 'success') throw new Error(out.text)
    if (!/current layer:/.test(out.text)) throw new Error('unexpected show output')
    return { preview: out.text.split('\n')[0] }
  })

  await step('/web_change free → api round-trip', () => {
    const free = mock.commands.get('web_change').handler({ rawInput: 'free' })
    if (free.kind !== 'success' || getLayer() !== 'free') throw new Error('free layer not set')
    const api = mock.commands.get('web_change').handler({ rawInput: 'api' })
    if (api.kind !== 'success' || getLayer() !== 'api') throw new Error('api layer not set')
    return { layer: getLayer() }
  })

  await step('/x-login status (no credentials)', () => {
    const out = mock.commands.get('x-login').handler({ rawInput: 'status' })
    if (out.kind !== 'success') throw new Error(out.text)
    return { preview: out.text.slice(0, 80) }
  })

  await step('built-in web_search provider', async () => {
    const result = await mock.providers.search.search({ query: 'tokio rust async runtime', maxResults: 4 })
    if (!result.sources?.length) throw new Error('no sources returned')
    if (!result.content) throw new Error('empty content summary')
    return { sources: result.sources.length, preview: result.content.slice(0, 80) }
  })

  const fused = mock.tools.get('fused_search')
  await step('fused_search (live engines)', async () => {
    const result = await fused.execute({ query: 'nodejs latest stable version', max_results: 5 }, { signal: undefined })
    if (!result.results?.length) throw new Error('no fused results')
    return { tier: result.tier, hits: result.results.length, tookMs: result.tookMs, engines: result.results[0]?.engines }
  })

  await step('fused_search cache hit', async () => {
    const result = await fused.execute({ query: 'nodejs latest stable version', max_results: 5 }, { signal: undefined })
    if (!result.cacheHit) throw new Error('expected cache hit on repeat query')
    return { cacheHit: true, tookMs: result.tookMs }
  })

  const fetchTool = mock.tools.get('fetch_page')
  await step('fetch_page (public URL)', async () => {
    const result = await fetchTool.execute({ url: 'https://nodejs.org/en/about' }, { signal: undefined })
    if (!result.content || result.content.length < 100) throw new Error('content too short')
    return { via: result.via, words: result.word_count, tookMs: result.tookMs }
  })

  await step('web_fetch provider (built-in seam)', async () => {
    const result = await mock.providers.fetch.fetch({ url: 'https://nodejs.org/en/about' })
    if (result.body?.kind !== 'text' || !result.body.content) throw new Error('empty fetch body')
    return { truncated: result.truncated, chars: result.body.content.length }
  })

  await step('web_fetch blocks loopback (SSRF)', async () => {
    try {
      await mock.providers.fetch.fetch({ url: 'http://127.0.0.1:1/' })
      throw new Error('expected SSRF rejection')
    } catch (err) {
      if (!isSsrfError(err) && !String(err.message).includes('blocked')) {
        throw err
      }
    }
    return { blocked: true }
  })

  const xTool = mock.tools.get('x_search')
  await step('x_search user profile (guest GraphQL, no credentials)', async () => {
    const result = await xTool.execute({ type: 'user', username: 'NASA', max_results: 2 }, { signal: undefined })
    if (result.via === 'error') throw new Error(result.error ?? 'x_search error')
    if (!result.results) throw new Error('no user results')
    return { via: result.via, results: result.results, tookMs: result.tookMs }
  })

  const deep = mock.tools.get('deep_research')
  await step('deep_research one round', async () => {
    const result = await deep.execute({ query: 'tokio async runtime latest version', max_sources: 4 }, { signal: undefined })
    if (!result.sources?.length) throw new Error('no research sources')
    return { sources: result.sources.length, gaps: result.gaps.length, tookMs: result.tookMs }
  })

  const statsTool = mock.tools.get('search_stats')
  await step('search_stats audit', async () => {
    const result = await statsTool.execute()
    if (!result.engines?.bing) throw new Error('bing should be available')
    if (!result.caches) throw new Error('missing cache stats')
    return { cacheHits: result.cacheHits, caches: result.caches, layer: result.layer }
  })

  await step('research_parallel without subagents (expected error)', async () => {
    const parallel = mock.tools.get('research_parallel')
    try {
      await parallel.execute({ query: 'rust vs go performance' }, { agent: {}, signal: undefined })
      throw new Error('expected subagents unavailable error')
    } catch (err) {
      if (!String(err.message).includes('subagents')) throw err
    }
    return { expectedError: true }
  })

  const failed = report.steps.filter((s) => !s.ok)
  report.summary = {
    total: report.steps.length,
    passed: report.steps.length - failed.length,
    failed: failed.length,
    ok: failed.length === 0,
  }
  report.finishedAt = new Date().toISOString()

  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true })
    const reportPath = join(ARTIFACT_DIR, 'blackbox_e2e_report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(`\nReport: ${reportPath}`)
  } catch {
    writeFileSync(join(root, 'blackbox-e2e-report.json'), JSON.stringify(report, null, 2))
  }

  console.log(`\n== ${report.summary.passed}/${report.summary.total} passed ==`)
  if (!report.summary.ok) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('blackbox E2E fatal:', err)
  process.exit(1)
})
