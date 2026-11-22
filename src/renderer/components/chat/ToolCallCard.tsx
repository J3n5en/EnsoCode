import { ChevronRight } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
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
import { openSessionFromSecretary } from '@/stores/secretaryReturn';
import { useSessionsStore } from '@/stores/sessions';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';
import { StepDot } from './StepNode';
import { ToolImagePreview } from './ToolImagePreview';

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
    {
      name: item.name,
      args: item.args ?? null,
      output: item.output,
      state: item.state,
      ...(item.image ? { image: item.image } : {}),
    },
    ...peers.map((peer) => ({
      name: item.name,
      args: peer.args ?? null,
      output: peer.output,
      state: peer.state,
      ...(peer.image ? { image: peer.image } : {}),
    })),
  ];
}

/**
 * framed：展开后的详情收进卡片自己的边框，和外面的聊天正文分开。
 * 由调用方按显式传入的会话类型决定，只给秘书会话开。
 */
export function ToolCallCards({ item, framed = false }: { item: ToolItem; framed?: boolean }) {
  const { t, locale } = useI18n();
  const lookup = useToolCardLookup();
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
              onOpen={openSessionFromSecretary}
              framed={framed}
            />
          ))
        : null}
      {open && single ? (
        <CardDetails
          card={single}
          known={knownSessions}
          onOpen={openSessionFromSecretary}
          framed={framed}
        />
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
  framed,
}: {
  card: ToolCardView;
  known: Record<string, { title?: string } | undefined>;
  onOpen: (id: string) => void;
  framed: boolean;
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
      {open ? (
        <CardDetails card={card} known={known} onOpen={onOpen} framed={framed} nested />
      ) : null}
    </div>
  );
}

function CardDetails({
  card,
  known,
  onOpen,
  framed,
  nested = false,
}: {
  card: ToolCardView;
  known: Record<string, { title?: string } | undefined>;
  onOpen: (id: string) => void;
  framed: boolean;
  nested?: boolean;
}) {
  const { t } = useI18n();
  const [raw, setRaw] = useState(false);
  const rawToggle = (
    <button
      type="button"
      data-enso="tool-card-raw"
      aria-expanded={raw}
      onClick={() => setRaw((value) => !value)}
      className="text-[11px] text-muted-foreground hover:text-foreground"
    >
      {t('View raw data')}
    </button>
  );
  const rawBody = raw ? (
    <div className={cn('mt-1 space-y-1', framed && 'max-h-60 overflow-auto')}>
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
  ) : null;
  const renderBlock = (block: ToolCardBlock, index: number) => (
    <Block key={`${block.kind}-${index}`} block={block} known={known} onOpen={onOpen} />
  );
  if (framed) {
    // 与普通工具行展开详情（tool-details）同一外框，不加 shadow-xs；
    // 字段一段，指令像命令输出一样另起一段，段间细线分隔
    const sections: { prompt: boolean; blocks: [ToolCardBlock, number][] }[] = [];
    card.blocks.forEach((block, index) => {
      const prompt = block.kind === 'prompt';
      const last = sections.at(-1);
      if (!prompt && last && !last.prompt) last.blocks.push([block, index]);
      else sections.push({ prompt, blocks: [[block, index]] });
    });
    // 「查看原始数据」跟在最后一段字段后面；最后是指令段或没有内容时单起一段
    const tail = sections.at(-1);
    const footer = !tail || tail.prompt;
    const rawSection = (
      <div>
        {rawToggle}
        {rawBody}
      </div>
    );
    return (
      <div
        data-enso="tool-card-body"
        data-framed="true"
        className={cn(
          'mt-1 mb-1.5 min-w-0 overflow-hidden rounded-lg border border-border/70 bg-card text-[12px]',
          !nested && 'ml-5'
        )}
      >
        {sections.map((section, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 分段顺序随工具结果整体替换
            key={index}
            className={cn(
              'min-w-0',
              index > 0 && 'border-t border-border/60',
              !section.prompt && 'space-y-1.5 px-3 py-2'
            )}
          >
            {section.blocks.map(([block, at]) =>
              block.kind === 'prompt' ? (
                <PromptBlock key={at} label={block.label} text={block.text} />
              ) : (
                renderBlock(block, at)
              )
            )}
            {!footer && section === tail ? rawSection : null}
          </div>
        ))}
        {footer ? (
          <div className={cn('px-3 py-2', tail && 'border-t border-border/60')}>{rawSection}</div>
        ) : null}
      </div>
    );
  }
  return (
    <div data-enso="tool-card-body" className="space-y-1 py-0.5 pl-5 text-[12px]">
      <div className="space-y-1">{card.blocks.map(renderBlock)}</div>
      <button
        type="button"
        data-enso="tool-card-raw"
        aria-expanded={raw}
        onClick={() => setRaw((value) => !value)}
        className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {t('View raw data')}
      </button>
      {rawBody}
    </div>
  );
}

