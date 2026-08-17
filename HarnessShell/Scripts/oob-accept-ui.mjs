#!/usr/bin/env node
// =============================================================================
// oob-accept-ui.mjs — OOB-4 开箱验收的 Web 面板探针（断言 e/f 的引擎）
//
// 职责：
//   1. 以 playwright 打开被验实例的 web UI（随机端口 base-url）
//   2. 依次探测候选面板 bundle URL（GET → 200 即中）——断言 e 的前半
//   3. 等待面板内出现「真数据」证据文本（默认：验收脚本经 REST 写入的 hive 名）
//      ——断言 e 的后半（面板挂载真数据）
//   4. 全程 tap console error / pageerror ——断言 f（零 JS 错误）
//   5. 截图落盘，把结果 JSON 打到 stdout 由 bash 侧汇总
//
// 依赖定位（不引入新包，复用 deepseek-harness workspace 的 playwright@1.61.1）：
//   - 扫 $OOB_DSH_REPO/node_modules/.pnpm/playwright@*/node_modules/playwright
//   - 浏览器：先试 playwright 注册浏览器（ms-playwright 缓存已有），失败回退
//     channel:'chrome'（本机 /Applications/Google Chrome.app）
//
// 退出码：0=探针完整执行（面板/数据结论看 JSON 字段，由 bash 判色）
//        2=playwright 不可用（SKIP 信号，bash 判 SKIP 不判红）
//        3=浏览器起不来 / 页面打不开（探针执行失败，bash 判红）
// =============================================================================

import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const { values: opt } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: false,
  options: {
    'base-url': { type: 'string' },
    'panel-paths': { type: 'string', default: '' }, // 逗号分隔
    'data-text': { type: 'string', default: 'oob-accept' },
    screenshot: { type: 'string' },
    'console-log': { type: 'string' },
    'timeout-ms': { type: 'string', default: '12000' },
    'dsh-repo': { type: 'string', default: process.env.OOB_DSH_REPO ?? resolve(here, '../../deepseek-harness') },
  },
})

if (!opt['base-url']) {
  console.error('missing --base-url')
  process.exit(3)
}

const timeoutMs = Number(opt['timeout-ms']) || 12000

// ---- playwright 定位 --------------------------------------------------------
function resolvePlaywright() {
  const pnpmDir = join(opt['dsh-repo'], 'node_modules', '.pnpm')
  if (!existsSync(pnpmDir)) return null
  // playwright@ 与 playwright-core@ 均存在；优先 playwright（含 CLI 形态一致 API）
  const all = readdirSync(pnpmDir)
  const candidates = all
    .filter((n) => /^playwright@\d/.test(n))
    .sort()
    .concat(all.filter((n) => /^playwright-core@\d/.test(n)).sort())
  for (const c of candidates) {
    const entry = join(pnpmDir, c, 'node_modules')
    try {
      const req = createRequire(join(entry, 'package.json'))
      const mod = req('playwright/package.json')
      void mod
      return { root: join(pnpmDir, c, 'node_modules'), require: req }
    } catch {
      /* try next */
    }
  }
  return null
}

const pwLoc = resolvePlaywright()
if (!pwLoc) {
  console.log(JSON.stringify({ ok: false, reason: 'playwright-not-found', skipped: true }))
  process.exit(2)
}

let chromium
try {
  const req = createRequire(join(pwLoc.root, '_probe_.json'))
  const pw = req('playwright')
  chromium = pw.chromium ?? pw.default?.chromium
} catch (e) {
  console.log(JSON.stringify({ ok: false, reason: 'playwright-import-failed: ' + String(e), skipped: true }))
  process.exit(2)
}

if (!chromium) {
  console.log(JSON.stringify({ ok: false, reason: 'playwright-chromium-missing', skipped: true }))
  process.exit(2)
}

// ---- 浏览器启动（注册浏览器 → 系统 Chrome 回退）------------------------------
const consoleErrors = []
const baseUrl = opt['base-url'].replace(/\/+$/, '')
const panelPaths = opt['panel-paths']
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => (p.startsWith('/') ? p : '/' + p))

const result = {
  ok: true,
  browser: null,
  panelBundle: { path: null, status: 0, tried: [] },
  dataMounted: false,
  dataText: opt['data-text'],
  consoleErrors,
  pageTitle: null,
}

let browser = null
try {
  try {
    browser = await chromium.launch()
    result.browser = 'playwright-chromium'
  } catch (e1) {
    browser = await chromium.launch({ channel: 'chrome' })
    result.browser = 'system-chrome'
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, reason: 'browser-launch-failed: ' + String(e) }))
  process.exit(3)
}

try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await ctx.newPage()

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[console.error] ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    consoleErrors.push(`[pageerror] ${String(err)}`)
  })

  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 20000 })
  result.pageTitle = await page.title().catch(() => null)
  await page.waitForTimeout(1500)

  // ---- 断言 e 前半：面板 bundle 200 ----
  for (const p of panelPaths) {
    const full = baseUrl + p
    try {
      const resp = await ctx.request.get(full, { timeout: timeoutMs })
      result.panelBundle.tried.push({ path: p, status: resp.status() })
      if (resp.status() === 200 && result.panelBundle.status !== 200) {
        result.panelBundle.status = 200
        result.panelBundle.path = p
        const body = await resp.text().catch(() => '')
        result.panelBundle.bytes = body.length
      }
    } catch (e) {
      result.panelBundle.tried.push({ path: p, status: -1, error: String(e).slice(0, 120) })
    }
  }

  // ---- 断言 e 后半：面板挂载真数据（body 内出现证据文本）----
  try {
    await page.waitForFunction(
      (needle) => document.body && document.body.innerText.includes(needle),
      opt['data-text'],
      { timeout: timeoutMs },
    )
    result.dataMounted = true
  } catch {
    result.dataMounted = false
  }

  if (opt.screenshot) {
    try {
      await page.screenshot({ path: opt.screenshot, fullPage: false })
    } catch (e) {
      result.screenshotError = String(e)
    }
  }

  // 再停一拍收隔夜 console 噪音
  await page.waitForTimeout(1000)
  await ctx.close()
} catch (e) {
  result.ok = false
  result.reason = 'page-drive-failed: ' + String(e)
  console.log(JSON.stringify(result))
  await browser.close().catch(() => {})
  process.exit(3)
}

await browser.close().catch(() => {})

if (opt['console-log']) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(opt['console-log'], consoleErrors.join('\n') + (consoleErrors.length ? '\n' : ''))
}

console.log(JSON.stringify(result))
process.exit(0)
