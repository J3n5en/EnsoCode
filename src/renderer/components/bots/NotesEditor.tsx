import type { BotNotesInfo } from '@shared/types/botIpc';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';

type NotesTarget = { botId: string } | { chatId: string };

/** 成员 / 群核心笔记：自动整理生成，可手动编辑；保存带 version，被并发更新时提示并重新加载 */
export function NotesEditor({ target, emptyText }: { target: NotesTarget; emptyText: string }) {
  const { t } = useI18n();
  const botId = 'botId' in target ? target.botId : undefined;
  const chatId = 'chatId' in target ? target.chatId : undefined;
  const [notes, setNotes] = useState<BotNotesInfo | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = useRef(false);
  editing.current = draft !== null;

  const load = useCallback(async () => {
    const result = await window.electronAPI.bots.notes.get(
      botId ? { botId } : { chatId: chatId ?? '' }
    );
    if (result.ok) setNotes(result.notes);
  }, [botId, chatId]);

  useEffect(() => {
    setNotes(null);
    setDraft(null);
    void load();
    return window.electronAPI.bots.onEvent((event) => {
      if (event.kind !== 'notes' || editing.current) return;
      if (botId ? !event.chatId : event.chatId === chatId) void load();
    });
  }, [load, botId, chatId]);

  const save = async () => {
    if (!notes || draft === null) return;
    setSaving(true);
    const result = await window.electronAPI.bots.notes.save({
      ...(botId ? { botId } : { chatId: chatId ?? '' }),
      content: draft,
      version: notes.version,
    });
    setSaving(false);
    if (result.ok) {
      setNotes(result.notes);
      setDraft(null);
      return;
    }
    addToast({
      type: 'error',
      title:
        result.error === 'conflict'
          ? t('Notes were updated elsewhere; reloaded the latest version')
          : t('Save failed'),
    });
    if (result.error === 'conflict') {
      setDraft(null);
      void load();
    }
  };

  if (!notes) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (draft !== null)
    return (
      <div className="space-y-1.5">
        <Textarea
          rows={8}
          value={draft}
          maxLength={notes.maxChars}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex items-center gap-1.5">
          <span className="mr-auto text-muted-foreground text-xs">
            {draft.length} / {notes.maxChars}
          </span>
          <Button size="xs" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
            {t('Cancel')}
          </Button>
          <Button size="xs" disabled={saving} onClick={() => void save()}>
            {t('Save')}
          </Button>
        </div>
      </div>
    );
  return (
    <div className="group space-y-1.5">
      {notes.content ? (
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-card px-2.5 py-2 text-xs">
          {notes.content}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{emptyText}</p>
      )}
      <Button size="xs" variant="outline" onClick={() => setDraft(notes.content)}>
        {t('Edit notes')}
      </Button>
    </div>
  );
}
