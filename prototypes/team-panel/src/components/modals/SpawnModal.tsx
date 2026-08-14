// ============================================================
// SpawnModal — 扩编模态（interaction §6 / modals.md 560px）
// 模板卡片网格 → 名称自动建议（重名内联校验）→ 初始任务 → 高级折叠
// 提交即关模态（乐观），roster 顶部出现 spawning 条目；
// 失败由调用方 toast[重试] 回填重开（表单状态在关闭后保留）。
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { TextInput } from "../common/TextInput";
import { useTemplates } from "../../hooks/useTeamStore";
import { IconChevronDown, IconSpark } from "../../lib/icons";
import { existingNameCount } from "../../services/mockApi";

export function SpawnModal({
  open,
  onClose,
  existingNames = [],
  onSpawn,
}: {
  open: boolean;
  onClose: () => void;
  /** 现有成员名（重名校验） */
  existingNames?: string[];
  onSpawn: (templateId: string, name: string, initialTask?: string) => Promise<void>;
}) {
  const templates = useTemplates();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [initialTask, setInitialTask] = useState("");
  const [advanced, setAdvanced] = useState(false);

  const sel = templates.find((t) => t.id === selected) ?? null;

  // 选择模板 → 自动建议名称（模板名 + 序号）
  useEffect(() => {
    if (sel) {
      const next = (existingNameCount[sel.name] ?? 0) + 1;
      setName(`${sel.name}-${next}`);
    }
  }, [sel]);

  const nameError = useMemo(() => {
    const n = name.trim();
    if (n && existingNames.includes(n)) return `名称「${n}」已存在，请换一个`;
    return undefined;
  }, [name, existingNames]);

  const nameSuggest = useMemo(
    () =>
      sel && name.startsWith(sel.name)
        ? `将命名为 ${name}（${sel.model}）`
        : sel
          ? `可修改名称，默认 ${sel.name}-${(existingNameCount[sel.name] ?? 0) + 1}`
          : null,
    [sel, name],
  );

  const reset = () => {
    setSelected(null);
    setName("");
    setInitialTask("");
    setAdvanced(false);
  };

  // 乐观提交：立即关模态，spawning 条目由 store 插入；
  // 失败时表单状态保留，toast[重试] 重新打开本模态
  const submit = () => {
    if (!sel || !name.trim() || nameError) return;
    onClose();
    onSpawn(sel.id, name.trim(), initialTask.trim()).then(
      () => reset(),
      () => {},
    );
  };

  return (
    <Modal
      open={open}
      title="扩编新成员"
      subtitle="选择模板，将按模板模型与能力生成一名 teammate"
      width="spawn"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={!sel || !name.trim() || !!nameError}
            onClick={submit}
          >
            Spawn {sel && `· ${sel.model}`} <kbd className="kbd kbd-dark">⌘↵</kbd>
          </Button>
        </>
      }
    >
      <div className="spawn-body">
        <p className="spawn-label">1 · 选择模板</p>
        <div className="spawn-grid">
          {templates.map((t) => (
            <button
              key={t.id}
              className={`spawn-tpl ${selected === t.id ? "spawn-tpl-selected" : ""}`}
              onClick={() => setSelected(t.id)}
              aria-pressed={selected === t.id}
            >
              <span className="spawn-tpl-head">
                <IconSpark size={13} />
                <span className="spawn-tpl-name">{t.name}</span>
              </span>
              <span className="spawn-tpl-model">{t.model}</span>
              <span className="spawn-tpl-desc">{t.description}</span>
              <span className="spawn-tpl-skills">{t.skills.join(" · ")}</span>
            </button>
          ))}
        </div>

        <p className="spawn-label">2 · 名称（自动建议）</p>
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="成员名称"
          disabled={!sel}
          aria-label="成员名称"
          errorText={nameError}
        />
        {!nameError && nameSuggest && <p className="spawn-hint">{nameSuggest}</p>}

        <p className="spawn-label">3 · 初始任务 <span className="spawn-optional">（可选）</span></p>
        <TextInput
          value={initialTask}
          onChange={(e) => setInitialTask(e.target.value)}
          placeholder="例如：评审 #019ffff4 的 UI 原型"
          disabled={!sel}
          aria-label="初始任务"
        />
        {initialTask.trim() && (
          <p className="spawn-hint spawn-hint-info">
            💡 上线后将自动创建任务并指派给 {name}
          </p>
        )}

        <button className="spawn-advanced-toggle" onClick={() => setAdvanced(!advanced)}>
          高级配置 <IconChevronDown size={13} className={advanced ? "rot180" : ""} />
        </button>
        {advanced && sel && (
          <div className="spawn-advanced">
            <p><span className="spawn-adv-label">MCP</span> {sel.mcp.join("、") || "无"}</p>
            <p><span className="spawn-adv-label">Skills</span> {sel.skills.join("、")}</p>
            <p className="spawn-adv-note">原型阶段高级配置为模板只读信息，接入真实 API 后支持覆盖。</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
