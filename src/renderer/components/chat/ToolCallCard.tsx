import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/i18n';
import {
  aggregateState,
  presentToolCalls,
  type ToolCallInput,
  type ToolCardBlock,
  type ToolCardLookup,
  type ToolCardStatus,
  type ToolCardView,
} from '@/lib/toolCards';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { Markdown } from './Markdown';
import { StepDot } from './StepNode';

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

function useToolCardLookup(): ToolCardLookup {
  const conversations = useSessionsStore((state) => state.conversations);
  const projects = useSettingsStore((state) => state.projects);
  const todos = useSecretaryStore((state) => state.secretary.board.todos);
  const proposals = useSecretaryStore((state) => state.secretary.proposals);
  return {
    sessionTitle(id) {
      const title = conversations[id]?.title?.trim();
      return title || undefined;
    },
    projectName(id) {
      const project = projects.find((item) => item.id === id);
      const name = project?.alias?.trim() || project?.name?.trim();
      return name || undefined;
    },
    todoText(id) {
      return todos.find((todo) => todo.id === id)?.text;
    },
    proposal(id) {
      const proposal = proposals[id];
      return proposal ? { status: proposal.status, kind: proposal.kind } : undefined;
    },
  };
}

function callsOf(item: ToolItem): ToolCallInput[] {
  const peers = item.cardPeers ?? [];
  return [
    { name: item.name, args: item.args ?? null, output: item.output, state: item.state },
    ...peers.map((peer) => ({
      name: item.name,
      args: peer.args ?? null,
      output: peer.output,
      state: peer.state,
    })),
  ];
}

export function ToolCallCards({ item }: { item: ToolItem }) {
  const { t, locale } = useI18n();
  const lookup = useToolCardLookup();
  const selectConversation = useSessionsStore((state) => state.selectConversation);
  const knownSessions = useSessionsStore((state) => state.conversations);
  const present = presentToolCalls(callsOf(item), {
    t,
    locale: locale === 'zh' ? 'zh' : 'en',
    lookup,
  });
  const state = aggregateState(present.cards.map((card) => card.state));
  // 和普通工具行一样默认收成一行，点开才看详情
  const [open, setOpen] = useState(false);
  const single = present.grouped ? null : (present.cards[0] ?? null);
  return (
    <div
      data-enso="tool-card"
      data-tool={item.name}
      data-open={open ? 'true' : 'false'}
      data-grouped={present.grouped ? 'true' : 'false'}
      data-count={present.cards.length}
      className="my-0.5 w-full min-w-0 text-[13px]"
    >
      <button
        type="button"
        data-enso="tool-card-expand"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group/step flex min-h-6 w-full min-w-0 items-center gap-2 text-left text-[13px] text-muted-foreground"
      >
        <StepDot state={state} />
        <span className="min-w-0 flex-1 truncate">
          {present.grouped ? present.title : single?.title}
        </span>
        {single?.status ? <StatusBadge status={single.status} /> : null}
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/step:opacity-100',
            open && 'rotate-90 opacity-100'
          )}
        />
      </button>
      {open && present.grouped
        ? present.cards.map((card, index) => (
            <NestedCard
              // biome-ignore lint/suspicious/noArrayIndexKey: 卡片顺序随这一次调用快照整体替换
              key={`${card.title}-${index}`}
              card={card}
              known={knownSessions}
              onOpen={selectConversation}
            />
          ))
        : null}
      {open && single ? (
        <CardDetails card={single} known={knownSessions} onOpen={selectConversation} />
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: ToolCardStatus }) {
  return (
    <span
      data-enso="tool-card-status"
      data-tone={status.tone}
      className={cn(
        'shrink-0 rounded px-1 py-px text-[10px]',
        status.tone === 'error' && 'bg-destructive/15 text-destructive',
        status.tone === 'ok' && 'bg-success/15 text-success',
        (status.tone === 'queued' || status.tone === 'pending') && 'bg-warning/15 text-warning',
        status.tone === 'neutral' && 'bg-muted text-muted-foreground'
      )}
    >
      {status.label}
    </span>
  );
}

function NestedCard({
  card,
  known,
  onOpen,
}: {
  card: ToolCardView;
  known: Record<string, { title?: string } | undefined>;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pl-5">
      <button
        type="button"
        data-enso="tool-card-expand"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group/step flex min-h-6 w-full min-w-0 items-center gap-2 text-left text-[13px] text-muted-foreground"
      >
        <span className="min-w-0 flex-1 truncate">{card.title}</span>
        {card.status ? <StatusBadge status={card.status} /> : null}
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/step:opacity-100',
            open && 'rotate-90 opacity-100'
          )}
        />
      </button>
      {open ? <CardDetails card={card} known={known} onOpen={onOpen} /> : null}
    </div>
  );
}

