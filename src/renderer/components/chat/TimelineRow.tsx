import type { AgentSessionCustomEntry, TodoItem, TurnPerf } from '@shared/types/agent';
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleDot,
  Copy,
  FileText,
  GitBranch,
  GitCompare,
  History,
  ListTodo,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Target,
  TerminalSquare,
  Undo2,
} from 'lucide-react';
import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { type TFunction, useI18n } from '@/i18n';
import { addSidePanelChanges } from '@/lib/sidePanelDock';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { formatDuration } from '@/stores/sessions/stats';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { ConfirmDialog } from './ConfirmDialog';
import { useChatHost } from './chatHost';
import { EditDiff } from './EditDiff';
import { renderHighlighted, useChatSearchHighlight } from './highlightQuery';
import { Markdown } from './Markdown';
import { mentionChipClass } from './MentionChip';
import { splitInlineMentions, splitMentionRefs } from './mentionComposer';
import { ReadFileView } from './ReadFileView';
import { SlashChip, slashChipClass, splitSlashCommand } from './SlashChip';
import { TerminalOutput } from './TerminalOutput';
import { ZoomableImage } from './ZoomableImage';

const perfEqual = (a?: TurnPerf, b?: TurnPerf): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.runMs === b.runMs &&
    a.turnMs === b.turnMs &&
    a.ttftMs === b.ttftMs &&
    a.tps === b.tps);

interface TimelineRowProps {
  item: TimelineItem;
  /** tool-group 组头点击展开/收拢 */
  onToggleGroup?: (key: string) => void;
}

/**
 * 按内容字段比较：buildTimeline 每次产出新 item 对象，直接 memo 无效。
 * 长对话下这层比较挡住了未变行的 markdown 重解析与 DOM 重建。
 * onToggleGroup 引用不参与比较（父级保证语义稳定）。
 */
function itemEqual(prev: TimelineRowProps, next: TimelineRowProps): boolean {
  const a = prev.item;
  const b = next.item;
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case 'user': {
      if (b.kind !== 'user') return false;
      if (a.text !== b.text || a.images.length !== b.images.length) return false;
      return a.images.every((image, i) => image === b.images[i]);
    }
    case 'text':
    case 'thinking':
      return (
        b.kind === a.kind &&
        a.text === b.text &&
        a.streaming === b.streaming &&
        (a.kind !== 'text' ||
          (b.kind === 'text' && perfEqual(a.perf, b.perf) && a.timestamp === b.timestamp)) &&
        (a.kind !== 'thinking' || (b.kind === 'thinking' && a.durationMs === b.durationMs))
      );
    case 'tool':
      return (
        b.kind === 'tool' &&
        a.state === b.state &&
        a.name === b.name &&
        a.summary === b.summary &&
        a.output === b.output &&
        a.edits === b.edits &&
        a.writeContent === b.writeContent &&
        a.todos === b.todos &&
        a.durationMs === b.durationMs &&
        a.agentMeta === b.agentMeta
      );
    case 'tool-group':
      return (
        b.kind === 'tool-group' &&
        a.expanded === b.expanded &&
        a.count === b.count &&
        a.stats.commands === b.stats.commands &&
        a.stats.reads === b.stats.reads &&
        a.stats.searches === b.stats.searches &&
        a.stats.others === b.stats.others
      );
    case 'error':
      return b.kind === 'error' && a.text === b.text;
    case 'task-note':
      return b.kind === 'task-note' && a.detail === b.detail;
    case 'session-custom':
      return b.kind === 'session-custom' && a.entry === b.entry;
  }
}

/** 系统合成的整块注入消息（coworker 雇佣通知 / 后台任务提醒） */
const SYNTHETIC_BLOCK =
  /^<(agent-notification|goal-continuation|coworker-hired|coworker-dismissed|background-task-update)>\n?([\s\S]*?)\n?<\/\1>\s*$/;
/** coworker 首条的角色前缀 */
const ROLE_PREFIX = /^<role>\n?([\s\S]*?)\n?<\/role>\s*/;
/** 工作区迁移/回退提醒：前置在用户消息之前，渲染成系统事件行而非原始 XML */
const WORKSPACE_MIGRATED_PREFIX = /^<workspace-migrated>\n?([\s\S]*?)\n?<\/workspace-migrated>\s*/;

