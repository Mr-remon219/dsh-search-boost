#!/usr/bin/env node
// Reproduce the P0/P1 defects this audit claims. Import production modules only.
// Exit 0 after printing a verdict table (defects are expected on current main).

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizeUrl, fusedSearch, estimateComplexity, hostOf } from '../lib/fusion.js'
import { fetchPage, makePageCache } from '../lib/fetch.js'
import { researchRound, parallelResearch } from '../lib/research.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rows = []
const record = (id, title, reproduced, detail) => {
  rows.push({ id, title, reproduced, detail })
  const mark = reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'
  console.log(`\n[${mark}] ${id} ${title}\n  ${detail.replace(/\n/g, '\n  ')}`)
}

function sourceOf(rel) {
  return readFileSync(join(root, rel), 'utf8')
}

// ---------- P0-1 SSRF ----------
{
  const fetchSrc = sourceOf('lib/fetch.js')
  const hasGuard = /169\.254|127\.0\.0\.1|private|ssrf|isPrivate|blockedHost/i.test(fetchSrc)
  const origFetch = globalThis.fetch
  let leaked = ''
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('INTERNAL ADMIN TOKEN=s3cr3t-abcdef')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://r.jina.ai/')) {
      return new Response('jina blocked', { status: 403 })
    }
    return origFetch(url, opts)
  }
  try {
    const result = await fetchPage(`http://127.0.0.1:${port}/admin`, null, makePageCache())
    leaked = String(result.content ?? '')
  } catch (err) {
    leaked = `threw: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    globalThis.fetch = origFetch
    await new Promise((resolve) => server.close(resolve))
  }
  const gotSecret = leaked.includes('INTERNAL ADMIN TOKEN=s3cr3t-abcdef')
  record(
    'P0-1',
    'fetch_page 无 SSRF 防护，可读取回环地址',
    gotSecret && !hasGuard,
    `code-has-ssrf-guard=${hasGuard}; local-fallback-returned=${JSON.stringify(leaked).slice(0, 160)}`,
  )
}

// ---------- P0-2 research_parallel budget ----------
{
  const never = new Promise(() => {})
  const subagents = {
    list: () => ['spawn'],
    start: async () => ({ result: never, dispose: async () => {} }),
  }
  const started = Date.now()
  const pending = parallelResearch({
    query: 'budget-probe',
    maxSeconds: 1,
    subQueries: ['one-angle'],
    subagents,
    agent: {},
  })
  const outcome = await Promise.race([
    pending.then((value) => ({ kind: 'returned', value, ms: Date.now() - started })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'still-hanging', ms: Date.now() - started }), 2500)),
  ])
  record(
    'P0-2',
    'research_parallel 在 timer 未接通时 max_seconds 不生效',
    outcome.kind === 'still-hanging' && outcome.ms >= 2000,
    `maxSeconds=1, observed=${outcome.kind} after ${outcome.ms}ms (timerFn left unset, matching apply() catch path)`,
  )
}

// ---------- P0-3 normalizeUrl lowercases path/query and is returned ----------
{
  const raw = 'https://raw.githubusercontent.com/nodejs/node/main/README.md?Foo=Bar#Section'
  const norm = normalizeUrl(raw)
  const pathFolded = norm.includes('/readme.md')
  const queryFolded = norm.includes('foo=bar')
  const invoked = []
  const fused = await fusedSearch({
    query: 'readme',
    engines: ['bing'],
    tier: 'simple',
    maxResults: 3,
    runOne: async (engine) => {
      invoked.push(engine)
      return [{ title: 'README', url: raw, snippet: 'readme file' }]
    },
  })
  const returned = fused.results[0]?.url ?? ''
  let live = 'skipped'
  try {
    const a = await fetch(raw, { method: 'HEAD', signal: AbortSignal.timeout(8000), redirect: 'follow' })
    const b = await fetch(norm, { method: 'HEAD', signal: AbortSignal.timeout(8000), redirect: 'follow' })
    live = `HEAD raw=${a.status} normalized=${b.status}`
  } catch (err) {
    live = `live-check-failed: ${err instanceof Error ? err.message : String(err)}`
  }
  record(
    'P0-3',
    'normalizeUrl 把 path/query 转小写，且该值直接返回给模型',
    pathFolded && queryFolded && returned === norm,
    `raw=${raw}\nnormalized=${norm}\nfused.results[0].url=${returned}\n${live}`,
  )
}

// ---------- P1-4 fetch_page cache key includes focus ----------
{
  const fetchSrc = sourceOf('lib/fetch.js')
  const keyIncludesFocus = /cacheKey = `page:\$\{url\}#\$\{focus/.test(fetchSrc)
  const commentSaysRaw = /缓存存原始|stores the RAW|focus filtering happens at read time/i.test(fetchSrc)
  record(
    'P1-4',
    'fetch_page 缓存键含 focus，换 focus 会重抓（与注释设计相反）',
    keyIncludesFocus && commentSaysRaw,
    `key-includes-focus=${keyIncludesFocus}; comment-claims-raw-cache=${commentSaysRaw}`,
  )
}

