import type { MemoryDetail, MemoryListItem } from '@shared/memory/dto';
import { Lock } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useState } from 'react';
import {
  MemoryDeleteDialog,
  MemoryEditDialog,
  MemoryRowActions,
} from '@/components/memory/MemoryActionDialogs';
import { HOVER_ROW_CLASS } from '@/components/ui/hover-actions';
import { useI18n } from '@/i18n';
import { secretarySpaceId } from '@/lib/secretarySpace';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';

const PAGE = 50;
const OTHER_LIMIT = 10;

function MemoryRow({
  item,
  onOpen,
  onEdit,
  onDelete,
  trailing,
  children,
}: {
  item: MemoryListItem;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  trailing: React.ReactNode;
  /** 展开的详情，紧贴在这一行下面 */
  children?: React.ReactNode;
}) {
  return (
    <div data-enso="secretary-memory-row" data-memory-id={item.id} className="flex flex-col">
      <div className={cn(HOVER_ROW_CLASS, 'w-full rounded-lg px-1.5 py-2')}>
        <button
          type="button"
          data-enso="secretary-memory-open"
          onClick={() => onOpen(item.id)}
          className="block w-full min-w-0 text-left"
        >
          <span className="flex w-full min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 truncate text-[13px]">{item.title}</span>
            <span className="shrink-0 text-[11.5px] text-subtle-foreground">{trailing}</span>
          </span>
          {item.contentSummary && (
            <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted-foreground">
              {item.contentSummary}
            </span>
          )}
        </button>
        <MemoryRowActions id={item.id} onEdit={onEdit} onDelete={onDelete} />
      </div>
      {children}
    </div>
  );
}

/**
 * 记忆面板：每行悬停浮出编辑 / 删除，和设置页记忆库走同一套接口（删除先预览影响再确认）。
 * 「来自你的项目」是秘书只读的项目记忆，用户自己仍可以改删。
 */
export function SecretaryMemoryPanel({ secretaryId }: { secretaryId?: string } = {}) {
  const { t, locale } = useI18n();
  const ownState = useSecretaryStore((s) => (secretaryId ? s.states[secretaryId] : s.secretary));
  const projectId = ownState?.projectId ?? null;
  const name = ownState?.profile?.name.trim() || t('Secretary');
  const spaceId = projectId ? secretarySpaceId(projectId) : null;
  const [own, setOwn] = useState<MemoryListItem[]>([]);
  const [others, setOthers] = useState<MemoryListItem[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);

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

  const row = (item: MemoryListItem, trailing: React.ReactNode, readOnly: boolean) => (
    <MemoryRow
      key={item.id}
      item={item}
      trailing={trailing}
      onOpen={(id) => setOpenId(openId === id ? null : id)}
      onEdit={setEditId}
      onDelete={(id) => setDeleteIds([id])}
    >
      {openId === item.id && (
        <MemoryDetailPane id={item.id} readOnly={readOnly} onClose={() => setOpenId(null)} />
      )}
    </MemoryRow>
  );

  return (
    <div data-enso="secretary-memory" className="flex w-full flex-col gap-2 px-3 py-3">
      <section className="flex w-full flex-col">
        <h3 className="px-1.5 pb-1 text-[12px] text-subtle-foreground">
          {t('{{name}} remembers', { name })}
          {own.length > 0 && <span className="ml-1 tabular-nums">{own.length}</span>}
        </h3>
        {own.length === 0 ? (
          <p className="px-1.5 py-2 text-[12px] text-muted-foreground">
            {t('The secretary has not saved anything yet.')}
          </p>
        ) : (
          own.map((item) =>
            row(item, formatRelativeTime(Date.parse(item.updatedAt), locale), false)
          )
        )}
      </section>
      {others.length > 0 && (
        <section className="flex w-full flex-col">
          <h3 className="flex items-center gap-1.5 px-1.5 pb-0.5 text-[12px] text-subtle-foreground">
            {t('From your projects')}
            <Lock className="size-3" />
          </h3>
          <p className="px-1.5 pb-1 text-[11.5px] text-subtle-foreground">
            {t('{{name}} can read these but not change them', { name })}
          </p>
          {others.map((item) => row(item, item.spaceLabel, true))}
        </section>
      )}
      <MemoryEditDialog memoryId={editId} onClose={() => setEditId(null)} />
      <MemoryDeleteDialog
        ids={deleteIds}
        onClose={() => setDeleteIds(null)}
        onDeleted={(ids) => {
          if (openId && ids.includes(openId)) setOpenId(null);
        }}
      />
    </div>
  );
}

/** 点开一行看完整正文；编辑删除在行尾，这里只留归档 */
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.electronAPI.memory.detail(id).then((result) => {
      if (alive && result) setDetail(result);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  const archive = () => {
    setBusy(true);
    void window.electronAPI.memory.archive(id).finally(() => {
      setBusy(false);
      onClose();
    });
  };

  return (
    <div
      data-enso="secretary-memory-detail"
      className="mx-1.5 mb-1 rounded-lg border border-border px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          {detail?.spaceLabel ?? ''}
        </span>
        {!readOnly && (
          <button
            type="button"
            disabled={busy}
            onClick={archive}
            className="rounded-md px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {t('Archive')}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t('Close')}
        </button>
      </div>
      <pre className="mt-1 max-h-64 overflow-auto text-[12px] whitespace-pre-wrap text-muted-foreground">
        {detail?.content}
      </pre>
    </div>
  );
}