/** 迁移提醒横幅：图标 + 一句话 + 目标路径，完整原文放 hover title */
function WorkspaceMigratedBanner({ note }: { note: string }) {
  const { t } = useI18n();
  const path = /(?:moved to|main working tree): (.+)$/m.exec(note)?.[1]?.trim();
  const fallback = note.includes('main working tree');
  return (
    <div
      title={note}
      className="flex w-full items-start gap-2 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground"
    >
      <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        {fallback
          ? t('Workspace fell back to the main working tree')
          : t('Workspace moved to an isolated worktree')}
        {path && <span className="ml-1.5 break-all font-mono text-[11px] opacity-80">{path}</span>}
      </span>
    </div>
  );
}
/** 主 agent 发给 coworker 的消息包裹 */
const MAIN_AGENT_BLOCK =
  /^<message-from-main-agent>\n?([\s\S]*?)\n?<\/message-from-main-agent>\s*$/;

/** 是否为主 agent 发来的消息(决定气泡靠左与配色;role 前缀在前时也识别) */
function isFromMainAgent(text: string): boolean {
  const role = ROLE_PREFIX.exec(text);
  return MAIN_AGENT_BLOCK.test(role ? text.slice(role[0].length) : text);
}

/** pi 把 /skill:name 展开成整段 XML；气泡里显示高亮 tag，点击看正文 */
const SKILL_BLOCK =
  /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

