import { Check, Pencil, Send, X } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/i18n';
import type { QueuedMessage } from '@/stores/sessions';
import { useSessionsStore } from '@/stores/sessions';

/**
 * 排队消息区(grok build 形态):agent 干活时用户消息先入队,显示在输入框上方;
 * 每条可编辑/删除/立即发送(steer 插入当前轮);轮次结束后剩余的自动合并投递。
 */
export function MessageQueue({
  conversationId,
  queued,
}: {
  conversationId: string;
  queued: QueuedMessage[];
}) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  if (queued.length === 0) return null;

  const saveEdit = (messageId: string) => {
    if (draft.trim()) {
      useSessionsStore.getState().updateQueuedMessage(conversationId, messageId, draft.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="mb-1 flex flex-col gap-0.5">
      {queued.map((message) => (
        <div
          key={message.id}
          className="group flex items-center gap-2 rounded-lg border border-border/60 border-dashed bg-muted/20 px-2.5 py-1.5 text-xs"
        >
          <span className="shrink-0 text-[10px] text-muted-foreground uppercase tracking-wide">
            {t('Queued')}
          </span>
          {editingId === message.id ? (
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') saveEdit(message.id);
                if (e.key === 'Escape') setEditingId(null);
              }}
              // biome-ignore lint/a11y/noAutofocus: 进入编辑态即聚焦是预期交互
              autoFocus
              className="h-6 min-w-0 flex-1 rounded border bg-transparent px-1.5 outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{message.text || '[image]'}</span>
          )}
          {editingId === message.id ? (
            <button
              type="button"
              onClick={() => saveEdit(message.id)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
          ) : (
            <div className="pointer-events-none flex shrink-0 items-center gap-0.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100">
              <button
                type="button"
                title={t('Edit')}
                onClick={() => {
                  setEditingId(message.id);
                  setDraft(message.text);
                }}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                title={t('Send now')}
                onClick={() =>
                  useSessionsStore.getState().sendQueuedNow(conversationId, message.id)
                }
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <Send className="h-3 w-3" />
              </button>
              <button
                type="button"
                title={t('Remove')}
                onClick={() =>
                  useSessionsStore.getState().removeQueuedMessage(conversationId, message.id)
                }
                className="rounded p-0.5 text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
