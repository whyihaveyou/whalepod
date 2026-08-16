// ============================================================
// NewTaskModal — 新建任务（⌘N）
// ============================================================

import { useEffect, useState } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { TextInput } from "../common/TextInput";

export function NewTaskModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (open) setTitle("");
  }, [open]);

  const submit = async () => {
    if (!title.trim()) return;
    await onCreate(title.trim());
    onClose();
  };

  return (
    <Modal
      open={open}
      title="新建任务"
      subtitle="创建后出现在任务板「待处理」列"
      width="confirm"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!title.trim()} onClick={submit}>
            创建 <kbd className="kbd kbd-dark">⌘↵</kbd>
          </Button>
        </>
      }
    >
      <div className="newtask-body">
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="任务标题，例如：实现登录页"
          aria-label="任务标题"
        />
        <p className="newtask-hint">⌘↵ 快速创建</p>
      </div>
    </Modal>
  );
}
