/**
 * 团队面板 — 视觉回归示例用例
 *
 * 前置：
 *   1. cd prototypes/team-panel && pnpm install && pnpm dev  （起 Vite，监听 5173）
 *   2. cd ../../e2e && pnpm install && pnpm test          （跑视觉回归）
 *
 * 跑通后会生成 baseline：
 *   e2e/skin-center/__screenshots__/team-panel-dark-chromium.png
 *   e2e/skin-center/__screenshots__/team-panel-light-chromium.png
 *
 * 更新 baseline（视觉确认改动后）：
 *   pnpm test:update
 *
 * 注意：本 spec 故意用宽松断言（maxDiffPixels=200），方便首次跑通。
 * 等团队面板的 mock 数据稳定后，可收紧到 50px。
 */
import { test, expect } from '@playwright/test'

const PANEL_URL = '/'

test.describe('团队面板视觉回归', () => {
  test('首屏暗色主题', async ({ page }) => {
    // 强制暗色（design/tokens 默认）
    await page.emulateMedia({ colorScheme: 'dark' })

    await page.goto(PANEL_URL)
    // 等 Roster 视图与任务板渲染
    await page.waitForSelector('[data-testid="roster"]', { timeout: 10_000 })
    await page.waitForSelector('[data-testid="task-board"]', { timeout: 10_000 })

    // 全屏截图（viewport 1280x800，与 Desktop Chrome device 一致）
    await expect(page).toHaveScreenshot('team-panel-dark.png', {
      fullPage: false,
      maxDiffPixels: 200,  // 首次示例：宽松阈值
    })
  })

  test('首屏浅色主题', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })

    await page.goto(PANEL_URL)
    await page.waitForSelector('[data-testid="roster"]', { timeout: 10_000 })

    await expect(page).toHaveScreenshot('team-panel-light.png', {
      fullPage: false,
      maxDiffPixels: 200,
    })
  })

  test('任务卡 hover 态', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(PANEL_URL)
    await page.waitForSelector('[data-testid="task-card"]', { timeout: 10_000 })

    // 找到第一张任务卡 hover（验证 hover 视觉：边框/阴影）
    const firstCard = page.locator('[data-testid="task-card"]').first()
    await firstCard.hover()
    await page.waitForTimeout(300)  // 等 hover 动画稳定

    await expect(firstCard).toHaveScreenshot('task-card-hover.png', {
      maxDiffPixels: 200,
    })
  })
})