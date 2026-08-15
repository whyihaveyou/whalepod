#!/usr/bin/env node
/**
 * auto-update spike — 「检出有新版」最小验证（不真替换 .app）。
 *
 * 用法：
 *   node spikes/auto-update/check-version.mjs <appcastUrl|appcastFile> <installedVersion>
 *
 * 例：
 *   node spikes/auto-update/check-version.mjs spikes/auto-update/appcast.xml 0.1.0-alpha.4
 *   # → 检出有新版：latest=0.1.0-alpha.5 (installed=0.1.0-alpha.4)
 *
 * 例（本机静态 http 服务，模拟线上通道）：
 *   cd spikes/auto-update && python3 -m http.server 4833 &
 *   node check-version.mjs http://127.0.0.1:4833/appcast.xml 0.1.0-alpha.4
 *
 * 职责：拉 appcast → 按 sparkle:version(=build) 取最新 item → 与 installed 版本比对。
 * 不求真替换/下载，只证明「通道可读 + 版本可判大小」这条链路通。
 */
import { readFile } from 'node:fs/promises'

// ---- 版本语义比较（semver-ish，支持 0.1.0-alpha.N / 数字 build）----
const TOKEN_RE = /(\d+)|([a-zA-Z]+)|(-)|([._])/g
function parseTokens(v) {
  const out = []
  for (const m of String(v ?? '').matchAll(/\d+|[a-zA-Z]+/g)) {
    const t = m[0]
    out.push(/^\d+$/.test(t) ? ['n', Number(t)] : ['s', t])
  }
  return out
}
function compare(a, b) {
  const A = parseTokens(a)
  const B = parseTokens(b)
  const len = Math.max(A.length, B.length)
  for (let i = 0; i < len; i++) {
    const x = A[i]
    const y = B[i]
    if (!x && y) return -1 // a 缺段 → a 小
    if (x && !y) return 1
    if (x[0] === y[0]) {
      if (x[0] === 'n') {
        if (x[1] !== y[1]) return x[1] - y[1]
      } else if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1
    } else {
      return x[0] === 'n' ? 1 : -1 // 数字段优先于字母段
    }
  }
  return 0
}
// 严格上升：以 sparkle:version（build=整数，严格递增）为**主**排序键——
// 这是 Sparkle / electron-updater 的真实做法，能避开「0.1.0(稳定) vs
// 0.1.0-alpha.5(预发)」的 semver 谜题：
//   严格 semver 里预发 < 稳定（0.1.0-alpha.5 < 0.1.0），
//   但 build 号(CFBundleVersion)逐次 +1，天然单调、无歧义。
// shortVersion 仅作展示。
function pickLatest(items) {
  return items.reduce((best, it) => {
    if (!best) return it
    const bi = Number(it.build)
    const bb = Number(best.build)
    // build 都可解析 → 按 build 比；否则退化为 shortVersion 字符串比
    if (!Number.isNaN(bi) && !Number.isNaN(bb)) return bi > bb ? it : best
    return compare(it.shortVersion, best.shortVersion) > 0 ? it : best
  }, null)
}

// ---- appcast 解析（最小正则，够 spike 用）----
function parseAppcast(xml) {
  const items = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1]
    const sv = /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/.exec(body)?.[1]
    const bv = /<sparkle:version>([^<]+)<\/sparkle:version>/.exec(body)?.[1]
    const url = /<enclosure\s+[^>]*url="([^"]+)"/.exec(body)?.[1]
    items.push({ shortVersion: sv, build: bv, url })
  }
  return items
}

async function loadAppcast(src) {
  if (src.startsWith('http://') || src.startsWith('https://')) {
    const res = await fetch(src)
    if (!res.ok) throw new Error(`fetch ${src} → HTTP ${res.status}`)
    return res.text()
  }
  return readFile(src, 'utf8')
}

async function main() {
  const [src, installed] = process.argv.slice(2)
  if (!src || !installed) {
    console.error('用法: node check-version.mjs <appcastUrl|appcastFile> <installedVersion>')
    process.exit(2)
  }
  const xml = await loadAppcast(src)
  const items = parseAppcast(xml)
  if (items.length === 0) {
    console.error('✗ appcast 无条目')
    process.exit(3)
  }
  const latest = pickLatest(items)
  // installed 若可解析为 build 号，按 build 比；否则按 shortVersion 比
  const instBuild = Number(installed)
  const latBuild = Number(latest.build)
  const newer = (!Number.isNaN(instBuild) && !Number.isNaN(latBuild))
    ? latBuild > instBuild
    : compare(latest.shortVersion, installed) > 0
  console.log(`appcast 条目: ${items.length} 条`)
  console.log(`latest      : ${latest.shortVersion}  (build=${latest.build})  ${latest.url}`)
  console.log(`installed   : ${installed}`)
  console.log(newer ? '✅ 检出有新版 — 应提示下载' : '已是最新，无需更新')
  process.exit(newer ? 0 : 1) // 0=有新版(可走更新)，1=已最新
}

main().catch((e) => {
  console.error('✗ 更新检查失败:', e.message)
  process.exit(3)
})