function SkillTag({ name, content }: { name: string; content: string }) {
  const { t } = useI18n();
  return (
    <Dialog>
      <DialogTrigger className={slashChipClass('skill', true)}>
        <Sparkles className="h-3 w-3" />
        {name}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">
            {t('Skill')} · {name}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="max-h-[50vh] text-sm">
          <Markdown text={content} />
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}

function ChipBubble({ chip, extra }: { chip: ReactNode; extra?: string }) {
  return (
    <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm">
      {chip}
      {extra ? <span className="ml-1.5 align-middle whitespace-pre-wrap">{extra}</span> : null}
    </div>
  );
}

function SkillInvocation({ text }: { text: string }) {
  const match = SKILL_BLOCK.exec(text);
  if (!match) return null;
  const [, name, , content, userMessage] = match;
  return (
    <ChipBubble chip={<SkillTag name={name} content={content} />} extra={userMessage?.trim()} />
  );
}

function SlashInvocation({ text }: { text: string }) {
  const parsed = splitSlashCommand(text);
  if (!parsed.slash) return null;
  return <ChipBubble chip={<SlashChip name={parsed.slash} />} extra={parsed.rest.trim()} />;
}

/** 内联提及卡片：与输入框编辑器的卡片完全同款（图标 + 文件名/标题），
 * 保持在句子里的原位与顺序 */
function InlineMentionCard({
  kind,
  label,
  title,
}: {
  kind: 'file' | 'chat';
  label: string;
  title: string;
}) {
  const Icon = kind === 'file' ? FileText : History;
  return (
    <span
      className={cn(
        mentionChipClass(kind),
        // align-middle + leading-4：与 CJK 正文光学居中（baseline+translate 会偏高）
        'mx-0.5 max-w-52 rounded-md px-1.5 align-middle leading-4'
      )}
      title={title}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** 正文里的 @path / chat 引用块原位渲染成卡片，其余文本原样 */
function InlineMentionText({
  text,
  searchQuery = '',
  activeNth = -1,
}: {
  text: string;
  searchQuery?: string;
  activeNth?: number;
}) {
  const segments = splitInlineMentions(text);
  const counter = { n: 0 };
  return (
    <span className="whitespace-pre-wrap">
      {segments.map((segment, index) =>
        segment.type === 'file' ? (
          <InlineMentionCard
            // biome-ignore lint/suspicious/noArrayIndexKey: 同一文件可重复提及，分段随文本快照整体替换
            key={index}
            kind="file"
            label={segment.path.split('/').at(-1) || segment.path}
            title={segment.path}
          />
        ) : segment.type === 'chat' ? (
          <InlineMentionCard
            // biome-ignore lint/suspicious/noArrayIndexKey: 分段随文本快照整体替换
            key={index}
            kind="chat"
            label={segment.label}
            title={segment.sessionFile}
          />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 分段随文本快照整体替换
          <span key={index}>
            {searchQuery.trim()
              ? renderHighlighted(segment.text, searchQuery, activeNth, counter)
              : segment.text}
          </span>
        )
      )}
    </span>
  );
}

/** 旧格式历史消息：尾部追加的引用块渲染成同款卡片行 */
function MentionRefChips({
  files,
  chats,
}: {
  files: string[];
  chats: { label: string; sessionFile: string }[];
}) {
  return (
    <span className="mt-1.5 flex flex-wrap gap-1.5">
      {files.map((path) => (
        <InlineMentionCard
          key={`f:${path}`}
          kind="file"
          label={path.split('/').at(-1) || path}
          title={path}
        />
      ))}
      {chats.map((chat) => (
        <InlineMentionCard
          key={`c:${chat.sessionFile}`}
          kind="chat"
          label={chat.label}
          title={chat.sessionFile}
        />
      ))}
    </span>
  );
}

/** 用户气泡：识别合成标记,渲染成系统事件行 / 角色块 / 来源徽章而非原始 XML */
function UserText({
  text,
  searchQuery = '',
  activeNth = -1,
}: {
  text: string;
  searchQuery?: string;
  activeNth?: number;
}) {
  const { t } = useI18n();
  const refs = splitMentionRefs(text);
  const hasRefs = refs.files.length > 0 || refs.chats.length > 0;
  if (hasRefs) {
    const parsed = splitSlashCommand(refs.body);
    return (
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm">
        {parsed.slash ? (
          <>
            <SlashChip name={parsed.slash} />
            {parsed.rest.trim() ? (
              <span className="ml-1.5 align-middle">
                <InlineMentionText
                  text={parsed.rest.trim()}
                  searchQuery={searchQuery}
                  activeNth={activeNth}
                />
              </span>
            ) : null}
          </>
        ) : (
          <InlineMentionText text={refs.body} searchQuery={searchQuery} activeNth={activeNth} />
        )}
        <MentionRefChips files={refs.files} chats={refs.chats} />
      </div>
    );
  }
  if (SKILL_BLOCK.test(text)) return <SkillInvocation text={text} />;
  if (splitSlashCommand(text).slash) return <SlashInvocation text={text} />;
  const migrated = WORKSPACE_MIGRATED_PREFIX.exec(text);
  if (migrated) {
    const remainder = text.slice(migrated[0].length).trim();
    return (
      <div className="flex w-full flex-col items-end gap-1.5">
        <WorkspaceMigratedBanner note={migrated[1]} />
        {remainder && (
          <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap">
            <InlineMentionText text={remainder} searchQuery={searchQuery} activeNth={activeNth} />
          </div>
        )}
      </div>
    );
  }
  const block = SYNTHETIC_BLOCK.exec(text);
  if (block) {
    return (
      <div className="flex w-full items-start gap-2 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
        {block[1].startsWith('coworker-') || block[1] === 'agent-notification' ? (
          <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <span className="whitespace-pre-wrap">{block[2]}</span>
      </div>
    );
  }
  const role = ROLE_PREFIX.exec(text);
  const rest = role ? text.slice(role[0].length) : text;
  const fromMain = MAIN_AGENT_BLOCK.exec(rest);
  const body = fromMain ? fromMain[1] : rest;
  // 主 agent 的消息:左侧气泡 + 蓝色弱底 + markdown 渲染,与用户(右侧灰底纯文本)区分
  return (
    <div
      className={cn(
        'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm',
        fromMain
          ? 'rounded-bl-md border border-blue-500/20 bg-blue-500/8'
          : 'rounded-br-md bg-muted whitespace-pre-wrap'
      )}
    >
      {fromMain && (
        <p className="mb-1 flex items-center gap-1 text-[10px] font-medium tracking-wide text-blue-600 uppercase dark:text-blue-400">
          <Bot className="h-3 w-3" />
          {t('From main agent')}
        </p>
      )}
      {role && (
        <div className="mb-2 rounded-md bg-background/60 px-2.5 py-1.5 text-xs text-muted-foreground">
          <span className="font-semibold">{t('Role')}</span> · {role[1]}
        </div>
      )}
      {fromMain ? (
        <Markdown text={body} searchQuery={searchQuery} activeNth={activeNth} />
      ) : (
        <InlineMentionText text={body} searchQuery={searchQuery} activeNth={activeNth} />
      )}
    </div>
  );
}

export const TimelineRow = memo(function TimelineRow({ item, onToggleGroup }: TimelineRowProps) {
  const search = useChatSearchHighlight();
  const searchQuery = search.query;
  const activeNth = search.activeKey === item.key ? search.activeNth : -1;
  switch (item.kind) {
    case 'user': {
      const fromMain = item.text ? isFromMainAgent(item.text) : false;
      return (
        <div
          className={cn('group/user flex flex-col gap-1.5', fromMain ? 'items-start' : 'items-end')}
        >
          {item.images.map((image, index) => (
            <ZoomableImage
              // biome-ignore lint/suspicious/noArrayIndexKey: 图片无稳定 id，消息整体快照替换
              key={index}
              src={`data:${image.mimeType};base64,${image.data}`}
              className="max-h-48 max-w-full rounded-lg border object-contain"
            />
          ))}
          {item.text && (
            <UserText text={item.text} searchQuery={searchQuery} activeNth={activeNth} />
          )}
          <RewindButton messageIndex={Number(item.key)} />
        </div>
      );
    }
    case 'text':
      return <TextRow item={item} searchQuery={searchQuery} activeNth={activeNth} />;
    case 'thinking':
      return (
        <ThinkingRow
          itemKey={item.key}
          text={item.text}
          streaming={item.streaming}
          durationMs={item.durationMs}
          startedAt={item.startedAt}
        />
      );
    case 'tool':
      return <ToolRow item={item} />;
    case 'tool-group':
      return <ToolGroupRow item={item} onToggle={onToggleGroup} />;
    case 'error':
      return (
        <div className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p className="min-w-0 flex-1 whitespace-pre-wrap">{item.text}</p>
          <RetryTurnButton />
        </div>
      );
    case 'task-note':
      return <TaskNoteRow item={item} />;
    case 'session-custom':
      return <SessionCustomRow entry={item.entry} />;
  }
}, itemEqual);

const customValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined) return '—';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

function SessionCustomRow({ entry }: { entry: AgentSessionCustomEntry }) {
  const { t } = useI18n();
  if (entry.kind === 'agent-dispatch') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-xs">
        <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="text-muted-foreground">{t('Dispatched to')}</span>
        <span className="font-medium">{entry.child.instanceName}</span>
      </div>
    );
  }
  if (entry.kind === 'agent-completed') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2 text-xs">
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
        <div className="min-w-0">
          <p className="font-medium">
            {entry.child.instanceName} · {t('Completed')}
          </p>
          {entry.receiptSummary && (
            <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
              {entry.receiptSummary}
            </p>
          )}
        </div>
      </div>
    );
  }
  if (entry.kind === 'agent-failed') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs">
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="font-medium">
            {entry.child.instanceName} · {t('Failed')}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{entry.message}</p>
        </div>
      </div>
    );
  }

  const receipt = entry.receipt;
  const succeeded = receipt.outcome === 'succeeded';
  return (
    <div
      className={cn(
        'rounded-md border px-2.5 py-2 text-xs',
        succeeded
          ? 'border-emerald-500/20 bg-emerald-500/5'
          : receipt.outcome === 'failed'
            ? 'border-destructive/20 bg-destructive/5'
            : 'border-amber-500/20 bg-amber-500/5'
      )}
    >
      <div className="flex items-start gap-2">
        {succeeded ? (
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <CircleAlert
            className={cn(
              'mt-0.5 h-3.5 w-3.5 shrink-0',
              receipt.outcome === 'failed' ? 'text-destructive' : 'text-amber-500'
            )}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {receipt.subject.label} · {t(receipt.outcome)}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{receipt.summary}</p>
          {receipt.changes && receipt.changes.length > 0 && (
            <dl className="mt-2 space-y-1 border-t border-border/50 pt-2">
              {receipt.changes.map((change) => (
                <div key={change.field} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <dt className="truncate text-muted-foreground">{change.field}</dt>
                  <dd className="text-right font-mono">
                    {customValue(change.previous)} → {customValue(change.value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

/** 当前展示的会话(主会话或激活的 coworker tab),与 ChatView 的选取逻辑一致 */
function displayedConversation(state: ReturnType<typeof useSessionsStore.getState>) {
  const active = state.activeId ? state.conversations[state.activeId] : null;
  if (!active) return null;
  return active.activeTabId ? (state.conversations[active.activeTabId] ?? active) : active;
}

/** 终态错误后续跑：已 spawn 且非 running 才显示（手机 stub started=false 自动隐藏） */
function RetryTurnButton() {
  const { t } = useI18n();
  const host = useChatHost();
  const canRetry = useSessionsStore((state) => {
    // 远程节点视图：协议无 retry，宿主显式关闭
    if (host && !host.canRetry) return false;
    const conversation = displayedConversation(state);
    return Boolean(
      conversation?.started && !conversation.spawning && conversation.status !== 'running'
    );
  });
  if (!canRetry) return null;
  return (
    <button
      type="button"
      title={t('Retry')}
      onClick={() => {
        const conversation = displayedConversation(useSessionsStore.getState());
        if (!conversation) return;
        useSessionsStore.getState().retry(conversation.id);
      }}
      className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      <RefreshCw className="h-3 w-3" />
      {t('Retry')}
    </button>
  );
}

/** 回退入口:仅 idle 且已 spawn 的会话显示;点击弹出「仅对话 / 对话+文件」二选,选后再确认 */
function RewindButton({ messageIndex }: { messageIndex: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  /** 待确认的回退(值 = restoreFiles);null = 无 */
  const [pendingRestoreFiles, setPendingRestoreFiles] = useState<boolean | null>(null);
  const host = useChatHost();
  const canRewind = useSessionsStore((state) => {
    if (host && !host.canRewind) return false;
    const conversation = displayedConversation(state);
    return Boolean(
      conversation?.started && !conversation.spawning && conversation.status === 'idle'
    );
  });
  if (!canRewind) return null;
  const rewind = (restoreFiles: boolean) => {
    const state = useSessionsStore.getState();
    const conversation = displayedConversation(state);
    if (!conversation) return;
    if (conversation.messages[messageIndex]?.role !== 'user') return;
    // 从末尾数的 user 序号:worker 侧与 jsonl 分支按尾部对齐(容忍 compaction)
    const userIndexFromEnd = conversation.messages
      .slice(messageIndex + 1)
      .filter((message) => message.role === 'user').length;
    state.rewind(conversation.id, userIndexFromEnd, restoreFiles);
  };
  const options = [
    {
      icon: Undo2,
      label: t('Conversation only'),
      desc: t('Rewind to this message'),
      restoreFiles: false,
    },
    {
      icon: History,
      label: t('Conversation + files'),
      desc: t('Rewind and restore files to before this turn'),
      restoreFiles: true,
    },
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          'flex items-center gap-1 text-[11px] text-muted-foreground transition-opacity hover:text-foreground',
          // popover 打开期间保持可见,否则 hover 移开触发按钮会随组隐藏
          open ? 'opacity-100' : 'opacity-0 group-hover/user:opacity-100'
        )}
        title={t('Rewind to this message')}
      >
        <Undo2 className="h-3 w-3" />
        {t('Rewind')}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-72 [&_[data-slot=popover-viewport]]:p-1">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => {
              setOpen(false);
              setPendingRestoreFiles(option.restoreFiles);
            }}
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
          >
            <option.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.desc}</span>
            </span>
          </button>
        ))}
      </PopoverPopup>
      <ConfirmDialog
        open={pendingRestoreFiles !== null}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setPendingRestoreFiles(null);
        }}
        title={t('Rewind to this message?')}
        description={
          pendingRestoreFiles
            ? t(
                'Later messages leave the current branch and working-tree files are restored to before this turn.'
              )
            : t('Later messages leave the current branch; the text returns to the input box.')
        }
        confirmLabel={t('Rewind')}
        onConfirm={() => {
          if (pendingRestoreFiles !== null) rewind(pendingRestoreFiles);
        }}
      />
    </Popover>
  );
}

/** assistant 正文：markdown + hover 操作条（复制 / 时间 / 该轮耗时·TTFT·tok/s） */
function TextRow({
  item,
  searchQuery = '',
  activeNth = -1,
}: {
  item: Extract<TimelineItem, { kind: 'text' }>;
  searchQuery?: string;
  activeNth?: number;
}) {
  const { t } = useI18n();
  return (
    <div className="group text-sm">
      <Markdown
        text={item.text}
        streaming={item.streaming}
        searchQuery={searchQuery}
        activeNth={activeNth}
      />
      {!item.streaming && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={item.text} />
          {item.timestamp && <span>{formatClock(item.timestamp)}</span>}
          {item.perf && <span>· {formatPerf(item.perf, t)}</span>}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1000);
        });
      }}
      className="flex items-center gap-1 transition-colors hover:text-foreground"
      title={t('Copy')}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const formatClock = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
