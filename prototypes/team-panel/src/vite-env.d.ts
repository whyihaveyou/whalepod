/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 数据源切换：设为 "honeycomb" 时走真实 honeycomb API（默认 mock） */
  readonly VITE_TEAM_API?: string
  /** honeycomb transport HTTP 地址（默认 http://127.0.0.1:4800） */
  readonly VITE_HONEYCOMB_HTTP?: string
  /** honeycomb transport WS 地址（默认 ws://127.0.0.1:4801） */
  readonly VITE_HONEYCOMB_WS?: string
  /** 面板订阅的 hive id（默认 hive-dev；server 侧须已存在该 hive） */
  readonly VITE_HONEYCOMB_HIVE?: string
}
