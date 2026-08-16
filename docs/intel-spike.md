# Intel 档 spike：x86_64 构建可行性验证 + 落地方案

> 任务 `#01a00567`。结论状态：**PASS** —— Intel (x86_64) 档可在现有脚本上直接本地交叉构建产出，**无需 CI macos-13**。
> 相关脚本改动已落库 commit `4924583`（Leader 已验证并回填实测证据）。

---

## 0. 一句话结论

Apple Silicon 开发机上用 `swift build --arch x86_64` 交叉编出真 x86_64 二进制，配 `build-runtime.sh ARCH=x64`
内嵌 Intel(x64) node + dsh，在 Rosetta 下 `env -i` 全链路冒烟通过（SELFTEST 36/36）；Slim-Intel 直接可得（≈1.1MB zip）。
**本地交叉即覆盖全链，CI macos-13 暂不需要**；唯一缺的是「真 Intel 物理机」的最终实机验证，建议走社区实测。

---

## 1. 背景与约束

- 原分发仅 **arm64**（handoff-distribution.md 写「仅 Apple Silicon / Intel 机型本版不支持」）。
- 本次 spike 目标：验证能否**零新增机器**、用现有脚本产出 Intel 档，作为 handoff 版本矩阵第三行。
- 关键约束：壳代码（Sources/）不动、build-app/build-runtime 主链不破坏（ARCH 参数化默认行为 = 宿主架构）。

### 1.1 两个脚本的架构命名差异（务必区分）

| 层 | 命名 | 取值 | 用在哪 |
| --- | --- | --- | --- |
| Swift 交叉编译 | `swift --arch` | `x86_64` / `arm64` | `build-app.sh` 的 `ARCH` |
| Node 官方 tarball | filename 内 | `x64` / `arm64` | `build-runtime.sh` 的 `ARCH` |

两个脚本各自 `ARCH`，**不要混传**：`build-app.sh` 传 `x86_64`，`build-runtime.sh` 传 `x64`。

---

## 2. 可行性证据（Leader 实测 + 本机复验，2026-08-16）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `swift build --arch x86_64` | PASS 52s | CLT 自带 x86_64 slice，本地交叉编译可用 |
| 交叉产物为**真 x86_64** | PASS | `file` 确认 Mach-O x86_64（非 arm64 误报） |
| `build-runtime.sh ARCH=x64` | PASS | 正确下载 `node-v22.17.0-darwin-x64.tar.xz` + `dsh@0.1.0-rc.6` |
| Rosetta 冒烟 `env -i + arch -x86_64` | PASS | SELFTEST 36/36，x64 node / dsh CLI 可跑 |
| Slim-Intel | PASS | ≈1.1MB zip，内含真 x86_64 二进制 |

> 关键坑：构建阶段必须用 `SCRATCH_PATH` 隔离（见 §4.1），否则 `.build/release` 软链会指回上次宿主 arm64 产物，
> 出现「zip 写 x86_64 但内容却是 arm64」的静默错误。

---

## 3. 复跑命令（可复现）

### 3.1 Full-Intel 全链（.app 内嵌 Intel node + dsh）

```bash
cd /Users/qzp/aion2dsh/HarnessShell

# ① 交叉编译 x86_64 壳（隔离 scratch，避免 .build/release 指针互踩宿主 arm64）
APP_NAME=HarnessShell VERSION=0.1.0 \
  ARCH=x86_64 SCRATCH_PATH=/tmp/intel-spike/full-intel/.build \
  ./Scripts/build-app.sh

# ② 装 x64 node + dsh（build-runtime.sh 支持 ARCH=x64，下载 node-v22.17.0-darwin-x64.tar.xz）
ARCH=x64 ./Scripts/build-runtime.sh        # 按脚本实际输出路径/参数跑，DIST_DIR 与 ① 对齐

# ③ 真机 Rosetta 冒烟（隔离环境，剥离宿主 PATH，强制 x86_64）
env -i /usr/bin/arch -x86_64 \
  "$PWD/dist/HarnessShell.app/Contents/MacOS/HarnessShell" 2>&1 | tee /tmp/intel-spike/full-smoke.log
# 期望：SELFTEST 36/36 PASS、端口解析 OK、HTTP 200

# ④ 校验内嵌 node 确实为 x64（防「zip 写 x86_64 内藏 arm64」静默错）
file "$PWD/dist/HarnessShell.app/Contents/Resources/node/bin/node"
# 期望输出含 x86_64
```

### 3.2 Slim-Intel（复用 make-slim.sh，一条命令）

```bash
cd /Users/qzp/aion2dsh/HarnessShell
ARCH=x86_64 SCRATCH_PATH=/tmp/intel-spike/slim-intel/.build \
  APP_NAME=HarnessShell VERSION=0.1.0 BUILD_NUMBER=1 \
  ./Scripts/make-slim.sh
# 产物：dist/WhalePod-0.1.0-macos-x86_64-slim.zip（≈1.1MB，真 x86_64 二进制）
```

> make-slim.sh 已把 `ARCH` 与 `SCRATCH_PATH` 透传给 build-app.sh（commit 4924583 修复，此前只透传了
> APP_NAME/VERSION/BUILD_NUMBER/DIST_DIR/SIGN_IDENTITY，会产出「zip 声称 x86_64 实为 arm64」的假档）。

---

## 4. 关键实现点（为何能零新增机器）