/** 秒：<10s 一位小数，否则整数 */
const secs = (ms: number): string => {
  const s = ms / 1000;
  return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
};
/** 末 step 读数：本 step 耗时 · TTFT · tok/s；多 step 轮次再附「总计 Xs」= 整轮墙钟（含工具执行） */
function formatPerf(perf: TurnPerf, t: TFunction): string {
  const parts = [`${secs(perf.runMs)}s`];
  if (perf.ttftMs !== undefined) parts.push(`TTFT ${secs(perf.ttftMs)}s`);
  if (perf.tps !== undefined) parts.push(`${Math.round(perf.tps)} tok/s`);
  if (perf.turnMs !== undefined)
    parts.push(t('total {{duration}}', { duration: formatDuration(perf.turnMs) }));
  return parts.join(' · ');
}

/** deepseek-harness 的 Think 行：流式中自动展开跟看，结束自动收起；手动点击覆盖默认 */
function ThinkingRow({
  itemKey,
  text,
  streaming,
  durationMs,
  startedAt,
}: {
  itemKey: string;
  text: string;
  streaming: boolean;
  durationMs: number | null;
  startedAt?: number;
}) {
  const { t } = useI18n();
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? streaming;
  return (
    <div>
      <button
        type="button"
        onClick={() => setUserToggled(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className={cn('h-3.5 w-3.5', streaming && 'animate-pulse')} />
        <span>{streaming ? t('Thinking…') : t('Thought process')}</span>
        {streaming ? (
          <RunningElapsed itemKey={itemKey} since={startedAt} />
        ) : (
          durationMs !== null && (
            <span className="font-mono text-[10px] text-muted-foreground/70 tabular-nums">
              {formatDuration(durationMs)}
            </span>
          )
        )}
        <ChevronRight className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <p className="mt-1.5 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {text}
        </p>
      )}
    </div>
  );
}