// ---------- P1-5 deep_research complexity ignored + unavailable engines ----------
{
  const invoked = []
  const query = 'tokio release notes' // 3 english terms → medium if auto; no research-signal
  const autoTier = estimateComplexity(query)
  await researchRound({
    query,
    maxSources: 4,
    runOne: async (engine, q) => {
      invoked.push(engine)
      return [{ title: `${engine} hit`, url: `https://example.com/${engine}`, snippet: `${q} tokio release` }]
    },
  })
  const researchSrc = sourceOf('lib/research.js')
  const passesComplexity = /complexity:\s*'complex'/.test(researchSrc)
  const fusionTakesTier = /tier = 'auto'/.test(sourceOf('lib/fusion.js'))
  const triedKeyed = invoked.includes('tavily') || invoked.includes('brave') || invoked.includes('exa')
  record(
    'P1-5',
    'deep_research 传 complexity 但 fusedSearch 只认 tier；会打不可用引擎',
    passesComplexity && fusionTakesTier && autoTier !== 'complex' && invoked.length > 0,
    `estimateComplexity("${query}")=${autoTier}; engines-invoked=${invoked.join(',') || '(none)'}; tried-keyed=${triedKeyed}`,
  )
}

// ---------- P1-6 fused_search cache key omits tier ----------
{
  const indexSrc = sourceOf('index.js')
  const keyLine = indexSrc.match(/const key = JSON\.stringify\(\{[^}]+\}\)/)
  const omitsTier = keyLine ? !/\btier\b|\bcomplexity\b|\bt:/.test(keyLine[0]) : false
  record(
    'P1-6',
    'fused_search 缓存键不含档位，simple 命中会污染 complex',
    Boolean(keyLine) && omitsTier,
    keyLine ? keyLine[0] : 'cache key construction not found',
  )
}

// ---------- P1-7 www vs apex not deduped ----------
{
  const fused = await fusedSearch({
    query: 'hello world test page',
    engines: ['bing', 'ddg'],
    tier: 'simple',
    maxResults: 6,
    runOne: async (engine) => {
      if (engine === 'bing') {
        return [{ title: 'Same page', url: 'https://www.example.com/page', snippet: 'hello world test page' }]
      }
      return [{ title: 'Same page', url: 'https://example.com/page', snippet: 'hello world test page' }]
    },
  })
  const urls = fused.results.map((r) => r.url)
  const domains = fused.results.map((r) => r.domain)
  record(
    'P1-7',
    'www 与裸域不去重，跨引擎共现被拆成两条',
    urls.length >= 2 && new Set(domains).size === 1,
    `returned urls=${JSON.stringify(urls)}; domains=${JSON.stringify(domains)}; hostOf(www)=${hostOf('https://www.example.com/page')}`,
  )
}

// ---------- P1-8 web_search hardcodes simple and skips cache ----------
{
  const indexSrc = sourceOf('index.js')
  const start = indexSrc.indexOf('function registerSearchProvider')
  const end = indexSrc.indexOf('// ---------- fused_search tool')
  const provider = start >= 0 && end > start ? indexSrc.slice(start, end) : ''
  const providerHardSimple = /tier: 'simple'/.test(provider)
  const providerUsesCache = /SEARCH_CACHE/.test(provider)
  record(
    'P1-8',
    '内置 web_search 钉死 simple，且不走 SEARCH_CACHE',
    providerHardSimple && !providerUsesCache,
    `hardcoded-simple=${providerHardSimple}; provider-touches-SEARCH_CACHE=${providerUsesCache}`,
  )
}

