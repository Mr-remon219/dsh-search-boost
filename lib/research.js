// Deep research (step mode) and parallel multi-agent research for the bundle.
// Ported from the session-level plugin (plugin-host.js): the same coverage /
// corroboration / gap analysis math, now running on the bundle's engine chain.

import { fusedSearch, queryTerms, TIER_ENGINES } from './fusion.js'

const AUTHORITATIVE_TLDS = ['.gov', '.edu', '.mil']

function distinctiveTerms(text, n = 3) {
  return queryTerms(text).slice(0, n)
}

/**
 * ONE round of deep research: complex fused search + coverage analysis +
 * cross-domain corroboration + gaps + suggested next queries. The model drives
 * further rounds via suggested_queries until gaps is empty.
 */
export async function researchRound({ query, queries, maxSources = 8, recency, engines, runOne, signal }) {
  const fused = await fusedSearch({
    query,
    queries,
    maxResults: maxSources,
    tier: 'complex',
    engines: engines ?? TIER_ENGINES.complex,
    recency,
    runOne,
    signal,
  })

  const terms = queryTerms(query)
  const sources = fused.results.map((r) => {
    const hay = `${r.title} ${r.snippet}`.toLowerCase()
    let covered = 0
    const found = []
    for (const t of terms) {
      if (t.length >= 2 && hay.includes(t)) {
        covered++
        found.push(t)
      }
    }
    return { ...r, covered, total: terms.length, found }
  })

  // Cross-domain corroboration: two sources sharing a distinctive term.
  const byTerm = new Map()
  for (const s of sources) {
    for (const t of distinctiveTerms(s.snippet, 4)) {
      if (t.length < 3) continue
      if (!byTerm.has(t)) byTerm.set(t, new Set())
      byTerm.get(t).add(s.domain)
    }
  }
  for (const s of sources) {
    s.corroborated = distinctiveTerms(s.snippet, 4).some((t) => (byTerm.get(t)?.size ?? 0) >= 2)
  }

  const gaps = terms.filter((t) => sources.filter((s) => s.found.includes(t)).length < 2)
  const suggested = []
  for (const g of gaps) {
    if (g.length >= 2 && !query.toLowerCase().includes(g)) suggested.push(`${query} ${g}`)
  }
  for (const s of sources) {
    const d = s.domain
    if (AUTHORITATIVE_TLDS.some((t) => d.endsWith(t)) || d === 'wikipedia.org' || d === 'github.com') {
      suggested.push(`site:${d} ${query}`)
    }
  }

  return {
    round: 1,
    query,
    queriesUsed: fused.queriesUsed ?? [query],
    tookMs: fused.tookMs,
    sources: sources.map((s) => {
      const item = {
        title: s.title, url: s.url, domain: s.domain,
        snippet: (s.snippet ?? '').slice(0, 220),
        covered: s.covered, total: s.total,
        corroborated: s.corroborated,
        engines: s.engines,
      }
      if (s.published) item.published = s.published
      return item
    }),
    gaps: [...new Set(gaps)],
    suggested_queries: [...new Set(suggested)].slice(0, 6),
    note: gaps.length === 0
      ? 'coverage complete: all query terms covered by >=2 sources'
      : `coverage gaps: ${gaps.length} term(s) not yet covered by 2+ sources`,
  }
}

// ---------- research_parallel ----------

function splitQueries(query) {
  const q = String(query ?? '').trim()
  const base = [q]
  if (!/对比|comparison|vs\.?|compare/i.test(q)) base.push(`${q} 对比 优缺点`)
  base.push(`${q} 官方文档`)
  return [...new Set(base)].slice(0, 3)
}

function extractUrls(text) {
  const urls = []
  for (const m of String(text ?? '').match(/https?:\/\/[^\s)\]]+/g) || []) {
    const u = m.replace(/[.,;:]+$/, '')
    if (urls.indexOf(u) === -1) urls.push(u)
  }
  return urls
}