/** 后台任务完成事件：分隔线嵌字；点击展开详情与完整日志 */
function TaskNoteRow({ item }: { item: Extract<TimelineItem, { kind: 'task-note' }> }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  /** undefined=未读, null=文件不存在, string=内容。占位文案在渲染时 t()，切语言才会更新 */
  const [log, setLog] = useState<string | null | undefined>(undefined);
  const match = /^Background task (\S+) finished \((.+?), ran (.+?)\)/.exec(item.summary);
  const text = match ? `${match[1]} · ${match[2]} · ${match[3]}` : item.summary;
  const logPath = /read (\/.+?\.log) for the complete log/.exec(item.detail)?.[1] ?? null;

  useEffect(() => {
    if (!expanded || !logPath || log !== undefined) return;
    void window.electronAPI.files
      .read(logPath)
      .then((content) => {
        setLog(typeof content === 'string' ? content : null);
      })
      // 同 EditDiff：读失败也要落地成明确状态，否则一直是「加载中」
      .catch(() => setLog(null));
  }, [expanded, logPath, log]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3"
        title={item.detail}
      >
        <span className="h-px flex-1 bg-border" />
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          <Check className="h-3 w-3 text-green-600 dark:text-green-500" />
          {text}
          <ChevronRight className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')} />
        </span>
        <span className="h-px flex-1 bg-border" />
      </button>
      {expanded && (
        <div className="mt-1.5 rounded-lg border border-border/60 bg-muted/20">
          <pre className="border-b border-border/60 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {item.detail}
          </pre>
          <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {logPath
              ? log === undefined
                ? t('Loading…')
                : (log ?? t('(log unavailable)'))
              : t('(no log available)')}
          </pre>
        </div>
      )}
    </div>
  );
}

