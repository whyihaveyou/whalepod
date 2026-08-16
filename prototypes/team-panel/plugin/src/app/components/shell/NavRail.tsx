// ============================================================
// NavRail — 左侧导航（wireframe §2）
// 折叠态 56px / 展开态 200px；图标 + accent 未读小圆点；
// 底部 +扩编 + 折叠/展开切换按钮（⌘B 同效）
// ============================================================

import type { ReactNode } from "react";
import type { ViewId } from "../../types";
import { IconActivity, IconBoard, IconChevronDown, IconPlus, IconUsers } from "../../lib/icons";

interface NavItem {
  id: ViewId;
  label: string;
  icon: ReactNode;
  badge?: number;
}

export function NavRail({
  view,
  expanded,
  onToggle,
  onSwitchView,
  onSpawn,
  rosterCount,
  activityUnread,
}: {
  view: ViewId;
  expanded: boolean;
  onToggle: () => void;
  onSwitchView: (v: ViewId) => void;
  onSpawn: () => void;
  rosterCount: number;
  activityUnread: number;
}) {
  const items: NavItem[] = [
    { id: "roster", label: "团队成员", icon: <IconUsers size={17} />, badge: rosterCount },
    { id: "board", label: "任务板", icon: <IconBoard size={17} /> },
    { id: "activity", label: "活动流", icon: <IconActivity size={17} />, badge: activityUnread },
  ];

  return (
    <nav className={`navrail ${expanded ? "navrail-open" : "navrail-closed"}`} aria-label="主导航">
      <div className="navrail-items">
        {items.map((it) => (
          <button
            key={it.id}
            className={`nav-item ${view === it.id ? "nav-active" : ""}`}
            onClick={() => onSwitchView(it.id)}
            title={it.label}
            aria-current={view === it.id ? "page" : undefined}
          >
            <span className="nav-item-icon">{it.icon}</span>
            {expanded && <span className="nav-item-label">{it.label}</span>}
            {it.badge != null && it.badge > 0 && (
              <span
                className={`nav-item-badge ${expanded ? "" : "nav-badge-float"}`}
                aria-label={`${it.badge} 条`}
              />
            )}
          </button>
        ))}
      </div>
      <div className="navrail-bottom">
        <button className="nav-spawn" onClick={onSpawn} title="扩编（⌘⇧N）">
          <IconPlus size={16} />
          {expanded && <span>扩编</span>}
        </button>
        <button
          className="nav-toggle"
          onClick={onToggle}
          aria-label={expanded ? "收起导航" : "展开导航"}
          aria-expanded={expanded}
          title={`${expanded ? "收起" : "展开"}导航（⌘B）`}
        >
          <IconChevronDown size={14} className={expanded ? "rot180" : ""} />
        </button>
      </div>
    </nav>
  );
}