// ---------- P1-9 signal ignored ----------
{
  const indexSrc = sourceOf('index.js')
  const provider = indexSrc.match(/async search\(request, signal\) \{[\s\S]*?\n      return \{/)
  const usesSignal = provider ? /\bsignal\b/.test(provider[0].replace('async search(request, signal)', '')) : false
  record(
    'P1-9',
    'WebSearchProvider 收下 signal 但从不转发给引擎',
    Boolean(provider) && !usesSignal,
    `provider-signature-found=${Boolean(provider)}; signal-used-in-body=${usesSignal}`,
  )
}

// ---------- P1-10 no fetch provider ----------
{
  const indexSrc = sourceOf('index.js')
  record(
    'P1-10',
    '未注册 WebFetchProvider，内置 web_fetch 未被升级',
    !/registerFetchProvider/.test(indexSrc),
    `registerFetchProvider present=${/registerFetchProvider/.test(indexSrc)}`,
  )
}

// ---------- P1-11 search_stats missing ddg ----------
{
  const indexSrc = sourceOf('index.js')
  const start = indexSrc.indexOf('function registerStatsTool')
  const statsFn = start >= 0 ? indexSrc.slice(start) : ''
  const statsBlock = statsFn.match(/engines:\s*\{\s*antigravity:[\s\S]*?exa:\s*Boolean\(keys\.exa\),/)
  const hasDdg = statsBlock ? /\bddg\b/.test(statsBlock[0]) : true
  record(
    'P1-11',
    'search_stats 引擎清单漏掉默认免费腿 ddg',
    Boolean(statsBlock) && !hasDdg,
    statsBlock ? statsBlock[0].replace(/\s+/g, ' ') : 'engines block not found in registerStatsTool',
  )
}

// ---------- P1-12 fusion keeps shorter content (dead after strip, still wrong) ----------
{
  const fusionSrc = sourceOf('lib/fusion.js')
  const hostSrc = sourceOf('plugin-host.js')
  const bundleKeepsShorter = /existing\.content\.length > hit\.content\.length/.test(fusionSrc)
  const hostKeepsLonger = /hit\.content\.length > existing\.content\.length/.test(hostSrc)
  record(
    'P1-12',
    'bundle 融合在冲突时保留更短正文（与 plugin-host 相反）',
    bundleKeepsShorter && hostKeepsLonger,
    `bundle-keeps-shorter=${bundleKeepsShorter}; plugin-host-keeps-longer=${hostKeepsLonger}`,
  )
}

// ---------- P1-13 simple tier waits on 45s agy ----------
{
  const fusionSrc = sourceOf('lib/fusion.js')
  const engineSrc = sourceOf('lib/engines.js')
  const simpleHasAgy = /simple:\s*\[[^\]]*antigravity/.test(fusionSrc)
  const agyTimeout = /AGY_TIMEOUT_MS = 45_000/.test(engineSrc)
  const allWait = /await Promise\.all\(tasks\.map/.test(fusionSrc)
  record(
    'P1-13',
    'simple 档默认带上 agy，Promise.all 会被 45s CLI 拖死',
    simpleHasAgy && agyTimeout && allWait,
    `simple-includes-agy=${simpleHasAgy}; agy-timeout-45s=${agyTimeout}; fanout-is-Promise.all=${allWait}`,
  )
}

// ---------- P2-14 plugin-host debug_shell ----------
{
  const hostSrc = sourceOf('plugin-host.js')
  record(
    'P2-14',
    '会话插件暴露 debug_shell，可跑任意命令',
    /name: 'debug_shell'/.test(hostSrc) && /command: args\.command/.test(hostSrc),
    'plugin-host.js registers debug_shell and forwards args.command to shell.run',
  )
}

console.log('\n========== AUDIT VERDICT ==========')
console.log('id\treproduced\ttitle')
for (const row of rows) {
  console.log(`${row.id}\t${row.reproduced ? 'YES' : 'NO'}\t${row.title}`)
}
const failed = rows.filter((r) => !r.reproduced)
console.log(`\nreproduced ${rows.filter((r) => r.reproduced).length}/${rows.length}`)
if (failed.length > 0) {
  console.log('NOT reproduced:', failed.map((r) => r.id).join(', '))
  process.exitCode = 2
}
