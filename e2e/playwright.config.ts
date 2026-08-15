/**
 * Playwright 配置 — WhalePod 视觉回归基线
 *
 * 目标：
 *   - 团队面板（prototypes/team-panel）截图比对
 *   - 皮肤中心（未来）多主题回归
 *   - HarnessShell 加载页（待 WKWebView 截图能力）
 *
 * 设计：
 *   - 默认 baseURL = http://localhost:5173（Vite dev server）
 *   - baseline 在每个 spec 文件旁的 __screenshots__/ 目录（git 跟踪）
 *   - 失败时输出到 test-results/ 与 playwright-report/（gitignore）
 *   - 单浏览器矩阵（chromium）：视觉回归不需要多浏览器铺张
 *   - 不跑 macos-only WebKit（CI 矩阵已用 ubuntu，WebKit 留给本地）
 */
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  // baseline 与 spec 同目录，命名为 __screenshots__/
  snapshotPathTemplate: '{testDir}/{testFilePath}/__screenshots__/{arg}-{platform}{ext}',

  // 单 chromium 项目；CI 不要铺多浏览器（视觉回归意义不大）
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // 不开 webServer（团队面板原型有自己的 npm run dev）
  // 视觉回归运行手册：先 cd prototypes/team-panel && pnpm dev，再 cd e2e && pnpm test
  // CI 集成时由 release.yml 单独起 webServer（待补）

  // 截图比对策略
  expect: {
    toHaveScreenshot: {
      // 视觉回归默认阈值 0.2%（antialias/font 微差容忍）
      maxDiffPixelRatio: 0.002,
      // 单测阈值 100px（即使 0.2% 比例也允许 100 个像素差异，避免 flake）
      maxDiffPixels: 100,
      // 动画关掉（避免动画中帧被基线化）
      animations: 'disabled',
    },
    toMatchSnapshot: {
      maxDiffPixelRatio: 0.002,
      maxDiffPixels: 100,
    },
  },

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // 输出与制品
  outputDir: 'test-results/',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  // CI 上限与重试
  timeout: 30_000,
  expectTimeout: 5_000,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
})