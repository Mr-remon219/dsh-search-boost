// Search layer selection for dsh-search-boost.
//
// Two layers, switched at runtime with `/web_change`:
//   - "free": keyless engines only (Antigravity CLI + Bing HTML + DDG HTML +
//     Exa MCP) — no API keys, no credit burn; best for repeated research /
//     privacy-conscious runs.
//   - "api" : the full engine pool — the free legs PLUS the keyed Tavily /
//     Brave / Exa APIs when keys are present. Default (preserves pre-layer
//     behavior).
//
// The choice persists to disk so it survives reloads. Zero external
// dependencies: lib/ imports only node built-ins + sibling lib modules.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const LAYER_STATE_FILE = path.join(os.homedir(), '.dsh-search-boost-layer.json')

export const LAYER_LABELS = {
  free: 'free — keyless engines only (agy + bing + ddg + exa-free)',
  api: 'api — full pool (keyless legs plus keyed tavily/brave/exa when present)',
}

let cached

/** Resolve the active layer: "api" default, overrides via state file. */
export function getLayer() {
  if (cached) return cached
  try {
    const raw = JSON.parse(fs.readFileSync(LAYER_STATE_FILE, 'utf8'))
    if (raw?.layer === 'free' || raw?.layer === 'api') cached = raw.layer
  } catch { /* no state file yet — default api */ }
  return cached ?? 'api'
}

/** Serialize writes so a busy session cannot corrupt/race the state file. */
let writeQueue = Promise.resolve()

/** Set the active layer and persist it atomically. */
export function setLayer(layer) {
  if (layer !== 'free' && layer !== 'api') throw new Error('layer must be "free" or "api"')
  cached = layer
  writeQueue = writeQueue.then(() => {
    try {
      const dir = path.dirname(LAYER_STATE_FILE)
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${LAYER_STATE_FILE}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ layer }, null, 2), 'utf8')
      fs.renameSync(tmp, LAYER_STATE_FILE)
    } catch (err) {
      // never break a search over state persistence
      console.error('[dsh-search-boost] failed to persist layer state:', err instanceof Error ? err.message : err)
    }
  })
  return layer
}