### 4.1 `build-app.sh` ARCH 参数化 + SCRATCH_PATH 修正（commit 4924583）

- 新增 `ARCH="${ARCH:-$(uname -m)}"`，`swift build -c release --arch "$ARCH"`。
- 新增 `SCRATCH_PATH` 隔离：交叉编译时 `.build/release` 软链会指向**最后构建的三元组**，
  跨架构并存时必须用 `--scratch-path` 把缓存隔离到独立目录。
- **BIN 解析修正（关键）**：原来 `BIN=".build/release/$APP_NAME"`（相对路径，指回宿主 arm64）；
  现在设了 `SCRATCH_PATH` 时改从 `$SCRATCH_PATH/release/$APP_NAME` 取产物——否则拷进 .app 的是宿主干错了架构的二进制。

### 4.2 build-runtime.sh 本就 Intel-ready

`build-runtime.sh` 已内置 `x64 → node-v22.17.0-darwin-x64.tar.xz` 分支，**零改动**。

### 4.3 make-slim.sh 修复（commit 4924583）

- 补 `BUILD_NUMBER="${BUILD_NUMBER:-1}"` 默认（原 `set -u` 下未定义会炸「BUILD_NUMBER: unbound variable」）。
- 补 `ARCH` / `SCRATCH_PATH` 透传（见 §3.2 备注），使 zip 名与内容架构一致。

---

## 5. CI macos-13 备选草案（当前**不启用**，留作文档）

**结论**：本地交叉已覆盖「x86_64 二进制 + x64 runtime + Rosetta 冒烟」全链，**暂不需要 CI macos-13**。
如需将来把它收进 CI 作常驻门禁，预留草案如下（勿现在接入，烧分钟）：

```yaml
# .github/workflows 内新增 job（示意，未启用）
intel-build:
  runs-on: macos-13        # intel runner（真实 x86_64，非 Rosetta）
  steps:
    - uses: checkout@v4
    - run: ARCH=x86_64 SCRATCH_PATH=.build-intel ./Scripts/build-app.sh
    - run: ARCH=x64 ./Scripts/build-runtime.sh
    - run: env -i .build-intel/release/HarnessShell 2>&1 | tee smoke.log
    - run: grep -q "SELFTEST 36/36" smoke.log
    - run: ARCH=x86_64 SCRATCH_PATH=.build-intel ./Scripts/make-slim.sh
    - uses: actions/upload-artifact@v4
      with: { path: dist/*-macos-x86_64-slim.zip }
```

> 优点：macos-13 是真 Intel runner，能补「本机 Rosetta 冒烟」永远覆盖不到的**原生 x86_64 指令路径**。
> 代价：额外 runner 分钟 + 构建时长。当前发布节奏（cron 每日）不必要；留给「Intel 用户主动反馈」后再开。

---

## 6. handoff 版本矩阵第三行建议

在 `HarnessShell/docs/handoff-distribution.md`「一·五 版本矩阵」表后追加第三档 **Intel**：

| 维度 | Full 全家桶版（默认） | Slim 轻量版（开发者） | **Intel 档（新增提案）** |
| --- | --- | --- | --- |
| 目标用户 | 普通/测试用户（arm64） | 已装 Node 的开发者（arm64） | **Intel 机型用户（x86_64）** |
| 前置依赖 | 无 | Node ≥ 22 | **无（Full）/ Node ≥ 22（Slim）** |
| 体积 | ≈214MB（DMG） | ≈1.1MB（ZIP） | **同上（Slim-Intel ≈1.1MB）** |
| 架构 | arm64 | arm64 | **x86_64** |
| 探测链命中 | P1 bundled | P3 npxFallback | **同左（Full bundled / Slim npxFallback）** |
| 产物命名 | `WhalePod-<ver>-macos-arm64-full.dmg` | `WhalePod-<ver>-macos-arm64-slim.zip` | **`WhalePod-<ver>-macos-x86_64-slim.zip`** |

**采纳建议**：主推 **Slim-Intel**（≈1.1MB、真 x86_64 已验证），作为 Intel 用户的轻量入口；
Full-Intel（≈214MB，内嵌 x64 node）已可行但体积大、需真机再验，**建议先社区实测吃反馈再决定是否常规发布**。

> ⚠️ 真机验证缺口：本链在 Rosetta 下全绿，但**未在真实 Intel Mac 物理机**上跑过。发布 Intel 档前建议：
> ① 在真 Intel 机装 macOS 13+；② 下载 Slim-Intel zip；③ 右键打开走 Gatekeeper；④ Terminal `file` 核对 x86_64 +
> 首启 npx 拉 dsh + HTTP 200。这一步需要社区机器，开发侧无法本地补齐。

---

## 7. 汇总：改动面与风险

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `HarnessShell/Scripts/build-app.sh` | ARCH/SCRATCH_PATH 参数化 + BIN 修正 | 默认行为 = `$(uname -m)` 不变，向后兼容 ✓ |
| `HarnessShell/Scripts/make-slim.sh` | ARCH/SCRATCH_PATH 透传 + BUILD_NUMBER 默认 | 默认 arm64 不变 ✓ |
| `build-runtime.sh` | 零改动 | — |
| `Sources/` | 零改动 | — |

风险集中在「架构误报」（zip/外壳声称 x86_64 实为 arm64）——已由 §3.1 ④ 的 `file` 校验兜底。
