// ============================================================
// TextInput — inputs-composer.md 规范
// 高度 32px，focused 外发光，disabled 状态，图标槽位；
// errorText：下方 4px 渲染 danger 文案（role="alert"），
// 输入框联动 aria-invalid + aria-describedby。
// ============================================================

import { useId, type InputHTMLAttributes, type ReactNode } from "react";

export function TextInput({
  icon,
  error,
  errorText,
  className = "",
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  icon?: ReactNode;
  error?: boolean;
  /** 内联错误文案（展示即视为 error 态） */
  errorText?: string;
}) {
  const autoId = useId();
  const errId = `${autoId}-err`;
  const hasError = !!errorText || !!error;
  return (
    <div className={`text-input-wrap ${hasError ? "input-error" : ""} ${className}`}>
      {icon && <span className="input-icon">{icon}</span>}
      <input
        id={id}
        className="text-input"
        aria-invalid={hasError || undefined}
        aria-describedby={errorText ? errId : undefined}
        {...rest}
      />
      {errorText && (
        <p className="input-error-text" id={errId} role="alert">
          {errorText}
        </p>
      )}
    </div>
  );
}

/** 搜索框变体（roster 顶部） */
export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel = "筛选成员",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <div className="search-wrap">
      <svg
        className="search-icon"
        width="13" height="13" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
        aria-hidden
      >
        <circle cx="7" cy="7" r="4.2" />
        <path d="M10.2 10.2L13.5 13.5" />
      </svg>
      <input
        className="search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "搜索成员 / 任务 / 消息…"}
        aria-label={ariaLabel}
      />
      {value && (
        <button className="search-clear" aria-label="清空" onClick={() => onChange("")}>
          ✕
        </button>
      )}
    </div>
  );
}
