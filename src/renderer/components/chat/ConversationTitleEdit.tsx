import * as React from 'react';
import { cn } from '@/lib/utils';

/** 会话标题行内编辑：Enter 提交、Esc 取消、失焦提交；空值视为取消。 */
export function ConversationTitleEdit({
  title,
  className,
  onCommit,
  onCancel,
}: {
  title: string;
  className?: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState(title);
  const commit = () => {
    const next = draft.trim();
    if (!next || next === title) onCancel();
    else onCommit(next);
  };
  return (
    <input
      className={cn(
        'min-w-0 flex-1 rounded bg-transparent px-0.5 text-inherit outline-none ring-1 ring-ring',
        className
      )}
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}
