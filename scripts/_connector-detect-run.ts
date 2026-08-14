import { collectHostEnvironment } from '../packages/honeycomb/src/connectors/detect/host-env.ts'
import { OpenCodeAdapter } from '../packages/honeycomb/src/connectors/adapters/opencode.ts'
import { CodexAdapter } from '../packages/honeycomb/src/connectors/adapters/codex.ts'
import { KimiCodeAdapter } from '../packages/honeycomb/src/connectors/adapters/kimi-code.ts'
import { HermesAdapter } from '../packages/honeycomb/src/connectors/adapters/hermes.ts'
import { ClaudeCodeAdapter } from '../packages/honeycomb/src/connectors/adapters/claude-code.ts'

async function main() {
  const host = collectHostEnvironment()
  console.log('HOME:', host.home)
  console.log('=== LIVE DETECTION (real host) ===', new Date().toISOString())
  const adapters = [
    new OpenCodeAdapter(),
    new CodexAdapter(),
    new KimiCodeAdapter(),
    new HermesAdapter(),
    new ClaudeCodeAdapter(),
  ]
  for (const a of adapters) {
    const d = await a.detect(host)
    if (d) {
      console.log(
        `[${a.id}] HIT version=${d.version ?? 'n/a'} confidence=${d.confidence} bin=${d.binPath ?? '-'} config=${d.configDir ?? '-'}`,
      )
    } else {
      console.log(`[${a.id}] miss`)
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