function subagentPrompt(task, goal, maxSources) {
  return `你是一个网络研究子代理。你的子任务：
${task}

${goal ? `研究背景（主问题）：${goal}\n` : ''}
方法（必须使用，按序）：
1. 用 fused_search 搜索（query=${task}，max_results=${maxSources ?? 6}；可加 queries 变体覆盖同义表达）
2. 对关键来源用 fetch_page 抓正文验证（focus 传子任务关键词）
3. 交叉验证：优先官方源与一手来源；注意时效性（必要时 recency 参数）；区分事实与推断
禁止：使用 research_parallel 工具（防止递归）、编造来源、把猜测当事实。

输出格式（严格遵守，纯文本）：
## 结论
（2-5 句，带具体事实与日期）
## 来源
（每行一条：URL — 一句话说明其支撑点）
## 备注
（不确定性、缺口、冲突证据）`
}

/**
 * Parallel multi-agent research: spawn one subagent per sub-query (each with
 * its own context window, inheriting fused_search / fetch_page), run them
 * under a time budget, and merge findings and sources.
 */
export async function parallelResearch({ query, goal, subQueries, maxSeconds = 120, maxSources = 6, subagents, agent, signal }) {
  const started = Date.now()
  if (!subagents) throw new Error('subagents service unavailable')
  const names = subagents.list()
  const provider = names.includes('spawn') ? 'spawn' : (names[0] ?? '')
  if (!provider) throw new Error('no subagent provider registered')
  const tasks = subQueries && subQueries.length > 0 ? subQueries.slice(0, 4) : splitQueries(query)
  const budgetMs = Math.min(maxSeconds * 1000, 300000)
  const safeSignal = signal && typeof signal.addEventListener === 'function' ? signal : undefined

  const runs = []
  for (const task of tasks) {
    try {
      const run = await subagents.start(provider, {
        label: `research:${task.slice(0, 40)}`,
        prompt: [{ type: 'text', text: subagentPrompt(task, goal, maxSources) }],
        parent: agent,
        signal: safeSignal,
        maxDepth: 1,
      })
      runs.push({ task, run })
    } catch (err) {
      runs.push({ task, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const deadline = started + budgetMs
  const pending = runs.filter((r) => r.run)
  const timerPromise = ctxTimer(deadline)
  await Promise.race([
    Promise.allSettled(pending.map((r) => r.run.result)),
    timerPromise,
  ])

  const subTasks = []
  for (const r of runs) {
    if (r.error) {
      subTasks.push({ title: r.task, status: 'error', output: r.error, sources: [] })
      continue
    }
    let output = ''
    let stopReason = 'completed'
    try {
      const result = await Promise.race([
        r.run.result,
        ctxTimer(deadline).then(() => 'timeout'),
      ])
      if (result === 'timeout') {
        stopReason = 'timeout'
        void r.run.dispose()
      } else {
        stopReason = result.stopReason
        output = (result.output ?? [])
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
      }
    } catch (err) {
      stopReason = 'error'
      output = err instanceof Error ? err.message : String(err)
      void r.run.dispose()
    }
    subTasks.push({
      title: r.task,
      status: stopReason === 'completed' ? 'completed' : stopReason,
      output: output.slice(0, 6000),
      sources: extractUrls(output).slice(0, 12),
    })
  }

  const mergedSources = []
  for (const st of subTasks) {
    for (const u of st.sources) {
      if (mergedSources.indexOf(u) === -1) mergedSources.push(u)
    }
  }
  return {
    query,
    sub_tasks: subTasks,
    merged_sources: mergedSources,
    took_ms: Date.now() - started,
    note: mergedSources.length === 0
      ? 'no URLs extracted from subagent outputs (check per-task status)'
      : `${subTasks.length} tasks, ${mergedSources.length} unique sources`,
  }
}

/** Timer helper — set once by the bundle apply() with the real ctx.timeout. */
let timerFn = null
export function setTimer(fn) {
  timerFn = typeof fn === 'function' ? fn : null
}
function fallbackTimer(waitMs) {
  return new Promise((resolve) => setTimeout(resolve, waitMs))
}
function ctxTimer(deadlineMs) {
  const wait = Math.max(0, deadlineMs - Date.now())
  if (timerFn) {
    try {
      const p = timerFn(wait)
      if (p && typeof p.then === 'function') return p
    } catch { /* fall through to setTimeout */ }
  }
  return fallbackTimer(wait)
}
