/**
 * 团队面板 — 视觉回归示例用例
 *
 * 前置：
 *   1. cd prototypes/team-panel && pnpm install && pnpm dev  （起 Vite，监听 5173）
 *   2. cd ../../e2e && pnpm install && pnpm test            （跑视觉回归）
 *
 * 跑通后会生成 baseline：
 *   e2e/skin-center/__screenshots__/team-panel-dark-chromium.png
 *   e2e/skin-center/__screenshots__/team-panel-light-chromium.png
 *   e2e/skin-center/__screenshots__/team-panel-empty-chromium.png
 *
 * 更新 baseline（视觉确认改动后）：
 *   pnpm test:update
 *
 * 注意：本 spec 用通用选择器（role + text）而非 data-testid，便于在没有
 * data-testid 属性的 prototype 上也能跑。等 K3-2/视觉 后续给原型加
 * data-testid 后可收紧选择器（更稳、更快）。
 *
 * 当前为「骨架示例」：先证明 CI 链路通（vite 起 + playwright 跑 + 截图比对），
 * 视觉断言用宽松阈值。后续 owner 替换为具体页面+组件的精细 baseline。
 */
import { test, expect } from '@playwright/test'

const PANEL_URL = '/'

test.describe('团队面板视觉回归', () => {
  test('首屏暗色主题（通用选择器）', async ({ page }) => {
    // 强制暗色（design/tokens 默认）
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(PANEL_URL)
    // 等首屏渲染（用 main 元素，HTML 标准语义）
    await page.waitForSelector('main, body, #root', { timeout: 15_000 })
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})

    // 全屏截图（viewport 1280x800，与 Desktop Chrome device 一致）
    await expect(page).toHaveScreenshot('team-panel-dark.png', {
      fullPage: false,
      maxDiffPixels: 500,  // 首次示例：宽松阈值
    })
  })

  test('首屏浅色主题', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto(PANEL_URL)
    await page.waitForSelector('main, body, #root', { timeout: 15_000 })
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})

    await expect(page).toHaveScreenshot('team-panel-light.png', {
      fullPage: false,
      maxDiffPixels: 500,
    })
  })

  test('空态布局（mock 数据为空假设）', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(PANEL_URL)
    await page.waitForSelector('main, body, #root', { timeout: 15_000 })

    // 截图空态（mock 数据就位后基线即生效）
    await expect(page).toHaveScreenshot('team-panel-empty.png', {
      fullPage: true,
      maxDiffPixels: 500,
    })
  })
})