/** 框里的 markdown 降一档：标题与正文同号、只靠粗细区分，代码块也缩小 */
const PROMPT_TYPOGRAPHY = {
  '--chat-h1-size': '1em',
  '--chat-h2-size': '1em',
  '--chat-h3-size': '1em',
  '--chat-h4-size': '1em',
  '--chat-code-block-size': '11px',
} as CSSProperties;

const PROMPT_PREVIEW_LINES = 4;

/** 折叠时只露前几行纯文本：去掉标题井号与代码围栏，不渲染 markdown */
function promptPreview(text: string): { preview: string; folded: boolean } {
  const lines = text
    .split('\n')
    .filter((line) => line.trim() && !/^\s*(```|~~~)/.test(line))
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').trimEnd());
  return {
    preview: lines.slice(0, PROMPT_PREVIEW_LINES).join('\n'),
    folded: lines.length > PROMPT_PREVIEW_LINES || text.length > 320,
  };
}

function PromptBlock({ label, text }: { label: string; text: string }) {
  const { t } = useI18n();
  const { preview, folded } = promptPreview(text);
  const [open, setOpen] = useState(false);
  const expanded = open || !folded;
  return (
    <section
      data-enso="tool-card-prompt"
      data-open={expanded ? 'true' : 'false'}
      className="min-w-0"
    >
      <div className="flex min-w-0 items-center gap-2 px-3 pt-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          {folded && (
            <button
              type="button"
              data-enso="tool-card-prompt-toggle"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              className="hover:text-foreground"
            >
              {open ? t('Show less') : t('Show full text')}
            </button>
          )}
          <CopyButton text={text} label={t('Copy')} />
        </span>
      </div>
      {expanded ? (
        <div
          data-enso="tool-card-prompt-body"
          style={PROMPT_TYPOGRAPHY}
          className="max-h-80 min-w-0 overflow-y-auto overscroll-contain px-3 pt-1 pb-2 text-xs leading-relaxed [&_:is(h1,h2,h3,h4)]:mt-2.5 [&_:is(h1,h2,h3,h4)]:mb-1 [&_[data-enso=code-block]>:first-child]:border-0"
        >
          <Markdown text={text} />
        </div>
      ) : (
        <button
          type="button"
          data-enso="tool-card-prompt-preview"
          onClick={() => setOpen(true)}
          className="line-clamp-4 block w-full min-w-0 px-3 pt-1 pb-2 text-left text-xs leading-relaxed text-muted-foreground break-words whitespace-pre-wrap"
        >
          {preview}
        </button>
      )}
    </section>
  );
}

type KvRow = Extract<ToolCardBlock, { kind: 'kv' }>['rows'][number];

/** 长值默认截两行，可展开；路径单行截断，悬停看全文 */
function KvRowView({ row }: { row: KvRow }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const long = row.display === 'long' && (row.value.length > 120 || row.value.includes('\n'));
  return (
    <div className="contents">
      <dt className="whitespace-nowrap text-muted-foreground">{row.label}</dt>
      <dd
        data-enso="tool-card-kv-value"
        data-display={row.display}
        title={row.display === 'path' ? row.value : undefined}
        className={cn(
          'min-w-0',
          row.display === 'path' ? 'truncate' : 'whitespace-pre-wrap break-words'
        )}
      >
        {long && !open ? <span className="line-clamp-2">{row.value}</span> : row.value}
        {long && (
          <button
            type="button"
            data-enso="tool-card-kv-toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="block text-[11px] text-muted-foreground hover:text-foreground"
          >
            {open ? t('Show less') : t('Show more')}
          </button>
        )}
      </dd>
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
  if (block.kind === 'prompt') return <PromptBlock label={block.label} text={block.text} />;
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
      <div data-enso="tool-card-image">
        <ToolImagePreview image={block.image} path={block.path} alt={block.alt} />
      </div>
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
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
        {block.rows.map((row) => (
          <KvRowView key={row.label} row={row} />
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