/** 收拢的工具组头：摘要统计 + chevron；点击展开为组内原始行 */
function ToolGroupRow({
  item,
  onToggle,
}: {
  item: Extract<TimelineItem, { kind: 'tool-group' }>;
  onToggle?: (key: string) => void;
}) {
  const { t } = useI18n();
  const parts: string[] = [];
  if (item.stats.commands > 0)
    parts.push(t('ran {{count}} commands', { count: item.stats.commands }));
  if (item.stats.reads > 0) parts.push(t('read {{count}} files', { count: item.stats.reads }));
  if (item.stats.searches > 0)
    parts.push(t('searched {{count}} times', { count: item.stats.searches }));
  if (item.stats.others > 0) parts.push(t('{{count}} other calls', { count: item.stats.others }));
  return (
    <button
      type="button"
      onClick={() => onToggle?.(item.key)}
      className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
    >
      <ChevronRight
        className={cn('h-3 w-3 shrink-0 transition-transform', item.expanded && 'rotate-90')}
      />
      <span className="font-medium">{t('{{count}} tool calls', { count: item.count })}</span>
      {parts.length > 0 && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span className="min-w-0 flex-1 truncate">{parts.join(' · ')}</span>
        </>
      )}
    </button>
  );
}

/** 单行工具摘要：状态点/图标 + 工具名 + 参数摘要；edit 展开为 diff,write 展开为写入内容,其余为输出 */
function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const { t } = useI18n();
  const hasDiff = Boolean(item.edits && item.edits.length > 0);
  const hasWrite = Boolean(item.writeContent);
  const expandable = hasDiff || hasWrite || Boolean(item.output);
  // edit 的 diff 与 write 的内容只在本轮直播（running）时默认展开（「直接看到」）；
  // 历史会话挂载时全部折叠——否则切会话时视口内成排 FileDiff 同步解析+高亮，
  // 主线程阻塞几秒白屏
  const [expanded, setExpanded] = useState((hasDiff || hasWrite) && item.state === 'running');
  // 直播中 edits/writeContent 随参数流式补齐晚于行挂载：到位时自动展开。
  // 历史会话挂载时 state 已是终态，不会触发；用户手动收起后依赖项不变，不会重新弹开
  useEffect(() => {
    if (item.state === 'running' && (hasDiff || hasWrite)) setExpanded(true);
  }, [item.state, hasDiff, hasWrite]);

  if (item.todos) return <TodoRow todos={item.todos} />;
  if (item.name.startsWith('goal_')) return <GoalSignalRow item={item} />;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30">
      <div className="flex items-center">
        <button
          type="button"
          disabled={!expandable}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs',
            expandable && 'cursor-pointer hover:bg-muted/50'
          )}
        >
          <ToolStateIcon state={item.state} />
          <span className="shrink-0 font-medium">{item.name}</span>
          {item.summary && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-mono',
                  item.state === 'error' ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {item.state === 'error' && item.output ? firstLine(item.output) : item.summary}
              </span>
            </>
          )}
          {item.state === 'running' ? (
            <RunningElapsed itemKey={item.key} />
          ) : (
            (item.agentMeta || item.durationMs !== null) && (
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
                {[
                  item.agentMeta?.modelId,
                  item.agentMeta?.outputTokens ? `${item.agentMeta.outputTokens} tok` : null,
                  item.durationMs !== null ? formatDuration(item.durationMs) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )
          )}
          {expandable && (
            <ChevronRight
              className={cn(
                'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )}
            />
          )}
        </button>
        {(hasDiff || hasWrite) && item.state === 'ok' && (
          <button
            type="button"
            title={t('Open in side panel')}
            className="mr-2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => addSidePanelChanges()}
          >
            <GitCompare className="h-3 w-3" />
          </button>
        )}
      </div>
      {expanded && hasDiff && item.edits && (
        <div className="max-h-96 overflow-auto">
          <EditDiff path={item.summary} blocks={item.edits} />
        </div>
      )}
      {expanded && hasWrite && item.writeContent && (
        <div className="max-h-96 overflow-auto rounded-b-lg border-t border-border/60">
          <ReadFileView path={item.summary} contents={item.writeContent} />
        </div>
      )}
      {expanded && !hasDiff && !hasWrite && item.output && (
        <div className="max-h-96 overflow-auto rounded-b-lg border-t border-border/60">
          {item.name === 'bash' ? (
            <TerminalOutput command={item.summary} output={item.output} />
          ) : item.name === 'read' ? (
            <ReadFileView path={item.summary} contents={item.output} />
          ) : item.name === 'subagent' && item.state !== 'error' ? (
            <div className="px-3 py-2 text-sm">
              <Markdown text={item.output} />
            </div>
          ) : (
            <pre className="px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {item.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** goal 终止信号行:目标完成/受阻/等待的醒目标记(摘要即 agent 给的证据/原因) */
function GoalSignalRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const { t } = useI18n();
  const kind = item.name.replace('goal_', '');
  const label =
    kind === 'complete'
      ? t('Goal completed')
      : kind === 'blocked'
        ? t('Goal blocked')
        : t('Goal waiting');
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
        kind === 'complete' && 'border-green-500/50 bg-green-500/5',
        kind === 'blocked' && 'border-destructive/50 bg-destructive/5',
        kind === 'wait' && 'border-amber-500/50 bg-amber-500/5'
      )}
    >
      <Target
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          kind === 'complete' && 'text-green-600 dark:text-green-500',
          kind === 'blocked' && 'text-destructive',
          kind === 'wait' && 'text-amber-500'
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{label}</p>
        {item.summary && (
          <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground text-xs">{item.summary}</p>
        )}
      </div>
    </div>
  );
}

/** todo 清单行：进度摘要 + ✓/●/○ 列表；清单即产物，恒展开 */
function TodoRow({ todos }: { todos: TodoItem[] }) {
  const { t } = useI18n();
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <ListTodo className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{t('Todos')}</span>
        <span>
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-0.5 text-xs">
        {todos.map((todo) => (
          <li key={todo.content} className="flex items-start gap-1.5">
            {todo.status === 'completed' ? (
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-green-600 dark:text-green-500" />
            ) : todo.status === 'in_progress' ? (
              <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-blue-500" />
            ) : (
              <Circle className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50" />
            )}
            <span
              className={cn(
                todo.status === 'completed'
                  ? 'text-muted-foreground line-through'
                  : todo.status === 'in_progress'
                    ? 'font-medium'
                    : 'text-muted-foreground'
              )}
            >
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 切会话会卸载时间线，挂载时刻不能当起点。有 since 用打点；否则按会话+行 key 记住第一次出现的时刻。 */
const elapsedStartByKey = new Map<string, number>();

function RunningElapsed({ itemKey, since }: { itemKey: string; since?: number }) {
  const host = useChatHost();
  const localSessionId = useSessionsStore((state) => displayedConversation(state)?.id ?? '');
  // 远程节点视图的计时 key 用远程会话 id，不能落到本机 active 会话上
  const sessionId = host ? (host.sessionId ?? '') : localSessionId;
  const startRef = useRef<number | null>(null);
  if (startRef.current === null) {
    const cacheKey = `${sessionId}:${itemKey}`;
    startRef.current = since ?? elapsedStartByKey.get(cacheKey) ?? Date.now();
    if (since === undefined) elapsedStartByKey.set(cacheKey, startRef.current);
  }
  const origin = since ?? startRef.current;
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
      {formatDuration(Date.now() - origin)}
    </span>
  );
}

function ToolStateIcon({ state }: { state: 'running' | 'ok' | 'error' }) {
  switch (state) {
    case 'running':
      return <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />;
    case 'error':
      return <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />;
    default:
      return <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
}

const firstLine = (text: string): string => text.split('\n', 1)[0] ?? '';
