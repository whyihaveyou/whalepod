#!/usr/bin/env python3
"""从 design/tokens/tokens.css 生成 OOBE 注入层样式表。

用法：python3 design/shell/gen-oobe-tokens.py
产物：design/shell/oobe-inject-tokens.css（生成物，勿手改）

注入层（WKUserScript 注入 harness 页面，Shadow DOM 或 dfh- 前缀容器）
读不到壳的 CSS 环境，需要一份自带 dark token 值的独立样式表。
本脚本提取 tokens.css 的 :root（dark 默认）声明，重定向到
`:host, .dfh-oobe-root` 作用域，并附带 reduced-motion 降级。
源文件变更后重跑本脚本即可，禁止在生成物上手改色值。
"""
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "tokens" / "tokens.css"
OUT = HERE / "oobe-inject-tokens.css"
SCOPE = ":host, .dfh-oobe-root"

text = SRC.read_text(encoding="utf-8")

# 提取 :root { ... } 块（dark 默认主题；OOBE 注入容器强制 dark，见 oobe-visual-spec §8）
root_match = re.search(r"^:root\s*\{(.*?)^\}", text, re.M | re.S)
if not root_match:
    raise SystemExit("tokens.css 中未找到 :root 块")
root_block = root_match.group(1)

# 逐行保留声明与注释，丢掉空行
decls = [line for line in root_block.splitlines() if line.strip()]

# reduced-motion：时长变量归零（与 tokens.css 末尾的 media query 一致）
motion_vars = re.findall(r"(--duration-\w+):", root_block)
motion_reset = "\n".join(f"    {v}: 0ms;" for v in motion_vars)

header = f"""/*
 * GENERATED FILE — 勿手改。
 * 源：design/tokens/tokens.css（:root = dark 默认主题）
 * 重新生成：python3 design/shell/gen-oobe-tokens.py
 * 用途：OOBE-M1 WKUserScript 注入层的 token 环境（见 oobe-visual-spec §6）。
 * 注入容器强制 dark；M1 不注入 light 样式表。
 */"""

body = "\n".join(decls)
out = f"""{header}
{SCOPE} {{
{body}
}}

@media (prefers-reduced-motion: reduce) {{
  {SCOPE} {{
{motion_reset}
  }}
}}
"""

OUT.write_text(out, encoding="utf-8")
print(f"generated {OUT} ({len(decls)} lines, {len(motion_vars)} motion vars)")
