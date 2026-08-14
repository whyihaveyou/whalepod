import { spawn } from 'node:child_process'

// Isolated single-agent probe: prints every event serially, no interleaving.
async function probe(label: string, bin: string, makeArgs: (prompt: string) => string[], prompt: string, opts: { stdinFrom?: 'argv' } = {}): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const hr = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
    const child = spawn(bin, makeArgs(prompt), {
      cwd: '/tmp',
      env: process.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    const timer = setTimeout(() => {
      console.log(`[${label}] TIMEOUT-30s bytes=${out.length}`)
      try { child.kill('SIGKILL') } catch {}
      setTimeout(resolve, 300)
    }, 30_000)
    child.stdout.on('data', (c: Buffer) => { const s = c.toString(); out += s; console.log(`[${label} ${hr()}] OUT> ${s.trim().slice(0, 150)}`) })
    child.stderr.on('data', (c: Buffer) => { const s = c.toString(); out += s; console.log(`[${label} ${hr()}] ERR> ${s.trim().slice(0, 150)}`) })
    child.on('exit', (code) => { clearTimeout(timer); console.log(`[${label} ${hr()}] EXIT code=${code}`); resolve() })
    child.on('error', (e) => { clearTimeout(timer); console.log(`[${label}] spawn-error ${e.message}`); resolve() })
    // close stdin so one-shot argv agents don't block on stdin EOF
    child.stdin.end()
  })
}

void (async () => {
  console.log('=== KIMI isolated (via adapter-style: des for-argv?) ===')
  await probe('kimi', '/Users/qzp/.kimi-code/bin/kimi', (p) => ['-p', '--output-format', 'stream-json', p], 'Reply with exactly: OK')

  console.log('\n=== CODEX stdin-vs-argv probe ===')
  // Test A: prompt as argv arg (current adapter approach)
  await probe('codex-argv', '/Users/qzp/.local/opt/node/bin/codex', (p) => ['exec', '--json', '--skip-git-repo-check', p], 'Reply with exactly: OK')
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
