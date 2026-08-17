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

  // 客户端装配 manifest（modules 服务 index tap 注入）：列出浏览器真正被分发的插件行
  try {
    const boot = await page.evaluate(() => {
      const w = /** @type {any} */ (window)
      return w.__DSH_BOOT__ ?? null
    })
    result.dshBoot = boot
    // 浏览器侧权威 url 列表（相对路径）插到候选头部
    const urls = []
    // 真实 manifest 形态：{ rev, entries: [{id,url,rev,inject}] }（生产实证，
    // 见 OOB-F4：id 为完整包名含 @scope，url 亦为全名路径 /plugins/@scope/pkg/client.js?rev=）
    if (boot && Array.isArray(boot.entries)) {
      for (const m of boot.entries) {
        if (m && typeof m.url === 'string') urls.push(m.url)
      }
    } else if (boot && Array.isArray(boot.modules)) {
      for (const m of boot.modules) {
        if (m && typeof m.url === 'string') urls.push(m.url)
      }
    } else if (boot && boot.plugins && typeof boot.plugins === 'object') {
      for (const v of Object.values(boot.plugins)) {
        if (v && typeof v.url === 'string') urls.push(v.url)
      }
    }
    for (const u of urls) {
      if (!u.startsWith('/') || panelPaths.includes(u)) continue
      // OOB-F7：__DSH_BOOT__.entries 含多个插件 bundle（dsh-client-connection 等），
      // 一律 unshift 会让非面板 bundle 抢占候选首位 → fetch 到错误目标（200 但非面板）。
      // 面板 bundle 优先置顶，其余插件 URL 仅作末尾兜底。
      if (u.includes('ui-whalepod-team')) panelPaths.unshift(u)
      else panelPaths.push(u)
    }
    result.dshBootUrls = urls
  } catch (e) {
    result.dshBootError = String(e).slice(0, 120)
  }

  // ---- 3.5 首启 OOBE 闸清场（生产实证 OOB-F6：内测声明[继续]→API Key[稍后配置] 多步向导）----
  result.oobe = []
  let quietRounds = 0
  for (let k = 0; k < 8; k++) {
    const action = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, [role="button"]')]
      const pick = (re) => btns.find(x => re.test((x.textContent || '').trim()) && !x.disabled)
      const b = pick(/^稍后配置$/) || pick(/^跳过$/) || pick(/^继续$/) || pick(/^保存并继续$/) || pick(/^(开始使用|完成)$/)
      if (b) { b.click(); return 'clicked:' + b.textContent.trim() }
      return null
    })
    result.oobe.push(action === null ? 'no-match' : String(action))
    if (action === null) {
      quietRounds++
      if (quietRounds >= 2) break
      await page.waitForTimeout(1200)
      continue
    }
    quietRounds = 0
    await page.waitForTimeout(2000)
  }

  // OOB-F9：OOBE 清场后主界面（cordis 全插件启动 + sidebar 渲染）需要数秒，
  // fresh 首启（seed 种植+全量初始化）更慢——144005 轮实证「稍后配置」后 4.4s
  // 找不到触发器即 not-opened。显式等「团队面板」触发器出现（至多 30s，超时继续兜底）。
  try {
    await page.waitForFunction(() => {
      if (document.querySelector('[data-whalepod-team]')) return true
      return [...document.querySelectorAll('button,[role="button"],[class*="trigger"],[class*="item"]')]
        .some(el => ((el.textContent || '') + (el.getAttribute('aria-label') || '')).includes('团队面板'))
    }, { timeout: 30000, polling: 500 })
    result.mainUiReady = true
  } catch {
    result.mainUiReady = false
  }

  // ---- 3.6 打开团队面板（生产实证：入口是侧栏「◈团队面板」按钮；打开后 roster 经 :4800 拉真数据）----
  result.panelOpened = false
  const clickTrigger = async () => page.evaluate(() => {
    const els = [...document.querySelectorAll('button, [role="button"], [class*="trigger"]')]
    const visible = (x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const hit = (x) => ((x.textContent || '') + (x.getAttribute('aria-label') || '') + (x.getAttribute('title') || '')).includes('团队面板')
    const el = els.find(x => hit(x) && visible(x)) || els.find(hit)
    if (el) { el.click(); return (el.textContent || '').trim().slice(0, 30) }
    return null
  }).catch(e => 'err:' + String(e).slice(0, 60))
  // 面板打开判据：页面文本出现 roster 表头标记；等 5s 后复查，未见则重试一次
  const panelMarkerShown = async () => {
    for (const fr of page.frames()) {
      try {
        const t = await fr.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')
        if (t && t.includes('团队') && /状态[\s\S]{0,40}名称/.test(t)) return t
      } catch {}
    }
    return null
  }
  try {
    for (let attempt = 1; attempt <= 2 && !result.panelText; attempt++) {
      const t0 = await clickTrigger()
      result['panelClick' + attempt] = t0 === null ? 'no-trigger' : 'clicked:' + t0
      await page.waitForTimeout(5000)
      const marked = await panelMarkerShown()
      if (marked) {
        result.panelOpened = 'attempt' + attempt
        result.panelText = marked.replace(/\s+/g, ' ').slice(0, 600)
        break
      }
      if (attempt === 1) {
        // 首击未开：快照存证（排查 OOBE 冻屏/点击落空用），然后重试
        result.panelText1 = (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 400) : '').catch(() => '')).replace(/\s+/g, ' ')
      }
    }
    if (!result.panelOpened) result.panelOpened = 'not-opened'
  } catch (e) {
    result.panelOpened = 'err:' + String(e).slice(0, 80)
  }

  // ---- 装配模块权威清单：GET /api/assembled/boot（K3-1 fixture 先例）
  // 直接把服务端喂给 loader 的 {id,url,rev} 行取出来——命中即视为权威候选（不再猜路径）
  try {
    const boot = await ctx.request.get(baseUrl + '/api/assembled/boot', { timeout: timeoutMs })
    result.assembledBoot = { status: boot.status() }
    if (boot.status() === 200) {
      const bootJson = await boot.json().catch(() => null)
      const mods = (bootJson && (bootJson.modules ?? bootJson.data?.modules)) || null
      if (Array.isArray(mods)) {
        result.assembledBoot.modules = mods.map((m) => ({ id: m?.id, url: m?.url }))
        // 权威 URL（含 ?rev=）优先插入候选头部（host 去重由后续命中判定覆盖）
        for (const m of mods) {
          const u = m && typeof m.url === 'string' ? m.url : ''
          if (u && !panelPaths.includes(u)) panelPaths.unshift(u)
        }
      }
    }
  } catch (e) {
    result.assembledBoot = { error: String(e).slice(0, 120) }
  }

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

  // ---- 断言 e 后半：面板挂载真数据（全 frame 遍历：面板可能默认未激活主文档，或挂在
  // 独立 frame 内；逐 frame evaluate innerText 轮询，单帧崩不影响他帧）----
  const deadline = Date.now() + timeoutMs
  let dataFrame = null
  while (Date.now() < deadline && !result.dataMounted) {
    for (const fr of page.frames()) {
      try {
        const hit = await fr.evaluate(
          (needle) => document.body && document.body.innerText.includes(needle),
          opt['data-text'],
        ).catch(() => false)
        if (hit) {
          result.dataMounted = true
          dataFrame = fr.url()
          break
        }
      } catch {
        /* frame 被撕/导航中，下一个 */
      }
    }
    if (!result.dataMounted) await page.waitForTimeout(500)
  }
  result.dataFrame = dataFrame || 'none'

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