function CardDetails({
  card,
  known,
  onOpen,
}: {
  card: ToolCardView;
  known: Record<string, { title?: string } | undefined>;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const [raw, setRaw] = useState(false);
  return (
    <div data-enso="tool-card-body" className="space-y-1 py-0.5 pl-5 text-[12px]">
      <div className="space-y-1">
        {card.blocks.map((block, index) => (
          <Block
            // biome-ignore lint/suspicious/noArrayIndexKey: 块顺序随工具结果整体替换
            key={`${block.kind}-${index}`}
            block={block}
            known={known}
            onOpen={onOpen}
          />
        ))}
      </div>
      <button
        type="button"
        data-enso="tool-card-raw"
        aria-expanded={raw}
        onClick={() => setRaw((value) => !value)}
        className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {t('View raw data')}
      </button>
      {raw && (
        <div className="mt-1 space-y-1">
          {card.rawArgs && (
            <pre className="overflow-auto font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {card.rawArgs}
            </pre>
          )}
          {card.rawOutput && (
            <pre className="overflow-auto font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {card.rawOutput}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function Block({
  block,
  known,
  onOpen,
}: {
  block: ToolCardBlock;
  known: Record<string, { title?: string } | undefined>;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  if (block.kind === 'error') {
    return (
      <p className="rounded-md bg-destructive/10 px-2 py-1 text-destructive text-xs whitespace-pre-wrap">
        {block.text}
      </p>
    );
  }
  if (block.kind === 'note') {
    return <p className="whitespace-pre-wrap text-xs">{block.text}</p>;
  }
  if (block.kind === 'markdown') {
    const collapsed = block.collapsed && !opened;
    return (
      <div className="text-sm">
        {collapsed ? (
          <p className="truncate text-xs text-muted-foreground">
            {block.text.split('\n').find((line) => line.trim())}
          </p>
        ) : (
          <Markdown text={block.text} />
        )}
        {block.collapsed && (
          <button
            type="button"
            data-enso="tool-card-fold"
            onClick={() => setOpened((value) => !value)}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            {opened ? t('Show less') : t('Show more')}
          </button>
        )}
      </div>
    );
  }
  if (block.kind === 'image') {
    return (
      <img
        data-enso="tool-card-image"
        src={block.src}
        alt={block.alt ?? ''}
        loading="lazy"
        className="max-h-64 max-w-full rounded border border-border/60 object-contain"
      />
    );
  }
  if (block.kind === 'session') {
    if (!known[block.id]) return <p className="text-xs">{block.label}</p>;
    return (
      <button
        type="button"
        data-enso="tool-card-session"
        data-conversation-id={block.id}
        onClick={() => onOpen(block.id)}
        className="truncate text-left text-xs text-foreground underline-offset-2 hover:underline"
      >
        {block.label}
      </button>
    );
  }
  if (block.kind === 'kv') {
    return (
      <dl className="space-y-0.5 text-xs">
        {block.rows.map((row) => (
          <div key={row.label} className="flex min-w-0 gap-2">
            <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (block.kind === 'diff') {
    return (
      <div className="space-y-0.5 text-xs">
        {block.rows.map((row) => (
          <p key={row.label} className="min-w-0 break-words">
            <span className="text-muted-foreground">{row.label} </span>
            <span className="text-muted-foreground line-through">{row.before}</span>
            <span> → {row.after}</span>
          </p>
        ))}
      </div>
    );
  }
  if (block.kind !== 'list') return null;
  return (
    <ul className="space-y-0.5">
      {block.items.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 列表顺序随工具结果整体替换
        <li key={`${row.title}-${index}`} className="flex min-w-0 items-baseline gap-1.5 text-xs">
          {row.sessionId && known[row.sessionId] ? (
            <button
              type="button"
              data-enso="tool-card-session"
              data-conversation-id={row.sessionId}
              onClick={() => onOpen(row.sessionId as string)}
              className="min-w-0 truncate text-left hover:underline"
            >
              {row.title}
            </button>
          ) : (
            <span className="min-w-0 truncate">{row.title}</span>
          )}
          {row.badge && (
            <span
              data-enso="tool-card-badge"
              data-tone={row.badgeTone}
              className={cn(
                'shrink-0 rounded px-1 py-px text-[10px]',
                row.badgeTone === 'error' && 'bg-destructive/15 text-destructive',
                row.badgeTone === 'ok' && 'bg-success/15 text-success',
                row.badgeTone === 'pending' && 'bg-warning/15 text-warning',
                (!row.badgeTone || row.badgeTone === 'neutral' || row.badgeTone === 'queued') &&
                  'bg-muted text-muted-foreground'
              )}
            >
              {row.badge}
            </span>
          )}
          {row.detail && (
            <span className="min-w-0 truncate text-muted-foreground">{row.detail}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
