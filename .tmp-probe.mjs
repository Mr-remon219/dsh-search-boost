// Empirical probe v2: construct the SystemPrompt service directly on a plain
// (global, non-agent) Cordis context — the bundle plugin's host context.
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'

const ctx = new Context()
const sp = new SystemPrompt(ctx, { includeHarnessIdentity: false, persona: '' })
console.log('service constructed:', !!sp)

try {
  const d = sp.section({ name: 'probe:section', order: 999, text: 'static probe' })
  console.log('section(): OK, disposer is function:', typeof d === 'function')
} catch (e) {
  console.log('section(): FAIL —', e.message)
}

try {
  const d = sp.variable('probe_var', () => 'dynamic probe')
  console.log('variable(): OK, disposer is function:', typeof d === 'function')
} catch (e) {
  console.log('variable(): FAIL —', e.message)
}

try {
  const d = sp.section({ name: 'probe:dynamic', order: 998, text: () => 'live value ' + Date.now() })
  console.log('dynamic section text(): OK, disposer is function:', typeof d === 'function')
} catch (e) {
  console.log('dynamic section text(): FAIL —', e.message)
}

// assembly: does the dynamic section render?
try {
  const assembly = await sp.assemble({})
  const texts = assembly.sections.map((s) => s.text)
  console.log('assembled sections:', texts)
} catch (e) {
  console.log('assemble(): FAIL —', e.message)
}
