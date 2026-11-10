import type { ContextPartKind } from '@shared/extensionPlugins/events';
import type { ContextOccupancy } from '@shared/types/agent';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/i18n';
import { openSidePanelFile } from '@/lib/sidePanelDock';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { formatTokens } from '@/stores/sessions/stats';
import { CONTEXT_BAR_WARN_PERCENT, ContextBar, SEGMENT_COLOR } from './ContextMeter';
import {
  type ContextItemTarget,
  contextBarSegments,
  contextItemLabel,
  contextItemTarget,
  contextPartItems,
} from './contextBreakdown';

const PART_LABELS: Record<ContextPartKind, string> = {
  system: 'System prompt',
  memory: 'Enabled instructions',
  tools: 'Tool definitions',
  skills: 'Enabled skills',
  files: 'Files read',
  results: 'Tool results',
  chat: 'Conversation',
};

/** 面板底部的手动压缩按钮。忙碌中也可点：worker 排队，本轮收束后自动执行。 */
function CompactButton({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const compaction = useSessionsStore((s) => s.conversations[conversationId]?.compaction);
  const started = useSessionsStore((s) => s.conversations[conversationId]?.started);
  if (!started) return null;
  const label =
    compaction === 'running'
      ? t('Compacting…')
      : compaction === 'queued'
        ? t('Compacts after this turn')
        : t('Compact context');
  return (
    <button
      type="button"
      disabled={Boolean(compaction)}
      className="w-full rounded-sm border border-border px-2 py-1 text-[11px] text-foreground/90 hover:bg-muted disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent"
      onClick={() => useSessionsStore.getState().compact(conversationId)}
    >
      {label}
    </button>
  );
}

export function ContextInspector({
  occupancy,
  conversationId,
  cwd,
  onNavigate,
}: {
  occupancy?: ContextOccupancy;
  conversationId?: string;
  /** 会话工作目录：把读入的文件换成工作区相对路径再打开 */
  cwd?: string;
  /** 打开文件或跳设置后收起面板 */
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const [highlight, setHighlight] = useState<ContextPartKind | undefined>();
  /** undefined = 还没手动点过，默认展开占用最大且有明细的一类；null = 全部收起 */
  const [open, setOpen] = useState<ContextPartKind | null | undefined>();
  if (!occupancy) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">
        {t('Context occupancy unavailable until the session starts')}
      </p>
    );
  }
  const contextWindow = occupancy.contextWindow;
  const segments = contextBarSegments(occupancy);
  const warn = (occupancy.percent ?? 0) >= CONTEXT_BAR_WARN_PERCENT;
  const largest = [...segments]
    .filter((segment) => contextPartItems(occupancy.parts, segment.kind).length > 0)
    .sort((a, b) => b.tokens - a.tokens)[0]?.kind;
  const expanded = open === undefined ? largest : open;
  return (
    <div className="flex flex-col gap-2 px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="tabular-nums">
          {formatTokens(occupancy.used)}
          {contextWindow ? ` / ${formatTokens(contextWindow)}` : ' · ?'}
          {occupancy.percent !== undefined && (
            <span className={cn(warn && 'text-warning')}>{` · ${occupancy.percent}%`}</span>
          )}
        </span>
        <span className="text-muted-foreground">{t('Estimate')}</span>
      </div>
      {segments.length > 0 && (
        <ContextBar segments={segments} highlight={highlight} className="h-1.5 w-full" />
      )}
      {warn && contextWindow !== undefined && (
        <p className="text-[11px] text-warning">
          {t('About {{tokens}} left', {
            tokens: formatTokens(Math.max(0, contextWindow - occupancy.used)),
          })}
        </p>
      )}
      {occupancy.compactionModelMismatch && (
        <p className="text-[11px] text-muted-foreground">
          {t('Current summary was produced by another model family')}
        </p>
      )}
      {occupancy.compactedMessageCount > 0 && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <p>
            {t('{{count}} older messages are folded into the summary', {
              count: occupancy.compactedMessageCount,
            })}
          </p>
          {conversationId && occupancy.compactionEntryId && (
            <button
              type="button"
              className="shrink-0 text-foreground/80 hover:underline"
              onClick={() => {
                void useSessionsStore
                  .getState()
                  .forkFromEntry(conversationId, occupancy.compactionEntryId!);
              }}
            >
              {t('Conversation branch')}
            </button>
          )}
        </div>
      )}
      <ul className="flex flex-col gap-1" onMouseLeave={() => setHighlight(undefined)}>
        {segments.map(({ kind, tokens }) => {
          const share = occupancy.used > 0 ? Math.round((tokens / occupancy.used) * 100) : 0;
          const items = contextPartItems(occupancy.parts, kind);
          const isOpen = expanded === kind && items.length > 0;
          return (
            <li key={kind} onMouseEnter={() => setHighlight(kind)}>
              <button
                type="button"
                disabled={items.length === 0}
                aria-expanded={items.length > 0 ? isOpen : undefined}
                onClick={() => setOpen(isOpen ? null : kind)}
                className="flex w-full items-center gap-1.5 rounded-sm text-left text-[11px] enabled:hover:bg-muted/60"
              >
                <ChevronRight
                  className={cn(
                    'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                    isOpen && 'rotate-90',
                    items.length === 0 && 'invisible'
                  )}
                />
                <span className="w-24 shrink-0 truncate text-muted-foreground">
                  {t(PART_LABELS[kind])}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block h-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn('block h-full', SEGMENT_COLOR[kind])}
                      style={{ width: `${share}%` }}
                    />
                  </span>
                </span>
                <span className="w-10 shrink-0 text-right tabular-nums">
                  {formatTokens(tokens)}
                </span>
                <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">
                  {share}%
                </span>
              </button>
              {isOpen && (
                <ul className="mt-0.5 ml-1.5 flex flex-col gap-0.5 border-l border-border pl-2">
                  {items.map((item) => {
                    const label = contextItemLabel(item);
                    const target = contextItemTarget(kind, item, cwd);
                    const go = (to: ContextItemTarget) => {
                      if (to.type === 'file') {
                        if (!conversationId) return;
                        openSidePanelFile(conversationId, to.rel);
                      } else {
                        void window.electronAPI.window.openSettings(to.link);
                      }
                      onNavigate?.();
                    };
                    return (
                      <li
                        key={`${item.tag}-${item.name}`}
                        className="group/item flex items-center gap-2 rounded-sm text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      >
                        {'raw' in label ? (
                          <span className="min-w-0 flex-1 truncate font-mono" title={label.raw}>
                            {label.raw}
                          </span>
                        ) : (
                          <span className="min-w-0 flex-1 truncate">
                            {t(label.key, label.vars)}
                          </span>
                        )}
                        {target && (target.type === 'settings' || conversationId) ? (
                          <button
                            type="button"
                            onClick={() => go(target)}
                            className="hidden shrink-0 rounded-sm border border-border bg-background px-1.5 text-[10px] leading-4 text-muted-foreground hover:text-foreground group-hover/item:block focus-visible:block"
                          >
                            {t(target.type === 'file' ? 'Open' : 'Settings')}
                          </button>
                        ) : null}
                        <span
                          className={cn(
                            'shrink-0 tabular-nums',
                            target && 'group-hover/item:hidden'
                          )}
                        >
                          {formatTokens(item.tokens)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {conversationId && <CompactButton conversationId={conversationId} />}
    </div>
  );
}
