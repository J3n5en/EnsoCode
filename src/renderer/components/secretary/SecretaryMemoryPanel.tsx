import type { MemoryDetail, MemoryListItem } from '@shared/memory/dto';
import { useEffect, useState } from 'react';
import { MemoryRows } from '@/components/settings/MemoryLibrary';
import { useI18n } from '@/i18n';
import { secretarySpaceId } from '@/lib/secretarySpace';
import { useSecretaryStore } from '@/stores/secretary';

const PAGE = 50;
const OTHER_LIMIT = 10;

/** 记忆面板：私有空间可编辑删除，其他空间只读展示来源项目 */
export function SecretaryMemoryPanel() {
  const { t } = useI18n();
  const projectId = useSecretaryStore((s) => s.secretary.projectId);
  const spaceId = projectId ? secretarySpaceId(projectId) : null;
  const [own, setOwn] = useState<MemoryListItem[]>([]);
  const [others, setOthers] = useState<MemoryListItem[]>([]);
  const [detail, setDetail] = useState<{ id: string; readOnly: boolean } | null>(null);

  useEffect(() => {
    if (!spaceId) return;
    let alive = true;
    const load = () => {
      void window.electronAPI.memory
        .list({ spaceId, limit: PAGE, offset: 0 })
        .then((result) => alive && setOwn(result.items));
      // 其他空间只读：秘书检索到的项目记忆，这里按来源项目展示，不给编辑入口
      void window.electronAPI.memory.list({ limit: PAGE, offset: 0 }).then((result) => {
        if (!alive) return;
        setOthers(result.items.filter((item) => item.spaceId !== spaceId).slice(0, OTHER_LIMIT));
      });
    };
    load();
    // Main 在任何写入后广播（包括秘书通过工具写的），比靠组件树传 revision 可靠
    const off = window.electronAPI.memory.onChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [spaceId]);

  return (
    <div
      data-enso="secretary-memory"
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-2 py-2"
    >
      <section>
        <h3 className="px-1 py-1 text-[0.8214rem] font-medium text-subtle-foreground">
          {t('Secretary memory')}
        </h3>
        <MemoryRows
          items={own}
          t={t}
          emptyLabel={t('The secretary has not saved anything yet.')}
          onOpen={(id) => setDetail({ id, readOnly: false })}
        />
      </section>
      {others.length > 0 && (
        <section>
          <h3 className="px-1 py-1 text-[0.8214rem] font-medium text-subtle-foreground">
            {t('From your projects (read-only)')}
          </h3>
          <MemoryRows items={others} t={t} onOpen={(id) => setDetail({ id, readOnly: true })} />
        </section>
      )}
      {detail && (
        <MemoryDetailPane
          id={detail.id}
          readOnly={detail.readOnly}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function MemoryDetailPane({
  id,
  readOnly,
  onClose,
}: {
  id: string;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.electronAPI.memory.detail(id).then((result) => {
      if (!alive || !result) return;
      setDetail(result);
      setTitle(result.title);
      setContent(result.content);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  const run = (action: Promise<{ ok: boolean }>) => {
    setBusy(true);
    void action.finally(() => {
      setBusy(false);
      onClose();
    });
  };

  return (
    <div
      data-enso="secretary-memory-detail"
      className="rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs">{detail?.spaceLabel ?? ''}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t('Close')}
        </button>
      </div>
      {readOnly ? (
        <>
          <p className="mt-1 text-xs font-medium">{detail?.title}</p>
          <pre className="mt-1 max-h-64 overflow-auto text-[11px] whitespace-pre-wrap text-muted-foreground">
            {detail?.content}
          </pre>
        </>
      ) : (
        <>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-1 w-full bg-transparent text-xs font-medium outline-none"
          />
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="mt-1 max-h-64 min-h-24 w-full resize-y bg-transparent text-[11px] outline-none"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy || !content.trim()}
              onClick={() => run(window.electronAPI.memory.update(id, { title, content }))}
              className="rounded-md bg-primary px-2.5 py-1 text-[11px] text-primary-foreground disabled:opacity-50"
            >
              {t('Save')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(window.electronAPI.memory.archive(id))}
              className="rounded-md px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t('Archive')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(window.electronAPI.memory.delete(id))}
              className="rounded-md px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-destructive"
            >
              {t('Delete')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
