// ============================================================
// TitleBar — 顶部 40px 标题栏（wireframe §1）
// 左：icon-mono + "DFH Workstation"；中：项目名 aionui2dsh；
// 右：⌘K 搜索入口 + 设置
// ============================================================

import { Button } from "../common/Button";
import { IconCmd, IconSearch } from "../../lib/icons";

export function TitleBar({
  onCommandPalette,
}: {
  onCommandPalette: () => void;
}) {
  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <img src="/icon-mono-light.svg" alt="" className="titlebar-logo" />
        <span className="titlebar-brand">DFH Workstation</span>
      </div>
      <div className="titlebar-mid">
        <span className="titlebar-project" title="团队面板原型">
          aionui2dsh
        </span>
      </div>
      <div className="titlebar-right">
        <Button
          size="sm"
          variant="ghost"
          onClick={onCommandPalette}
          className="cmd-k-btn"
          title="命令面板 (⌘K)"
        >
          <IconSearch size={13} />
          <span className="cmd-k-label">搜索 / 命令</span>
          <kbd className="kbd">⌘K</kbd>
        </Button>
        <button className="icon-btn" aria-label="设置" title="设置">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="2.1" />
            <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
          </svg>
        </button>
      </div>
    </header>
  );
}
