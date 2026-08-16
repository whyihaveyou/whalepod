# WhalePod v0.1.0-alpha.5（草案，20:00 cron 发版用）

> 修复与加固版：自动更新解析加固 + 发布链品牌化命名 + Intel 交叉构建验证通过。

## 用户可见
- **自动更新检测加固（M1）**：appcast 双 enclosure 解析（Full DMG + Slim ZIP 同条目），按当前安装档选择更新源；逐 enclosure 捕获 sha256/length 为 M2 下载校验铺路；单 enclosure appcast 向后兼容；解析失败安全回 nil（不误报更新）。自检 36/36 全过（UpdaterSelfTest）。
- **首个品牌化命名发布**：Full 档产物名 `WhalePod-0.1.0-alpha.5-macos-arm64.dmg`（此前为 HarnessShell.dmg 通用名）。

## 构建/内部
- Intel（x86_64）交叉构建 spike 全链 PASS：`ARCH=x86_64` 本地交叉编译 + x64 node 注入 + Rosetta 冒烟（SELFTEST 36/36）+ Slim-Intel 1.1M 产物；CI macos-13 runner 暂不启用（本地交叉即通）。Intel 档尚未进发布链，alpha.6 档口评估。
- release.yml 修复潜在 404：appcast enclosure URL 与 DMG 实际产物名对齐（DMG_NAME 透传）。
- make-slim.sh 修复 BUILD_NUMBER 未绑定变量（set -u）。

## 文档
- docs/auto-update-m2.md（M2 下载/替换/回滚设计，待 Developer ID 公证后实施）
- docs/panel-embedding-plan.md（团队面板装进真实 dsh web 调研结论）
- docs/cancel-e2e-plan.md（cancel ⑦ E2E 测试方案）
- docs/intel-spike.md（Intel 档 spike 结论 + 可复跑命令）

## 已知限制
- honeycomb 多 agent 编排层尚未装箱进发版 app（设计在途，docs/honeycomb-app-bundling.md）——装机跑的仍是基础 dsh harness。
- M2 自动下载/替换未实施（本版本更新仍需手动下载安装）。
- ad-hoc 签名（无 Developer ID 公证），首次打开需右键放行。

## 升级方式
- Full 档：下载 `WhalePod-0.1.0-alpha.5-macos-arm64.dmg`，拖入 Applications 替换。
- Slim 档：下载 `WhalePod-0.1.0-alpha.5-macos-arm64-slim.zip`（1.1MB），解压后首次启动自举下载运行时。
