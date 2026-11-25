import { splitChatReferences } from '@shared/bots/composerRefs';
import { parseBotInjectedMessage } from '@shared/bots/injectedMessage';
import { stripBotNotesUpdate } from '@shared/bots/notes';
import { stripBrowserElementBlocks } from '@shared/browser/designAnnotation';
import { isBtwIsolationPrompt } from '@shared/btw';
import { interruptNotice } from '@shared/exitInterrupt';
import { toLocalImageUrl } from '@shared/localImage';
import { type PlanNoteKind, parsePlanMessage, splitPlanPrefix } from '@shared/planMode';
import type { MaskReport } from '@shared/privacyMask/report';
import { quotesAsMarkdown } from '@shared/quoteBlock';
import { parseInboundMessage } from '@shared/secretary/inbound';
import { splitInboundImageBlock } from '@shared/secretary/inboundImages';
import {
  goalHeadline,
  type InjectedSegment,
  scheduleFolds,
  splitInjectedBlocks,
  stripInjectedWrapperLines,
  updatesFold,
} from '@shared/secretary/injectedBlocks';
import { parseSecretaryUpdates, type SecretaryUpdateLine } from '@shared/secretary/updatesText';
import { shellFailureHeadline } from '@shared/shellHints';
import { parseSkillCommands, splitSkillBlocks } from '@shared/skillCommands';
import {
  leadingTaskWrapUp,
  splitTaskWrapUpPrefix,
  splitTurnNotes,
  type TaskWrapUpItem,
  withoutTaskWrapUp,
} from '@shared/turnNotes';
import type {
  AgentRunProgress,
  AgentSessionCustomEntry,
  TodoItem,
  TurnPerf,
} from '@shared/types/agent';
import { splitUnattendedPrefix, type UnattendedNoteKind } from '@shared/unattendedNote';
import { parseWorkflowPresetMessage } from '@shared/workflowPresetMessage';
import {
  AlarmClock,
  ArrowDownToLine,
  ArrowUpRight,
  Bot,
  BoxSelect,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleX,
  ClipboardCheck,
  ClipboardList,
  Copy,
  EyeOff,
  FileText,
  GitBranch,
  GitCompare,
  History,
  Hourglass,
  Info,
  ListTodo,
  LoaderCircle,
  MessageCircleQuestion,
  MessagesSquare,
  PackageMinus,
  Pause,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Sparkles,
  Target,
  TerminalSquare,
  Undo2,
  UserRound,
  Workflow,
} from 'lucide-react';
import {
  Fragment,
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { InjectedMessageCard } from '@/components/bots/InjectedMessageCard';
import { restartConversationFromMenu } from '@/components/chat/reloadConversationAction';
import { conversationIdBySessionFile } from '@/components/chat/sessionRefJump';
import { SecretaryFace } from '@/components/secretary/SecretaryFace';
import {
  SecretaryProposalRow,
  secretaryProposalId,
} from '@/components/secretary/SecretaryProposalRow';
import { TelegramInboundCard } from '@/components/secretary/TelegramInboundCard';
import type { SecretaryFaceModel } from '@/components/secretary/useSecretaryFace';
import { useSecretaryFace } from '@/components/secretary/useSecretaryFace';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useOauthAccountEmails } from '@/hooks/useOauthAccountEmails';
import { type TFunction, useI18n } from '@/i18n';
import { diffCacheKey } from '@/lib/diffCacheKey';
import { parseMcpToolName } from '@/lib/mcpToolName';
import { addSidePanelChanges } from '@/lib/sidePanelDock';
import { stripAnsi } from '@/lib/terminalText';
import { usesToolCard } from '@/lib/toolCards';
import { SUBAGENT_OP_LABEL_KEYS, TOOL_LABEL_KEYS, toolLabel } from '@/lib/toolLabels';
import { cn } from '@/lib/utils';
import { openSessionFromSecretary } from '@/stores/secretaryReturn';
import { useSessionsStore } from '@/stores/sessions';
import {
  canShowConversationFork,
  canShowConversationRewind,
  forkDepth,
  resolveRewindConfirm,
} from '@/stores/sessions/conversationRewind';
import { canRequestWithdraw, canWithdrawMessage } from '@/stores/sessions/reducer';
import { formatDuration, formatTokens } from '@/stores/sessions/stats';
import {
  exploreStepsKey,
  isReadOnlyTool,
  isSandboxTool,
  type SandboxView,
  shouldAutoExpandAppliedFileChanges,
  shouldShowToolOutputAfterFileChanges,
  summarizeSandboxCalls,
  type TimelineItem,
  thinkingRowExpanded,
} from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { useSubagentRunsStore } from '@/stores/subagentRuns';
import { PluginArtifactsCard } from '../../plugins/artifactViews';
import { PluginIcon } from '../../plugins/PluginIcon';
import { PluginMessageActions, PluginThinkingBody, PluginToolCardSlot } from '../../plugins/slots';
import { ApprovalReviewBar } from './ApprovalReviewBar';
import { AskUserResult } from './AskUserResult';
import { parseAgentNotification, type SubagentNotice } from './agentNotification';
import { CodeBlock } from './CodeBlock';
import { ConfirmDialog } from './ConfirmDialog';
import { useChatHost } from './chatHost';
import { compactionFreedPercent } from './contextBreakdown';
import { renderHighlighted, useChatSearchHighlight } from './highlightQuery';
import { InboundImageList } from './InboundImageList';
import { GOAL_FRAME, GoalIcon, NOTICE_BOX, NOTICE_FRAME, NOTICE_ICON } from './injectedVisual';
import { LocalFileTrigger, Markdown } from './Markdown';
import { MemoryCaptureResult, MemorySearchResults } from './MemorySearchResults';
import { mentionChipClass } from './MentionChip';
import { parseMemoryCapture, parseMemorySearchHits } from './memorySearchHits';
import { fileMentionBasename, splitInlineMentions, splitMentionRefs } from './mentionComposer';
import { PrivacyMaskBadge } from './PrivacyMaskBadge';
import { splitQuoteFences } from './quoteSelection';
import { RtkToolStatsBar } from './RtkToolStatsBar';
import { DcgWarningBadge, ShellFailureBadge, ShellRunStatus } from './ShellStatus';
import { SlashChip, slashChipClass, splitSlashCommand } from './SlashChip';
import { StepDot } from './StepNode';
import { SubagentResult } from './SubagentResult';
import { parseSubagentReceipt, subagentErrorReason } from './subagentReceipt';
import { TaskWrapUpCard } from './TaskWrapUpCard';

// 只有出现 diff / 读文件行时才需要，按需加载以把 @pierre/diffs 移出首屏
const EditDiff = lazy(() => import('./EditDiff').then((m) => ({ default: m.EditDiff })));
const ReadFileView = lazy(() =>
  import('./ReadFileView').then((m) => ({ default: m.ReadFileView }))
);

import { TerminalOutput } from './TerminalOutput';
import { TodoList, TodoProgress } from './TodoBar';
import { ToolCallCards } from './ToolCallCard';
import { ImageViewResult } from './ToolImagePreview';
import { useToolHold } from './toolHold';
import { ZoomableImage } from './ZoomableImage';

const perfEqual = (a?: TurnPerf, b?: TurnPerf): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.runMs === b.runMs &&
    a.turnMs === b.turnMs &&
    a.ttftMs === b.ttftMs &&
    a.tps === b.tps);

type CardPeers = Extract<TimelineItem, { kind: 'tool' }>['cardPeers'];

/** 卡片后续调用逐条比较；图片按 base64 判等，不进 JSON.stringify */
function cardPeersEqual(a: CardPeers, b: CardPeers): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every((peer, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        peer.key === other.key &&
        peer.state === other.state &&
        peer.output === other.output &&
        peer.image?.data === other.image?.data &&
        JSON.stringify(peer.args ?? null) === JSON.stringify(other.args ?? null)
      );
    })
  );
}

interface TimelineRowProps {
  item: TimelineItem;
  /**
   * 这条时间线自己的会话属于秘书项目。由上层按 conversationId 判定后显式传下来：
   * 读全局「当前打开的会话」会在切标签的一瞬间和 buildTimeline 的判断对不上。
   */
  secretarySession?: boolean;
  /** tool-group 组头点击展开/收拢 */
  onToggleGroup?: (key: string) => void;
  /** 轮次（Turn）折叠/展开：行自身知道目标状态，父级不必回查 */
  onToggleTurn?: (key: string, collapsed: boolean) => void;
}

/**
 * 按内容字段比较：buildTimeline 每次产出新 item 对象，直接 memo 无效。
 * 长对话下这层比较挡住了未变行的 markdown 重解析与 DOM 重建。
 * onToggleGroup 引用不参与比较（父级保证语义稳定）。
 */
function itemEqual(prev: TimelineRowProps, next: TimelineRowProps): boolean {
  if (prev.secretarySession !== next.secretarySession) return false;
  const a = prev.item;
  const b = next.item;
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case 'user': {
      if (b.kind !== 'user') return false;
      if (
        a.text !== b.text ||
        a.images.length !== b.images.length ||
        a.timestamp !== b.timestamp ||
        a.deliveryState !== b.deliveryState ||
        a.turnDurationMs !== b.turnDurationMs ||
        a.collapsed !== b.collapsed ||
        a.canCollapse !== b.canCollapse ||
        a.hostTaskWrapUp !== b.hostTaskWrapUp
      )
        return false;
      return a.images.every((image, i) => image === b.images[i]);
    }
    case 'text':
    case 'thinking':
      return (
        b.kind === a.kind &&
        a.text === b.text &&
        a.streaming === b.streaming &&
        (a.kind !== 'text' ||
          (b.kind === 'text' &&
            perfEqual(a.perf, b.perf) &&
            a.timestamp === b.timestamp &&
            a.turnDurationMs === b.turnDurationMs)) &&
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
        a.fileChanges === b.fileChanges &&
        a.imagePath === b.imagePath &&
        a.image?.data === b.image?.data &&
        a.image?.mimeType === b.image?.mimeType &&
        a.generatedImages === b.generatedImages &&
        a.todos === b.todos &&
        a.durationMs === b.durationMs &&
        a.startedAt === b.startedAt &&
        a.agentMeta === b.agentMeta &&
        a.source === b.source &&
        a.nestedPending === b.nestedPending &&
        JSON.stringify(a.sandbox) === JSON.stringify(b.sandbox) &&
        a.rtk === b.rtk &&
        a.approvalReview === b.approvalReview &&
        a.plan?.title === b.plan?.title &&
        a.plan?.text === b.plan?.text &&
        a.sentMessage === b.sentMessage &&
        a.memoryContent === b.memoryContent &&
        a.ask?.question === b.ask?.question &&
        a.ask?.options.join('\n') === b.ask?.options.join('\n') &&
        a.ask?.answer === b.ask?.answer &&
        a.ask?.autoSelected === b.ask?.autoSelected &&
        a.subagentOp === b.subagentOp &&
        JSON.stringify(a.subagentTitles) === JSON.stringify(b.subagentTitles) &&
        a.waiting === b.waiting &&
        a.pluginArtifacts === b.pluginArtifacts &&
        a.shellFailure === b.shellFailure &&
        a.dcgWarning === b.dcgWarning &&
        JSON.stringify(a.args ?? null) === JSON.stringify(b.args ?? null) &&
        cardPeersEqual(a.cardPeers, b.cardPeers)
      );
    case 'tool-group':
      return (
        b.kind === 'tool-group' &&
        a.expanded === b.expanded &&
        a.count === b.count &&
        a.stats.commands === b.stats.commands &&
        a.stats.reads === b.stats.reads &&
        a.stats.searches === b.stats.searches &&
        a.stats.others === b.stats.others &&
        a.exploring === b.exploring &&
        a.live === b.live &&
        a.activity?.thinking === b.activity?.thinking &&
        a.activity?.workedMs === b.activity?.workedMs &&
        a.explore?.goal === b.explore?.goal &&
        a.explore?.report === b.explore?.report &&
        a.explore?.steps === b.explore?.steps &&
        a.notice === b.notice
      );
    case 'error':
      return b.kind === 'error' && a.text === b.text;
    case 'interrupted':
      return (
        b.kind === 'interrupted' &&
        a.at === b.at &&
        a.exitKind === b.exitKind &&
        a.unfinishedTools.length === b.unfinishedTools.length
      );
    case 'task-note':
      return b.kind === 'task-note' && a.detail === b.detail;
    case 'compaction':
    case 'compaction-notice':
      return (
        (b.kind === 'compaction' || b.kind === 'compaction-notice') &&
        a.kind === b.kind &&
        a.summary === b.summary &&
        a.tokensBefore === b.tokensBefore &&
        a.tokensAfter === b.tokensAfter &&
        a.verified === b.verified
      );
    case 'compaction-progress':
      return b.kind === 'compaction-progress' && a.state === b.state;
    case 'session-custom':
      return b.kind === 'session-custom' && a.entry === b.entry;
    case 'divider':
      return b.kind === 'divider' && a.text === b.text;
    case 'plugin-message':
      return b.kind === 'plugin-message' && a.text === b.text && a.pluginId === b.pluginId;
    case 'resumed-reply':
      return (
        b.kind === 'resumed-reply' &&
        a.expanded === b.expanded &&
        a.text === b.text &&
        a.thinking === b.thinking &&
        a.tools.length === b.tools.length
      );
    case 'discarded-turn':
      return (
        b.kind === 'discarded-turn' &&
        a.expanded === b.expanded &&
        a.reason === b.reason &&
        a.messages.length === b.messages.length &&
        a.messages.every((text, i) => text === b.messages[i]) &&
        a.tools.length === b.tools.length
      );
  }
}

/** coworker 首条的角色前缀 */
const ROLE_PREFIX = /^<role>\n?([\s\S]*?)\n?<\/role>\s*/;
/** 工作区迁移/回退提醒：前置在用户消息之前，渲染成系统事件行而非原始 XML */
const WORKSPACE_MIGRATED_PREFIX = /^<workspace-migrated>\n?([\s\S]*?)\n?<\/workspace-migrated>\s*/;
/** 切分支提醒：随下一条消息前置，正文是给模型的英文说明 */
const WORKSPACE_BRANCH_PREFIX =
  /^<workspace-branch-changed>\n?([\s\S]*?)\n?<\/workspace-branch-changed>\s*/;

function WorkspaceBranchBanner({ note }: { note: string }) {
  const { t } = useI18n();
  const raw = /on Git branch ("(?:[^"\\]|\\.)*")/.exec(note)?.[1];
  let branch = '';
  try {
    branch = raw ? String(JSON.parse(raw)) : '';
  } catch {}
  return (
    <aside
      title={note}
      className="flex w-full items-start gap-2 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground"
    >
      <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-all">
        {branch
          ? t('Workspace switched to branch {{branch}}', { branch })
          : t('Workspace switched branch')}
      </span>
    </aside>
  );
}

/** 宿主搭上的收尾清单：在本机会话里还能跳到任务条 */
function HostTaskWrapUp({ items }: { items: TaskWrapUpItem[] }) {
  const host = useChatHost();
  const conversationId = useSessionsStore((state) =>
    host ? undefined : displayedConversation(state)?.id
  );
  const live = useSessionsStore((state) =>
    host ? undefined : displayedConversation(state)?.backgroundTasks
  );
  return (
    <TaskWrapUpCard
      items={items}
      live={live}
      onOpen={
        conversationId
          ? (taskId) =>
              useSessionsStore.setState({
                pendingAgentOpen: { sessionId: conversationId, agentId: taskId },
              })
          : undefined
      }
    />
  );
}

/** 迁移提醒横幅：图标 + 一句话 + 目标路径，完整原文放 hover title。
 * 系统提示条用 aside 并与气泡平铺在 message-user 下：主题以 `> div:not(:last-child)` 选中气泡 */
function WorkspaceMigratedBanner({ note }: { note: string }) {
  const { t } = useI18n();
  const path = /(?:moved to|main working tree): (.+)$/m.exec(note)?.[1]?.trim();
  const fallback = note.includes('main working tree');
  return (
    <aside
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
    </aside>
  );
}
/** Plan 状态提示：worker 前置在用户消息之前，渲染成系统事件行 */
function PlanNoteBanner({ note }: { note: PlanNoteKind }) {
  const { t } = useI18n();
  return (
    <aside className="flex w-full items-start gap-2 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
      <ClipboardList className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        {note === 'on'
          ? t('Plan mode on: read-only research, then a plan for your approval')
          : note === 'off'
            ? t('Plan mode off')
            : t('Context compacted: the approved plan was attached again')}
      </span>
    </aside>
  );
}

/** 无人值守开关提示：worker 前置在用户消息之前，渲染成系统事件行 */
function UnattendedNoteBanner({ note }: { note: UnattendedNoteKind }) {
  const { t } = useI18n();
  const on = note === 'on';
  return (
    <aside className="flex w-full items-start gap-2 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
      {on ? (
        <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : (
        <UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0">
        {on
          ? t('Unattended mode on: no one is watching, so it decides and keeps going')
          : t('Unattended mode off: a person is available again')}
      </span>
    </aside>
  );
}

/** 合成注入块（后台任务 / 子代理完成通知等）：多行时默认只露首行，点击展开全文 */
function SyntheticNotice({ tag, body }: { tag: string; body: string }) {
  const notices = tag === 'agent-notification' ? parseAgentNotification(body) : null;
  if (notices) return <SubagentNotices notices={notices} />;
  return <RawSyntheticNotice tag={tag} body={body} />;
}

/** 目标续跑：和 GoalBar 同一套 goal 外观，默认收成一行，点整行展开完整目标与续跑指令 */
function GoalContinuationCard({ goal, instructions }: { goal: string; instructions: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const summary = goalHeadline(goal);
  return (
    <div
      data-enso="goal-continuation"
      data-open={open ? 'true' : 'false'}
      className={cn('my-1 w-full min-w-0', GOAL_FRAME)}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 text-left text-muted-foreground hover:text-foreground"
      >
        <GoalIcon />
        <span className="min-w-0 flex-1 truncate">
          {t('Continue goal: {{summary}}', { summary: summary || goal })}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 border-t border-border/60 pt-1.5">
          <p className="whitespace-pre-wrap text-foreground">{goal}</p>
          {instructions && (
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
              {instructions}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** 系统注入块：默认一行，点整行展开全文，不画标签名也不画右箭头。 */
function FoldedInjectedCard({
  enso,
  icon: Icon,
  title,
  body,
}: {
  enso: string;
  icon: typeof Bot;
  title: string;
  body: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-enso={enso} data-open={open ? 'true' : 'false'} className={NOTICE_FRAME}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-2 text-left enabled:hover:text-foreground"
      >
        <Icon className={NOTICE_ICON} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      {open && body && <p className="mt-1.5 whitespace-pre-wrap text-foreground">{body}</p>}
    </div>
  );
}

function InjectedSegments({
  segments,
  searchQuery,
  activeNth,
}: {
  segments: InjectedSegment[];
  searchQuery: string;
  activeNth: number;
}) {
  const { t } = useI18n();
  return (
    <>
      {segments.map((segment, index) => {
        const key = `${segment.kind}-${index}`;
        if (segment.kind === 'text') {
          const text = segment.text.trim();
          if (!text) return null;
          return <UserText key={key} text={text} searchQuery={searchQuery} activeNth={activeNth} />;
        }
        if (segment.kind === 'goal')
          return (
            <GoalContinuationCard
              key={key}
              goal={segment.goal}
              instructions={segment.instructions}
            />
          );
        if (segment.kind === 'schedule') {
          const folds = scheduleFolds(segment.raw);
          const cards = folds.length > 0 ? folds : [{ summary: '', body: '' }];
          return (
            <Fragment key={key}>
              {cards.map((fold, foldIndex) => (
                <FoldedInjectedCard
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同一条注入消息里的定时顺序即身份
                  key={foldIndex}
                  enso="secretary-schedule-card"
                  icon={AlarmClock}
                  title={
                    fold.summary
                      ? t('Scheduled: {{summary}}', { summary: fold.summary })
                      : t('Scheduled')
                  }
                  body={fold.body}
                />
              ))}
            </Fragment>
          );
        }
        if (segment.kind === 'updates') {
          const lines = parseSecretaryUpdates(segment.raw);
          if (lines) return <SecretaryUpdatesNotice key={key} lines={lines} />;
          const fold = updatesFold(segment.raw);
          return (
            <FoldedInjectedCard
              key={key}
              enso="session-updates-card"
              icon={MessagesSquare}
              title={
                fold.summary
                  ? t('Session updates: {{summary}}', { summary: fold.summary })
                  : t('Session updates')
              }
              body={fold.body}
            />
          );
        }
        return <SyntheticNotice key={key} tag={segment.tag} body={segment.body} />;
      })}
    </>
  );
}

/** 子代理完成通知：首行作标题，展开后正文按 Markdown 渲染，用量收进底栏 */
function SubagentNotices({ notices }: { notices: SubagentNotice[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={NOTICE_BOX}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:text-foreground"
      >
        <Bot className={NOTICE_ICON} />
        <span className="min-w-0 flex-1 truncate">{notices.map((n) => n.header).join(' · ')}</span>
      </button>
      {expanded &&
        notices.map((n, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 通知内容不可变，顺序即身份
          <div key={i} className="border-border/60 border-t">
            {notices.length > 1 && <p className="truncate px-3 pt-2">{n.header}</p>}
            {n.report && (
              <div className="max-h-80 overflow-auto px-3 py-2 text-sm text-foreground">
                <Markdown text={n.report} />
              </div>
            )}
            {n.usage && (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-border/60 border-t px-3 py-1 text-[10px]">
                <span className="font-semibold tracking-wide text-foreground/75">Subagent</span>
                <span aria-hidden="true">·</span>
                <span>{t('{{count}} tokens', { count: formatTokens(n.usage.tokens) })}</span>
                <span aria-hidden="true">·</span>
                <span>{t('{{count}} tool calls', { count: n.usage.toolUses })}</span>
                <span aria-hidden="true">·</span>
                <span>{formatDuration(n.usage.durationMs)}</span>
              </div>
            )}
            {n.tasks && (
              <div className="border-border/60 border-t px-3 py-1 text-[11px]">
                <p className="text-foreground/75">
                  {t('Background tasks started by this subagent')}
                </p>
                {n.tasks.map((task) => (
                  <p key={task} className="truncate font-mono text-muted-foreground">
                    {task}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

function RawSyntheticNotice({ tag, body }: { tag: string; body: string }) {
  const [expanded, setExpanded] = useState(false);
  const trimmed = stripInjectedWrapperLines(body);
  if (!trimmed) return null;
  const nl = trimmed.indexOf('\n');
  const collapsible = nl > 0;
  const Icon = tag.startsWith('coworker-') || tag === 'agent-notification' ? Bot : TerminalSquare;
  return (
    <div className={NOTICE_FRAME}>
      <button
        type="button"
        disabled={!collapsible}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 text-left enabled:hover:text-foreground"
      >
        <Icon className={NOTICE_ICON} />
        <span className={cn('min-w-0 flex-1', collapsible ? 'truncate' : 'whitespace-pre-wrap')}>
          {collapsible ? trimmed.slice(0, nl) : trimmed}
        </span>
      </button>
      {collapsible && expanded && (
        <pre className="mt-1.5 max-h-80 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
          {trimmed.slice(nl + 1)}
        </pre>
      )}
    </div>
  );
}

const UPDATE_ICON: Record<SecretaryUpdateLine['kind'], typeof Bot> = {
  'goal-complete': Check,
  'goal-blocked': CircleAlert,
  'needs-user': UserRound,
  'turn-ended': MessagesSquare,
  failed: CircleX,
  stalled: Hourglass,
  interrupted: History,
  proposal: ClipboardCheck,
  schedule: AlarmClock,
  pending: Hourglass,
  'ask-relay': MessageCircleQuestion,
  leftover: Hourglass,
  queued: AlarmClock,
};

/** 秘书收到的派出会话回传与定时提醒：每条一行，点整行展开详情，右侧图标打开会话 */
function SecretaryUpdatesNotice({ lines }: { lines: SecretaryUpdateLine[] }) {
  return (
    <div data-enso="secretary-updates" className={cn(NOTICE_BOX, 'divide-y divide-border/60')}>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 回传内容不可变，顺序即身份
        <SecretaryUpdateRow key={i} line={line} onOpen={openSessionFromSecretary} />
      ))}
    </div>
  );
}

function SecretaryUpdateRow({
  line,
  onOpen,
}: {
  line: SecretaryUpdateLine;
  onOpen: ((conversationId: string) => void) | null | undefined;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const Icon = UPDATE_ICON[line.kind];
  const conversationId = 'conversationId' in line ? line.conversationId : undefined;
  const head = (
    <>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{line.text}</span>
    </>
  );
  return (
    <div data-enso="secretary-update" data-open={expanded ? 'true' : 'false'} className="px-3 py-2">
      <div className="flex items-start gap-2">
        {line.detail ? (
          <button
            type="button"
            data-enso="secretary-update-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="flex min-w-0 flex-1 items-start gap-2 text-left hover:text-foreground"
          >
            {head}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-2">{head}</div>
        )}
        {conversationId && onOpen ? (
          <button
            type="button"
            data-enso="secretary-update-open"
            title={t('Open session')}
            aria-label={t('Open session')}
            onClick={(event) => {
              event.stopPropagation();
              onOpen(conversationId);
            }}
            className="-mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {line.detail && expanded && (
        <pre className="mt-1.5 ml-5.5 max-h-60 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
          {line.detail}
        </pre>
      )}
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
      <div className="flex flex-wrap items-center gap-1">{chip}</div>
      {extra ? (
        <div className="mt-1.5 whitespace-pre-wrap break-words leading-relaxed">
          <InlineMentionText text={extra} />
        </div>
      ) : null}
    </div>
  );
}

/** /skill:name 展开后的 XML 块：气泡里每个块一个高亮 tag，点击看正文 */
function SkillInvocation({
  blocks,
  hostTaskWrapUp,
}: {
  blocks: NonNullable<ReturnType<typeof splitSkillBlocks>>;
  hostTaskWrapUp?: boolean;
}) {
  const notes = splitTurnNotes(blocks.rest);
  const wrapUp = hostTaskWrapUp ? leadingTaskWrapUp(blocks.rest) : undefined;
  const bubble = (
    <ChipBubble
      chip={
        <span className="inline-flex flex-wrap gap-1 align-middle">
          {blocks.skills.map((skill) => (
            <SkillTag key={skill.location} name={skill.name} content={skill.body} />
          ))}
        </span>
      }
      extra={notes.rest.trim()}
    />
  );
  if (!notes.plan && !notes.unattended && !wrapUp) return bubble;
  return (
    <>
      {notes.plan && <PlanNoteBanner note={notes.plan} />}
      {notes.unattended && <UnattendedNoteBanner note={notes.unattended} />}
      {wrapUp && <HostTaskWrapUp items={wrapUp.items} />}
      {bubble}
    </>
  );
}

function SlashInvocation({ text }: { text: string }) {
  const skills = parseSkillCommands(text);
  if (skills.names.length > 1) {
    return (
      <ChipBubble
        chip={
          <span className="inline-flex flex-wrap gap-1 align-middle">
            {skills.names.map((name) => (
              <SlashChip key={name} name={`/skill:${name}`} />
            ))}
          </span>
        }
        extra={skills.rest}
      />
    );
  }
  const parsed = splitSlashCommand(text);
  if (!parsed.slash) return null;
  return <ChipBubble chip={<SlashChip name={parsed.slash} />} extra={parsed.rest.trim()} />;
}

/** 侧边栏触发的预设工作流：卡片展示名称与参数，块后给模型的说明不显示 */
function WorkflowPresetInvocation({
  preset,
}: {
  preset: NonNullable<ReturnType<typeof parseWorkflowPresetMessage>>;
}) {
  const { t } = useI18n();
  return (
    <div className="min-w-64 max-w-[80%] overflow-hidden rounded-2xl rounded-br-md bg-muted text-sm">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-info/15 text-info">
          <Workflow className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">{t('Workflow preset')}</p>
          <p className="truncate font-medium" title={preset.id}>
            {preset.name || preset.id}
          </p>
        </div>
      </div>
      {preset.args.length > 0 && (
        <dl className="space-y-1 border-t border-border/60 px-3.5 py-2 text-xs">
          {preset.args.map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="shrink-0 font-mono text-muted-foreground">{key}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** 内联提及卡片：与输入框编辑器的卡片完全同款（图标 + 文件名/标题），
 * 保持在句子里的原位与顺序 */
function InlineMentionCard({
  kind,
  label,
  title,
}: {
  kind: 'file' | 'chat' | 'ui-element';
  label: string;
  title: string;
}) {
  const Icon = kind === 'file' ? FileText : kind === 'chat' ? History : BoxSelect;
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

/** chat 引用卡片：会话还在本机就点得开，找不到时保持不可点 */
function ChatRefCard({ label, sessionFile }: { label: string; sessionFile: string }) {
  const conversations = useSessionsStore((state) => state.conversations);
  const conversationId = conversationIdBySessionFile(conversations, sessionFile);
  if (!conversationId) return <InlineMentionCard kind="chat" label={label} title={sessionFile} />;
  return (
    <button
      type="button"
      data-enso="chat-ref"
      onClick={() => openSessionFromSecretary(conversationId)}
      title={sessionFile}
      className={cn(
        mentionChipClass('chat'),
        'mx-0.5 inline-flex max-w-52 items-center gap-1 rounded-md px-1.5 align-middle leading-4 hover:bg-muted'
      )}
    >
      <History className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

const QUOTE_BLOCK_MAX_HEIGHT = 240;

/** 选中文本引用块：左边框引用样式，代码围栏渲染为代码块，截断时标注原文行数；超高时底部渐隐，可展开 / 收起 */
export function QuoteBlock({ text, originalLines }: { text: string; originalLines?: number }) {
  const { t } = useI18n();
  const bodyRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    // scrollHeight 是内容全高，不受 max-height 影响，折叠/展开下判定一致
    const measure = () => setOverflowing(body.scrollHeight > QUOTE_BLOCK_MAX_HEIGHT + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  const clipped = overflowing && !expanded;
  return (
    <span
      data-enso="quote-block"
      className="mt-1 mb-2.5 block border-l-2 border-brand/40 pl-2.5 text-muted-foreground"
    >
      {originalLines ? (
        <span data-quote-truncated="" className="mb-0.5 block text-[11px] text-warning">
          {t('Truncated · original {{count}} lines', { count: originalLines })}
        </span>
      ) : null}
      <span
        ref={bodyRef}
        data-quote-body=""
        data-clipped={clipped ? '' : undefined}
        style={clipped ? { maxHeight: QUOTE_BLOCK_MAX_HEIGHT } : undefined}
        className={cn('block', clipped && 'overflow-hidden mask-b-from-60%')}
      >
        {splitQuoteFences(text).map((part, index) =>
          part.type === 'code' ? (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: 分段随文本快照整体替换
              key={index}
              data-quote-code=""
              className="my-1 block overflow-x-auto whitespace-pre rounded-md bg-background/60 px-2 py-1 font-mono text-xs"
            >
              {part.code}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: 分段随文本快照整体替换
            <span key={index}>{part.text}</span>
          )
        )}
      </span>
      {overflowing ? (
        <button
          type="button"
          data-quote-toggle=""
          data-quote-skip=""
          onClick={() => setExpanded((value) => !value)}
          className="mt-0.5 text-[11px] text-muted-foreground/80 select-none hover:text-foreground"
        >
          {expanded ? t('Show less') : t('Show more')}
        </button>
      ) : null}
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
  const segments = splitInlineMentions(stripBrowserElementBlocks(text));
  const counter = { n: 0 };
  return (
    <span className="whitespace-pre-wrap">
      {segments.map((segment, index) =>
        segment.type === 'file' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 同一文件可重复提及，分段随文本快照整体替换
          <LocalFileTrigger key={index} path={segment.path}>
            <InlineMentionCard
              kind="file"
              label={fileMentionBasename(segment.path)}
              title={segment.path}
            />
          </LocalFileTrigger>
        ) : segment.type === 'chat' ? (
          <ChatRefCard
            // biome-ignore lint/suspicious/noArrayIndexKey: 分段随文本快照整体替换
            key={index}
            label={segment.label}
            sessionFile={segment.sessionFile}
          />
        ) : segment.type === 'ui-element' ? (
          <InlineMentionCard
            // biome-ignore lint/suspicious/noArrayIndexKey: 分段随文本快照整体替换
            key={index}
            kind="ui-element"
            label={segment.label}
            title={`${segment.path}${segment.text ? ` · ${segment.text}` : ''}`}
          />
        ) : segment.type === 'quote' ? (
          <QuoteBlock
            // biome-ignore lint/suspicious/noArrayIndexKey: 分段随文本快照整体替换
            key={index}
            text={segment.text}
            originalLines={segment.originalLines}
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
        <LocalFileTrigger key={`f:${path}`} path={path}>
          <InlineMentionCard kind="file" label={fileMentionBasename(path)} title={path} />
        </LocalFileTrigger>
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

export const USER_BUBBLE =
  'max-w-[82%] rounded-[10px] bg-muted px-3.5 py-[9px] text-(length:--chat-body-size) leading-[1.6]';

/** 用户气泡：识别合成标记,渲染成系统事件行 / 角色块 / 来源徽章而非原始 XML */
function UserText({
  text,
  searchQuery = '',
  activeNth = -1,
  thumbnails = 0,
  align = 'end',
  hostTaskWrapUp = false,
}: {
  text: string;
  searchQuery?: string;
  activeNth?: number;
  /** 气泡上方已显示的缩略图张数 */
  thumbnails?: number;
  align?: 'start' | 'end';
  /** 正文前的收尾清单由宿主搭上（时间线按收尾提醒条目判定）；用户自己贴的照常显示 */
  hostTaskWrapUp?: boolean;
}) {
  const { t } = useI18n();
  const host = useChatHost();
  const botHost = Boolean(host?.speaker || host?.botSession);
  // 秘书贴图 / 转图时正文末尾追加的路径行：不露原文，换成缩略图 / 标签 / 提示
  const attached = splitInboundImageBlock(text, thumbnails);
  if (attached) {
    return (
      <>
        {attached.text && (
          <UserText
            text={attached.text}
            searchQuery={searchQuery}
            activeNth={activeNth}
            hostTaskWrapUp={hostTaskWrapUp}
          />
        )}
        <InboundImageList entries={attached.entries} thumbnails={thumbnails} align={align} />
      </>
    );
  }
  // 手机发来的话：卡片展示，正文按 markdown 渲染，不露包裹层
  const inbound = parseInboundMessage(text);
  if (inbound) return <TelegramInboundCard message={inbound} />;
  const injected = botHost ? parseBotInjectedMessage(text) : null;
  if (injected) return <InjectedMessageCard message={injected} />;
  // Main 投递前追加的笔记更新块不展示
  const withoutNotes = botHost ? stripBotNotesUpdate(text) : text;
  if (withoutNotes !== text)
    return (
      <UserText
        text={withoutNotes}
        searchQuery={searchQuery}
        activeNth={activeNth}
        hostTaskWrapUp={hostTaskWrapUp}
      />
    );
  // Bot 输入框 @聊天：Main 追加的摘录块折叠成 chip
  const chatRefs = botHost ? splitChatReferences(text) : null;
  if (chatRefs?.refs.length) {
    return (
      <div className="flex w-full flex-col items-end gap-1.5">
        {chatRefs.body && (
          <UserText text={chatRefs.body} searchQuery={searchQuery} activeNth={activeNth} />
        )}
        <div className="flex flex-wrap justify-end gap-1.5">
          {chatRefs.refs.map((ref) => (
            <span
              key={ref.id}
              title={t('Referenced chat')}
              className="inline-flex h-6 max-w-56 items-center gap-1 rounded-md bg-muted px-1.5 text-xs"
            >
              <MessagesSquare className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">{ref.title}</span>
            </span>
          ))}
        </div>
      </div>
    );
  }
  const planPrefix = splitPlanPrefix(text);
  if (planPrefix.note) {
    const remainder = planPrefix.rest.trim();
    return (
      <>
        <PlanNoteBanner note={planPrefix.note} />
        {remainder && (
          <UserText
            text={remainder}
            searchQuery={searchQuery}
            activeNth={activeNth}
            hostTaskWrapUp={hostTaskWrapUp}
          />
        )}
      </>
    );
  }
  const unattended = splitUnattendedPrefix(text);
  if (unattended.note) {
    const remainder = unattended.rest.trim();
    return (
      <>
        <UnattendedNoteBanner note={unattended.note} />
        {remainder && (
          <UserText
            text={remainder}
            searchQuery={searchQuery}
            activeNth={activeNth}
            hostTaskWrapUp={hostTaskWrapUp}
          />
        )}
      </>
    );
  }
  const wrapUp = hostTaskWrapUp ? splitTaskWrapUpPrefix(text) : null;
  if (wrapUp) {
    const remainder = wrapUp.rest.trim();
    return (
      <>
        <HostTaskWrapUp items={wrapUp.items} />
        {remainder && <UserText text={remainder} searchQuery={searchQuery} activeNth={activeNth} />}
      </>
    );
  }
  const branchNote = WORKSPACE_BRANCH_PREFIX.exec(text);
  if (branchNote) {
    const remainder = text.slice(branchNote[0].length).trim();
    return (
      <>
        <WorkspaceBranchBanner note={branchNote[1] ?? ''} />
        {remainder && <UserText text={remainder} searchQuery={searchQuery} activeNth={activeNth} />}
      </>
    );
  }
  const planMessage = parsePlanMessage(text);
  if (planMessage?.kind === 'approved') {
    return (
      <div className="flex w-full items-start gap-2 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
        <ClipboardCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">
          {t('Plan approved, executing')}
          <span className="ml-1.5 text-foreground">{planMessage.title}</span>
        </span>
      </div>
    );
  }
  if (planMessage?.kind === 'feedback') {
    return (
      <div className={cn(USER_BUBBLE, 'whitespace-pre-wrap')}>
        <p className="mb-1 flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          <ClipboardList className="h-3 w-3" />
          {t('Plan feedback')}
        </p>
        <InlineMentionText
          text={planMessage.feedback}
          searchQuery={searchQuery}
          activeNth={activeNth}
        />
      </div>
    );
  }
  const workflowPreset = parseWorkflowPresetMessage(text);
  if (workflowPreset) return <WorkflowPresetInvocation preset={workflowPreset} />;
  const refs = splitMentionRefs(text);
  const hasRefs = refs.files.length > 0 || refs.chats.length > 0;
  if (hasRefs) {
    const parsed = splitSlashCommand(refs.body);
    return (
      <div className={USER_BUBBLE}>
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
  const skillBlocks = splitSkillBlocks(text);
  if (skillBlocks) return <SkillInvocation blocks={skillBlocks} hostTaskWrapUp={hostTaskWrapUp} />;
  if (splitSlashCommand(text).slash) return <SlashInvocation text={text} />;
  const migrated = WORKSPACE_MIGRATED_PREFIX.exec(text);
  if (migrated) {
    const remainder = text.slice(migrated[0].length).trim();
    return (
      <>
        <WorkspaceMigratedBanner note={migrated[1]} />
        {remainder && <UserText text={remainder} searchQuery={searchQuery} activeNth={activeNth} />}
      </>
    );
  }
  const injectedBlocks = splitInjectedBlocks(text);
  if (injectedBlocks) {
    return (
      <InjectedSegments segments={injectedBlocks} searchQuery={searchQuery} activeNth={activeNth} />
    );
  }
  const updates = parseSecretaryUpdates(text);
  if (updates) return <SecretaryUpdatesNotice lines={updates} />;
  const role = ROLE_PREFIX.exec(text);
  const rest = role ? text.slice(role[0].length) : text;
  const fromMain = MAIN_AGENT_BLOCK.exec(rest);
  const body = fromMain ? fromMain[1] : rest;
  // 主 agent 的消息:左侧气泡 + 蓝色弱底 + markdown 渲染,与用户(右侧灰底纯文本)区分
  return (
    <div
      className={cn(
        fromMain
          ? 'max-w-[80%] rounded-2xl rounded-bl-md border border-blue-500/20 bg-blue-500/8 px-4 py-2.5 text-sm'
          : cn(USER_BUBBLE, 'whitespace-pre-wrap')
      )}
    >
      {fromMain && (
        <p className="mb-1 flex items-center gap-1 text-[10px] font-medium tracking-wide text-blue-600 uppercase dark:text-blue-400">
          <Bot className="h-3 w-3" />
          {t('From main agent')}
        </p>
      )}
      {role?.[1] && !isBtwIsolationPrompt(role[1]) && (
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

/** 精简模式下贴紧排的行：探索组头 / 只读一行 / 夹在其间的思考行（对齐 Cursor 的行距） */
export function isCompactRow(item: TimelineItem): boolean {
  return (
    item.kind === 'tool-group' ||
    item.kind === 'thinking' ||
    (item.kind === 'tool' && isReadOnlyTool(item))
  );
}

/** 手机 PWA 没有 subtle-foreground token，回落到 muted-foreground */
const SUBTLE_TEXT = 'text-[color:var(--subtle-foreground,var(--muted-foreground))]';
/** 进行中的文字统一呼吸 */
const BREATHE = 'animate-pulse motion-reduce:animate-none';

/** 每轮回复的头部：Bot 发言人身份 + 本轮模型 + 回复时间，挂在本轮首个回复行之上，运行中即可见 */
export function ReplyHeader({
  model,
  at,
  privacyMask,
  secretarySession = false,
  face: faceOverride,
  conversationId,
}: {
  model?: string;
  at?: number;
  privacyMask?: MaskReport;
  /** 这条时间线自己的会话属于秘书项目，与全局当前会话无关 */
  secretarySession?: boolean;
  /** 上层按会话所属秘书算好的脸；不传就用当前聚焦的秘书 */
  face?: SecretaryFaceModel | null;
  /** 这条回复所属的会话；用来取那个秘书的脸，而不是当前聚焦的秘书 */
  conversationId?: string;
}) {
  const host = useChatHost();
  const face = useSecretaryFace(conversationId);
  const secretarySpeaker = secretarySession ? (faceOverride ?? face) : null;
  const speaker = host?.speaker ?? (host ? null : secretarySpeaker);
  const secretaryMark = !host && secretarySpeaker ? true : undefined;
  const meta = [model, typeof at === 'number' ? formatClock(at) : null].filter(Boolean).join(' · ');
  if (!speaker && !meta && !privacyMask) return null;
  return (
    <div
      data-quote-skip=""
      className="mb-2 flex h-6 min-w-0 items-center gap-2 text-xs select-none"
    >
      {speaker &&
        (speaker.image ? (
          <img
            data-enso={secretaryMark ? 'secretary-chat-avatar' : undefined}
            data-image={secretaryMark ? 'true' : undefined}
            src={speaker.image}
            alt=""
            draggable={false}
            className="size-[22px] shrink-0 rounded-full object-cover"
            style={{ backgroundColor: speaker.color }}
          />
        ) : secretaryMark ? (
          <SecretaryFace
            name={speaker.name}
            color={speaker.color}
            enso="secretary-chat-avatar"
            className="size-[22px] rounded-full"
          />
        ) : (
          <span
            className="flex size-[22px] shrink-0 items-center justify-center rounded-full font-semibold text-[11px] text-white"
            style={{ backgroundColor: speaker.color }}
          >
            {[...speaker.name.trim()][0]?.toUpperCase() ?? '?'}
          </span>
        ))}
      {speaker && (
        <span className="shrink-0 truncate text-[13px] font-semibold text-foreground">
          {speaker.name}
        </span>
      )}
      {meta && <span className={cn('min-w-0 truncate text-[11.5px]', SUBTLE_TEXT)}>{meta}</span>}
      {privacyMask && <PrivacyMaskBadge report={privacyMask} />}
    </div>
  );
}

export const TimelineRow = memo(function TimelineRow({
  item,
  secretarySession = false,
  onToggleGroup,
  onToggleTurn,
}: TimelineRowProps) {
  const search = useChatSearchHighlight();
  const searchQuery = search.query;
  const activeNth = search.activeKey === item.key ? search.activeNth : -1;
  const secretaryChat = secretarySession;
  switch (item.kind) {
    case 'user': {
      const fromMain = item.text ? isFromMainAgent(item.text) : false;
      const isCollapsed = item.collapsed === true;
      const copyText = item.hostTaskWrapUp ? withoutTaskWrapUp(item.text) : item.text;
      return (
        <div
          data-enso="message-user"
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
            <UserText
              text={item.text}
              searchQuery={searchQuery}
              activeNth={activeNth}
              thumbnails={item.images.length}
              align={fromMain ? 'start' : 'end'}
              hostTaskWrapUp={item.hostTaskWrapUp === true}
            />
          )}
          {isCollapsed ? (
            <CollapsedTurnBar
              turnKey={item.key}
              text={copyText}
              timestamp={item.timestamp}
              turnDurationMs={item.turnDurationMs}
              onToggle={onToggleTurn}
            />
          ) : (
            <UserMeta
              turnKey={item.key}
              messageIndex={Number(item.key)}
              text={copyText}
              timestamp={item.timestamp}
              deliveryState={item.deliveryState}
              canCollapse={item.canCollapse}
              onToggleTurn={onToggleTurn}
            />
          )}
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
    case 'tool': {
      const proposalId = secretaryProposalId(item);
      const card = usesToolCard(item.name, secretaryChat);
      const body = (
        <>
          <PluginToolCardSlot name={item.name} output={item.output} state={item.state} />
          {card ? <ToolCallCards item={item} framed={secretaryChat} /> : <ToolRow item={item} />}
          {proposalId ? <SecretaryProposalRow proposalId={proposalId} /> : null}
          {item.pluginArtifacts ? (
            <PluginArtifactsCard
              artifacts={item.pluginArtifacts}
              align={card ? 'card' : 'tool-row'}
            />
          ) : null}
        </>
      );
      // 工具卡片和紧跟的结果卡片共用聊天列宽度，避免左边缩进把上面一张挤窄
      return card ? (
        <div data-enso="tool-card-pair" className="w-full min-w-0">
          {body}
        </div>
      ) : (
        body
      );
    }
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
    case 'interrupted':
      return <InterruptedRow item={item} />;
    case 'task-note':
      return <TaskNoteRow item={item} />;
    case 'compaction':
    case 'compaction-notice':
      return <CompactionRow item={item} />;
    case 'compaction-progress':
      return <CompactionProgressRow state={item.state} />;
    case 'session-custom':
      return <SessionCustomRow entry={item.entry} />;
    case 'plugin-message':
      return <PluginMessageRow item={item} />;
    case 'discarded-turn':
      return <DiscardedTurnRow item={item} onToggle={onToggleGroup} />;
    case 'resumed-reply':
      return <ResumedReplyRow item={item} onToggle={onToggleGroup} />;
    case 'divider':
      return (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          {item.text}
          <span className="h-px flex-1 bg-border" />
        </div>
      );
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

function OauthAccountRow({
  entry,
}: {
  entry: Extract<AgentSessionCustomEntry, { kind: 'oauth-account-selected' }>;
}) {
  const { t } = useI18n();
  const emails = useOauthAccountEmails();
  const current = emails.get(entry.accountKey);
  const previous = entry.previousAccountKey ? emails.get(entry.previousAccountKey) : undefined;
  const text = entry.previousAccountKey
    ? previous && current
      ? t('ChatGPT account switched: {{previous}} → {{current}}', { previous, current })
      : t('ChatGPT account switched')
    : current
      ? t('ChatGPT account selected: {{account}}', { account: current })
      : t('ChatGPT account selected');
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-xs">
      <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
      <p className="min-w-0 break-words text-muted-foreground">{text}</p>
    </div>
  );
}

/** 插件注入的消息：标明来源，样式与用户消息、模型回复都不同 */
function PluginMessageRow({ item }: { item: Extract<TimelineItem, { kind: 'plugin-message' }> }) {
  const { t } = useI18n();
  return (
    <div
      data-plugin-message={item.pluginId}
      className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-xs"
    >
      <p className="mb-1 flex items-center gap-1.5 text-muted-foreground">
        <PluginIcon pluginId={item.pluginId} className="h-3.5 w-3.5 shrink-0" />
        <span>{t('From plugin {{name}}', { name: item.pluginName })}</span>
        <span className="font-mono opacity-70">{item.pluginId}</span>
      </p>
      <div className={PLUGIN_BODY_CLASS}>
        <Markdown text={item.text} />
      </div>
    </div>
  );
}

/** 插件投递多是按行写的通知：段内换行照原样断行 */
const PLUGIN_BODY_CLASS = 'break-words text-foreground [&_p]:whitespace-pre-line';

/** 被 turn_discard 丢弃的插件投递：一行原因，展开看原文；模型上下文里只剩痕迹 */
function DiscardedTurnRow({
  item,
  onToggle,
}: {
  item: Extract<TimelineItem, { kind: 'discarded-turn' }>;
  onToggle?: (key: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div data-discarded-turn={item.pluginId}>
      <button
        type="button"
        onClick={() => onToggle?.(item.key)}
        data-enso="tool-row"
        className={cn(
          'group/step flex min-h-6 w-full items-center gap-2 text-left text-[13px] transition-colors hover:text-foreground',
          SUBTLE_TEXT
        )}
      >
        <SkipForward className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0 text-muted-foreground group-hover/step:text-foreground">
          {toolLabel('turn_discard', t)}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {[item.pluginName, item.reason].filter(Boolean).join(' · ')}
        </span>
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', item.expanded && 'rotate-90')}
        />
      </button>
      {item.expanded && (
        <div className="t-acc-reveal mt-1 mb-1.5 ml-5 space-y-2 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-xs">
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <PluginIcon pluginId={item.pluginId} className="h-3.5 w-3.5 shrink-0" />
            <span>{t('From plugin {{name}}', { name: item.pluginName })}</span>
          </p>
          {item.messages.map((text, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 投递原文只读、顺序固定
            <div key={i} className={PLUGIN_BODY_CLASS}>
              <Markdown text={text} />
            </div>
          ))}
          {item.tools.map((tool, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 只读工具记录只读、顺序固定
            <p key={i} className={cn('truncate', SUBTLE_TEXT)}>
              {toolLabel(tool.name, t)} {tool.summary}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** 重启时写到一半被中止、已在下方接着写的回复：默认一行，展开看原文（模型上下文里已拿掉） */
function ResumedReplyRow({
  item,
  onToggle,
}: {
  item: Extract<TimelineItem, { kind: 'resumed-reply' }>;
  onToggle?: (key: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div data-resumed-reply="">
      <button
        type="button"
        onClick={() => onToggle?.(item.key)}
        aria-expanded={item.expanded}
        data-enso="tool-row"
        className={cn(
          'group/step flex min-h-6 w-full items-center gap-2 text-left text-[13px] transition-colors hover:text-foreground',
          SUBTLE_TEXT
        )}
      >
        <Pause className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t('Interrupted by a restart, continued below')}
          <span className="ml-1.5 opacity-70">
            {item.expanded ? t('Hide the interrupted part') : t('Show the interrupted part')}
          </span>
        </span>
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', item.expanded && 'rotate-90')}
        />
      </button>
      {item.expanded && (
        <div className="t-acc-reveal mt-1 mb-1.5 ml-5 space-y-2 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-xs">
          {item.thinking && (
            <p className={cn('whitespace-pre-wrap break-words', SUBTLE_TEXT)}>{item.thinking}</p>
          )}
          {item.text && (
            <p className="whitespace-pre-wrap break-words text-foreground">{item.text}</p>
          )}
          {item.tools.map((tool, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 半截回复只读、顺序固定
            <p key={i} className={cn('truncate', SUBTLE_TEXT)}>
              {toolLabel(tool.name, t)} {tool.summary}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionCustomRow({ entry }: { entry: AgentSessionCustomEntry }) {
  const { t } = useI18n();
  if (entry.kind === 'oauth-account-selected') return <OauthAccountRow entry={entry} />;
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

  if (entry.kind === 'tool-batch-label') return null;
  if (entry.kind === 'task-wrap-up-nudge') {
    return (
      <div
        data-enso="task-wrap-up-nudge"
        className="my-1 flex items-center gap-1.5 text-[12px] text-subtle-foreground"
      >
        <Info className="size-3.5 shrink-0" />
        {t(
          '{{count}} background tasks are still undeclared; the next message asks the agent to stop each one or state why it keeps running',
          { count: entry.count }
        )}
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

const noSubscribe = () => () => {};

/**
 * 应用退出打断的一轮：说明是应用被关掉（含安装更新）而不是模型出错，
 * 有未完成的工具调用要点名，最后引导重试。
 */
function InterruptedRow({ item }: { item: Extract<TimelineItem, { kind: 'interrupted' }> }) {
  const { locale } = useI18n();
  const text = interruptNotice({
    at: item.at,
    kind: item.exitKind,
    unfinishedTools: item.unfinishedTools,
    lang: locale,
  });
  return (
    <div data-enso="timeline-interrupted" className="flex items-start gap-2 text-sm text-warning">
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p className="min-w-0 flex-1 whitespace-pre-wrap">{text}</p>
      <InterruptedRetryButton />
    </div>
  );
}

/** 中断的续跑入口：冷会话也能点（先唤醒再从断点续跑），与更新重启的续跑同一条路 */
function InterruptedRetryButton() {
  const { t } = useI18n();
  const canRetry = useSessionsStore((state) => {
    const conversation = displayedConversation(state);
    return Boolean(conversation && !conversation.spawning && conversation.status !== 'running');
  });
  if (!canRetry) return null;
  return (
    <button
      type="button"
      data-enso="timeline-interrupted-retry"
      title={t('Retry')}
      onClick={() => {
        const conversation = displayedConversation(useSessionsStore.getState());
        if (!conversation) return;
        void useSessionsStore.getState().retryInterrupted(conversation.id);
      }}
      className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      <RefreshCw className="h-3 w-3" />
      {t('Retry')}
    </button>
  );
}

/** 终态错误后续跑：已 spawn 且非 running 才显示（手机 stub started=false 自动隐藏） */
export function RetryTurnButton() {
  const { t } = useI18n();
  const host = useChatHost();
  const controls = host?.botControls;
  const sessionCanRetry = useSessionsStore((state) => {
    // 远程节点视图：协议无 retry，宿主显式关闭
    if (host && (!host.canRetry || host.botControls)) return false;
    const conversation = displayedConversation(state);
    return Boolean(
      conversation?.started && !conversation.spawning && conversation.status !== 'running'
    );
  });
  // Bot 私聊：投影在 bots store；冷会话由 Main 先恢复再续跑
  const retryable = () => {
    if (!controls || !host?.canRetry) return false;
    const projection = controls.projection();
    return Boolean(projection && projection.status !== 'running');
  };
  const botCanRetry = useSyncExternalStore(
    controls?.subscribe ?? noSubscribe,
    retryable,
    retryable
  );
  const canRetry = controls ? botCanRetry : sessionCanRetry;
  if (!canRetry) return null;
  return (
    <button
      type="button"
      title={t('Retry')}
      onClick={() => {
        if (controls) return controls.retry();
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

/** 回退：failed 也可；未 ready 的 spawning / 冷会话走 store 唤醒，不在这里强行显示不安全入口 */
function canRewindDisplayedSession(
  state: ReturnType<typeof useSessionsStore.getState>,
  host: ReturnType<typeof useChatHost>
) {
  return canShowConversationRewind(displayedConversation(state), host);
}

const userActionClass =
  'flex items-center gap-1 text-[11px] text-muted-foreground transition-opacity hover:text-foreground';

/** 分叉入口：与回退并列；idle 且分支层级未到上限时显示，冷会话点击时由 store 先唤醒 */
function ForkButton({ messageIndex }: { messageIndex: number }) {
  const { t } = useI18n();
  const host = useChatHost();
  const canFork = useSessionsStore((state) => {
    const conversation = displayedConversation(state);
    return canShowConversationFork(
      conversation,
      host,
      conversation ? forkDepth(state.conversations, conversation.id) : 1
    );
  });
  if (!canFork) return null;
  return (
    <button
      type="button"
      className={userActionClass}
      title={t('Keep this session and start a parallel one from here')}
      onClick={() => {
        const state = useSessionsStore.getState();
        const conversation = displayedConversation(state);
        if (!conversation) return;
        void state.forkFromTurn(conversation.id, messageIndex);
      }}
    >
      <GitBranch className="h-3 w-3" />
      {t('Conversation branch')}
    </button>
  );
}

function WithdrawButton({ messageIndex }: { messageIndex: number }) {
  const { t } = useI18n();
  const host = useChatHost();
  const conversationId = useSessionsStore((state) => displayedConversation(state)?.id);
  const deliveryId = useSessionsStore((state) => {
    const conversation = conversationId ? state.conversations[conversationId] : undefined;
    if (
      host ||
      !conversation ||
      conversation.historyOnly ||
      conversation.rewinding ||
      conversation.restoringFiles ||
      conversation.workspaceMigrating
    )
      return undefined;
    const message = conversation.messages[messageIndex - (conversation.historyBaseIndex ?? 0)];
    return canWithdrawMessage(message) ||
      (conversation.status === 'running' && canRequestWithdraw(message))
      ? message?.deliveryId
      : undefined;
  });
  if (!conversationId || !deliveryId) return null;
  return (
    <button
      type="button"
      title={t('Withdraw message')}
      onClick={() =>
        useSessionsStore
          .getState()
          .withdrawMessage(conversationId, { kind: 'delivery', id: deliveryId })
      }
      className="inline-flex items-center gap-1 hover:text-foreground"
    >
      <Undo2 className="h-3 w-3" />
      {t('Withdraw message')}
    </button>
  );
}

function RestartStuckButton() {
  const { t } = useI18n();
  const conversationId = useSessionsStore((state) => displayedConversation(state)?.id);
  if (!conversationId) return null;
  return (
    <button
      type="button"
      onClick={() => void restartConversationFromMenu(conversationId, t)}
      className="inline-flex items-center gap-1 hover:text-foreground"
    >
      <RotateCcw className="h-3 w-3" />
      {t('Restart conversation')}
    </button>
  );
}

function ResendButton({ messageIndex }: { messageIndex: number }) {
  const { t } = useI18n();
  const host = useChatHost();
  const conversationId = useSessionsStore((state) => displayedConversation(state)?.id);
  const deliveryId = useSessionsStore((state) => {
    const conversation = conversationId ? state.conversations[conversationId] : undefined;
    if (host || !conversation || conversation.historyOnly) return undefined;
    const message = conversation.messages[messageIndex - (conversation.historyBaseIndex ?? 0)];
    return canWithdrawMessage(message) ? message?.deliveryId : undefined;
  });
  if (!conversationId || !deliveryId) return null;
  return (
    <button
      type="button"
      title={t('Resend')}
      onClick={() => useSessionsStore.getState().resendMessage(conversationId, deliveryId)}
      className="inline-flex items-center gap-1 hover:text-foreground"
    >
      <RefreshCw className="h-3 w-3" />
      {t('Resend')}
    </button>
  );
}

/** 回退入口：已 spawn 非 spawning，或可 resume 的历史主会话。未恢复 coworker / remote / historyOnly 不显示；活 child 保持。 */
function RewindButton({ messageIndex }: { messageIndex: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  /** 确认框绑定打开时的会话与持久化消息，不能随时间线位置漂移。 */
  const [pending, setPending] = useState<{
    restoreFiles: boolean;
    conversationId: string;
    entryId: string;
  } | null>(null);
  const host = useChatHost();
  const controls = host?.botControls;
  const sessionCanRewind = useSessionsStore((state) => {
    if (host?.botControls) return false;
    const conversation = displayedConversation(state);
    return (
      canRewindDisplayedSession(state, host) &&
      Boolean(
        conversation &&
          resolveRewindConfirm(conversation.id, conversation.id, conversation, messageIndex)
      )
    );
  });
  /** Bot 私聊：该行可回退时返回目标 user entryId（原始值选择，避免流式更新重渲染每行） */
  const rewindTarget = () => {
    if (!controls || !host?.canRewind || !host.sessionId) return null;
    const projection = controls.projection();
    if (!projection || projection.status === 'running') return null;
    return (
      resolveRewindConfirm(host.sessionId, host.sessionId, projection, messageIndex)?.entryId ??
      null
    );
  };
  const botEntryId = useSyncExternalStore(
    controls?.subscribe ?? noSubscribe,
    rewindTarget,
    rewindTarget
  );
  const canRewind = controls ? botEntryId !== null : sessionCanRewind;
  if (!canRewind) return null;
  const queueRewind = (restoreFiles: boolean) => {
    if (controls && host?.sessionId && botEntryId) {
      setPending({ restoreFiles, conversationId: host.sessionId, entryId: botEntryId });
      return;
    }
    const conversation = displayedConversation(useSessionsStore.getState());
    if (!conversation) return;
    const target = resolveRewindConfirm(
      conversation.id,
      conversation.id,
      conversation,
      messageIndex
    );
    if (target)
      setPending({ restoreFiles, conversationId: conversation.id, entryId: target.entryId });
  };
  const rewind = (restoreFiles: boolean, originId: string, entryId: string) => {
    if (controls) return controls.rewind(entryId, restoreFiles);
    const state = useSessionsStore.getState();
    const displayed = displayedConversation(state);
    const target = resolveRewindConfirm(
      originId,
      displayed?.id,
      state.conversations[originId],
      messageIndex,
      entryId
    );
    if (!target) return;
    state.rewind(target.conversationId, target.entryId, restoreFiles);
  };
  const options = [
    {
      icon: Undo2,
      label: t('Conversation only'),
      desc: t('Rewind to this message'),
      restoreFiles: false,
      action: () => queueRewind(false),
    },
    {
      icon: History,
      label: t('Conversation + files'),
      desc: t('Rewind and restore files to before this turn'),
      restoreFiles: true,
      action: () => queueRewind(true),
    },
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={userActionClass} title={t('Rewind to this message')}>
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
              option.action();
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
        open={pending !== null}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setPending(null);
        }}
        title={t('Rewind to this message?')}
        description={
          pending?.restoreFiles
            ? t(
                'Later messages leave the current branch and working-tree files are restored to before this turn.'
              )
            : t('Later messages leave the current branch; the text returns to the input box.')
        }
        confirmLabel={t('Rewind')}
        onConfirm={() => {
          if (pending) rewind(pending.restoreFiles, pending.conversationId, pending.entryId);
        }}
      />
    </Popover>
  );
}

function CollapsedTurnBar({
  turnKey,
  text,
  timestamp,
  turnDurationMs,
  onToggle,
}: {
  turnKey: string;
  text: string;
  timestamp?: number;
  turnDurationMs?: number;
  onToggle?: (key: string, collapsed: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      data-quote-skip=""
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80 select-none"
    >
      <button
        type="button"
        onClick={() => onToggle?.(turnKey, false)}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground cursor-pointer border border-border/40"
        title={t('Expand')}
      >
        <ChevronRight className="h-3 w-3 shrink-0" />
        <span>{t('Expand')}</span>
      </button>
      <UserPromptCopy text={text} />
      {typeof timestamp === 'number' && <span>{formatClock(timestamp)}</span>}
      {turnDurationMs !== undefined && (
        <span>· {t('took {{duration}}', { duration: formatDuration(turnDurationMs) })}</span>
      )}
    </div>
  );
}

/** 用户气泡操作条上的复制：悬停才出现，和助手复制按钮同一套剪贴板反馈。空白正文不占位。 */
function UserPromptCopy({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <span data-enso="copy-user-prompt" className="inline-flex">
      <CopyButton
        text={quotesAsMarkdown(text)}
        className="opacity-0 transition-opacity group-hover/user:opacity-100 focus-visible:opacity-100"
      />
    </span>
  );
}

function UserMeta({
  turnKey,
  messageIndex,
  text,
  timestamp,
  canCollapse,
  deliveryState,
  onToggleTurn,
}: {
  turnKey: string;
  messageIndex: number;
  text: string;
  timestamp?: number;
  canCollapse?: boolean;
  deliveryState?: 'pending' | 'rejected' | 'stuck';
  onToggleTurn?: (key: string, collapsed: boolean) => void;
}) {
  const { t } = useI18n();
  const autoCollapseTurns = useSettingsStore((s) => s.autoCollapseTurns);
  return (
    <div
      data-quote-skip=""
      className="flex items-center gap-2 text-[11px] text-muted-foreground/75 select-none"
    >
      <RewindButton messageIndex={messageIndex} />
      <ResendButton messageIndex={messageIndex} />
      <WithdrawButton messageIndex={messageIndex} />
      <UserPromptCopy text={text} />
      {deliveryState && (
        <span>
          {t(
            deliveryState === 'stuck'
              ? 'Not sent: the previous turn is stuck and could not be interrupted. Restart the conversation, then resend.'
              : deliveryState === 'rejected'
                ? 'Not sent'
                : 'Delivery unconfirmed'
          )}
        </span>
      )}
      {deliveryState === 'stuck' && <RestartStuckButton />}
      {autoCollapseTurns && canCollapse && onToggleTurn && (
        <button
          type="button"
          onClick={() => onToggleTurn(turnKey, true)}
          className={cn(userActionClass, 'cursor-pointer opacity-0 group-hover/user:opacity-100')}
          title={t('Collapse')}
        >
          <ChevronDown className="h-3 w-3 shrink-0" />
          <span>{t('Collapse')}</span>
        </button>
      )}
      {typeof timestamp === 'number' && <span>{formatClock(timestamp)}</span>}
    </div>
  );
}

/** 轮次末尾收起：开关与 UserMeta 顶部收起一致 */
export function TurnCollapseFooter({
  turnKey,
  canCollapse,
  collapsed,
  onToggleTurn,
}: {
  turnKey: string;
  canCollapse?: boolean;
  collapsed?: boolean;
  onToggleTurn?: (key: string, collapsed: boolean) => void;
}) {
  const { t } = useI18n();
  const autoCollapseTurns = useSettingsStore((s) => s.autoCollapseTurns);
  if (!autoCollapseTurns || !canCollapse || !onToggleTurn || collapsed) return null;
  return (
    <button
      type="button"
      data-enso="turn-collapse"
      data-quote-skip=""
      onClick={() => onToggleTurn(turnKey, true)}
      className={cn(
        'mt-1 flex min-h-6 select-none items-center gap-1 text-[12px] transition-colors hover:text-foreground [@media(hover:none)]:min-h-10 [@media(hover:none)]:pr-3',
        SUBTLE_TEXT
      )}
    >
      <ChevronUp className="h-3 w-3" />
      <span>{t('Collapse')}</span>
    </button>
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
  const host = useChatHost();
  const perfStr = item.perf ? formatPerf(item.perf, t, item.turnDurationMs !== undefined) : '';
  const localSessionId = useSessionsStore((state) => displayedConversation(state)?.id ?? null);
  const messageIndex = Number(item.key.split('-')[0]);
  const pluginActionProps = {
    text: item.text,
    messageIndex,
    sessionId: host ? host.sessionId : localSessionId,
  };
  return (
    <div data-enso="message-assistant" className="group text-(length:--chat-body-size)">
      <Markdown
        text={item.text}
        streaming={item.streaming}
        searchQuery={searchQuery}
        activeNth={activeNth}
        leaf={{
          messageIndex: pluginActionProps.messageIndex,
          sessionId: pluginActionProps.sessionId,
        }}
      />
      {item.turnEnd && !item.streaming && host?.turnFooter?.(Number(item.key.split('-')[0]))}
      {!item.streaming && (
        <div
          data-quote-skip=""
          className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        >
          <PluginMessageActions position="left" {...pluginActionProps} />
          <CopyButton text={item.text} />
          <PluginMessageActions position="right" {...pluginActionProps} />
          {item.turnEnd && <ForkButton messageIndex={Number(item.key.split('-')[0])} />}
          {item.timestamp && !item.turnEnd && <span>{formatClock(item.timestamp)}</span>}
          {item.turnDurationMs !== undefined && (
            <span>
              {item.timestamp && !item.turnEnd && '· '}
              {t('took {{duration}}', { duration: formatDuration(item.turnDurationMs) })}
            </span>
          )}
          {perfStr && <span>· {perfStr}</span>}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, className }: { text: string; className?: string }) {
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
      className={cn('flex items-center gap-1 transition-colors hover:text-foreground', className)}
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
/** 末 step 读数：本 step 耗时 · TTFT · tok/s；多 step 轮次再附「总计 Xs」= 整轮活跃用时 */
function formatPerf(perf: TurnPerf, t: TFunction, hasTurnDuration = false): string {
  const parts: string[] = [];
  // 单 step 的用时已由「took」展示；多 step 仍保留末 step 墙钟（turnMs 有值）
  if (!hasTurnDuration || perf.turnMs !== undefined) {
    parts.push(`${secs(perf.runMs)}s`);
  }
  if (perf.ttftMs !== undefined) parts.push(`TTFT ${secs(perf.ttftMs)}s`);
  if (perf.tps !== undefined) parts.push(`${Math.round(perf.tps)} tok/s`);
  if (!hasTurnDuration && perf.turnMs !== undefined) {
    parts.push(t('total {{duration}}', { duration: formatDuration(perf.turnMs) }));
  }
  return parts.join(' · ');
}

/** 长思考块点底部收起时，行头已滚出视口外则计算拉回视口所需的 scrollTop 偏移量；已在视口内返回 0 */
export function thinkingCollapseScrollDelta(
  rowRect: { top: number; bottom: number },
  viewportRect: { top: number; bottom: number },
  padding = 16
): number {
  if (rowRect.top < viewportRect.top) return rowRect.top - viewportRect.top - padding;
  if (rowRect.bottom > viewportRect.bottom) return rowRect.bottom - viewportRect.bottom + padding;
  return 0;
}

function findScrollContainer(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    if (current.hasAttribute('data-virtuoso-scroller')) return current;
    const overflowY =
      typeof window.getComputedStyle === 'function'
        ? window.getComputedStyle(current).overflowY
        : current.style.overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return current;
    current = current.parentElement;
  }
  return null;
}

/** 收起后行头若已滚出视口，把它拉回视口内；scroller 缺省时向上查找滚动容器 */
export function restoreRowIntoView(
  row: HTMLElement,
  scroller: HTMLElement | null = findScrollContainer(row)
): void {
  if (!scroller) {
    if (row.getBoundingClientRect().top < 0) row.scrollIntoView?.({ block: 'nearest' });
    return;
  }
  const delta = thinkingCollapseScrollDelta(
    row.getBoundingClientRect(),
    scroller.getBoundingClientRect()
  );
  if (delta !== 0) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
}

/** Think 行：仅在 expandLiveReasoning 时流式展开、结束收起；手动点击覆盖默认 */
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
  const expandLiveReasoning = useSettingsStore((s) => s.expandLiveReasoning);
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = thinkingRowExpanded(userToggled, streaming, expandLiveReasoning);
  const rowRef = useRef<HTMLDivElement>(null);
  const restoreScrollRef = useRef(false);

  useLayoutEffect(() => {
    if (expanded || !restoreScrollRef.current) return;
    restoreScrollRef.current = false;
    if (rowRef.current) restoreRowIntoView(rowRef.current);
  }, [expanded]);

  return (
    <div ref={rowRef} data-enso="thinking" data-live={streaming || undefined}>
      <button
        type="button"
        data-quote-skip=""
        onClick={() => setUserToggled(!expanded)}
        className={cn(
          'flex min-h-6 select-none items-center gap-2 text-[13px] transition-colors hover:text-foreground',
          SUBTLE_TEXT
        )}
      >
        <span className="flex size-3 shrink-0 items-center justify-center">
          <Brain className={cn('size-3', streaming && 'animate-pulse text-brand')} />
        </span>
        {streaming ? (
          <span className={cn('text-foreground', BREATHE)}>{t('Thinking…')}</span>
        ) : durationMs !== null ? (
          <span>{t('Thought for {{duration}}', { duration: formatDuration(durationMs) })}</span>
        ) : (
          <span>{t('Thought process')}</span>
        )}
        {streaming && <RunningElapsed itemKey={itemKey} since={startedAt} />}
        <ChevronRight className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && <PluginThinkingBody text={text} streaming={streaming} itemKey={itemKey} />}
      {expanded && !streaming && (
        <button
          type="button"
          data-enso="thinking-collapse"
          data-quote-skip=""
          onClick={() => {
            restoreScrollRef.current = true;
            setUserToggled(false);
          }}
          className={cn(
            'mt-1 ml-[31px] flex min-h-6 select-none items-center gap-1 text-[12px] transition-colors hover:text-foreground',
            SUBTLE_TEXT
          )}
        >
          <ChevronUp className="h-3 w-3" />
          <span>{t('Collapse thinking')}</span>
        </button>
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
  const logPath =
    /(?:read ((?:\/|[A-Za-z]:[\\/]).+?\.log) for the complete log|Full log: ((?:\/|[A-Za-z]:[\\/])\S+?\.log))/
      .exec(item.detail)
      ?.slice(1)
      .find(Boolean) ?? null;

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
                : stripAnsi(log ?? t('(log unavailable)'))
              : t('(no log available)')}
          </pre>
        </div>
      )}
    </div>
  );
}

function CompactionProgressRow({
  state,
}: {
  state: Extract<TimelineItem, { kind: 'compaction-progress' }>['state'];
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <LoaderCircle className="h-3 w-3 animate-spin" />
      <span>{state === 'queued' ? t('Compacts after this turn') : t('Compacting…')}</span>
    </div>
  );
}

/**
 * compaction 分隔：之上的历史已被压缩出模型上下文；点击展开看模型拿到的摘要。
 * compaction-notice（锚在压缩时刻的提示）**不画分隔线**：它上方还包含仍在
 * 上下文里的保留段，画成线会被误读成「此线之上都已压出上下文」。
 */
function CompactionRow({
  item,
}: {
  item: Extract<TimelineItem, { kind: 'compaction' | 'compaction-notice' }>;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const divider = item.kind === 'compaction';
  const tokens = item.tokensBefore === null ? null : formatTokens(item.tokensBefore);
  const freed = compactionFreedPercent(item.tokensBefore, item.tokensAfter);
  const label =
    freed !== null && item.tokensBefore !== null && item.tokensAfter !== undefined
      ? t('{{kind}} · {{before}} → {{after}} · freed {{percent}}%', {
          kind: t(
            item.memory
              ? 'Memory context compacted'
              : item.verified
                ? 'Verified context compacted'
                : 'Context compacted'
          ),
          before: formatTokens(item.tokensBefore),
          after: formatTokens(item.tokensAfter),
          percent: freed,
        })
      : item.memory
        ? tokens === null
          ? t('Memory context compacted')
          : t('Memory context compacted ({{tokens}} tokens before)', { tokens })
        : item.verified
          ? tokens === null
            ? t('Verified context compacted')
            : t('Verified context compacted ({{tokens}} tokens before)', { tokens })
          : tokens === null
            ? t('Context compacted')
            : t('Context compacted ({{tokens}} tokens before)', { tokens });
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn('flex items-center gap-3', divider && 'w-full')}
        title={
          item.memory
            ? t(
                'Summary rendered from continuous memory. Messages above are no longer in the model context; use recall for sources.'
              )
            : item.verified
              ? t(
                  'Verified summary from smart compaction. Messages above are no longer in the model context.'
                )
              : divider
                ? t('Messages above are no longer in the model context; only this summary is.')
                : t('Latest compaction summary — expand to read what the model kept.')
        }
      >
        {divider && <span className="h-px flex-1 bg-border" />}
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          <PackageMinus className="h-3 w-3" />
          {label}
          <ChevronRight className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')} />
        </span>
        {divider && <span className="h-px flex-1 bg-border" />}
      </button>
      {expanded && (
        <pre className="mt-1.5 max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/20 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {item.summary || t('(summary unavailable)')}
        </pre>
      )}
    </div>
  );
}

/** 收拢的工具组头：摘要统计 + chevron；点击展开为组内原始行。compact 下对齐 Cursor：Explored / Exploring */
function ToolGroupRow({
  item,
  onToggle,
}: {
  item: Extract<TimelineItem, { kind: 'tool-group' }>;
  onToggle?: (key: string) => void;
}) {
  const { t } = useI18n();
  const compact = useSettingsStore((s) => s.compactReadOnlyTools);
  const parts: string[] = [];
  if (item.stats.commands > 0)
    parts.push(t('ran {{count}} commands', { count: item.stats.commands }));
  if (item.stats.reads > 0) parts.push(t('read {{count}} files', { count: item.stats.reads }));
  if (item.stats.searches > 0)
    parts.push(t('searched {{count}} times', { count: item.stats.searches }));
  if (item.stats.others > 0) parts.push(t('{{count}} other calls', { count: item.stats.others }));
  const explored: string[] = [];
  if (compact) {
    if (item.stats.reads > 0) explored.push(t('{{count}} files', { count: item.stats.reads }));
    if (item.stats.searches > 0)
      explored.push(t('{{count}} searches', { count: item.stats.searches }));
  }
  const activity = item.activity;
  const activityParts: string[] = [];
  if (activity) {
    if (activity.thinking > 0)
      activityParts.push(t('{{count}} thinking steps', { count: activity.thinking }));
    if (item.count > 0) activityParts.push(t('{{count}} tool calls', { count: item.count }));
  }
  const explore = item.explore;
  const breathing = item.exploring || Boolean(activity && item.live);
  const noticeLabel =
    item.notice === 'patrol' ? t('Patrol clear') : item.notice === 'seen' ? t('Update seen') : null;
  const label = explore
    ? toolLabel('explore_fold', t)
    : noticeLabel
      ? noticeLabel
      : activity
        ? t('Worked for {{duration}}', { duration: formatDuration(activity.workedMs) })
        : compact
          ? item.exploring
            ? t('Exploring')
            : t('Explored')
          : t('{{count}} tool calls', { count: item.count });
  const detail = explore
    ? [explore.goal, t('{{count}} tool calls', { count: item.count })].filter(Boolean)
    : noticeLabel
      ? activityParts
      : item.summary && !item.exploring
        ? [item.summary]
        : activity
          ? activityParts
          : compact
            ? explored
            : parts;
  const head = (
    <button
      type="button"
      onClick={() => {
        if (explore?.steps) onToggle?.(exploreStepsKey(item.key));
        onToggle?.(item.key);
      }}
      title={explore?.goal}
      data-explore-head={explore ? '' : undefined}
      data-enso="tool-row"
      data-notice={item.notice}
      className={cn(
        'group/step flex min-h-6 w-full items-center gap-2 text-left text-[13px] transition-colors hover:text-foreground',
        SUBTLE_TEXT
      )}
    >
      <StepDot state={item.exploring ? 'running' : 'ok'} />
      <span
        className={cn(
          'shrink-0 text-muted-foreground group-hover/step:text-foreground',
          breathing && cn(BREATHE, 'text-foreground'),
          item.exploring && 'font-medium'
        )}
      >
        {label}
      </span>
      <span className={cn('min-w-0 flex-1 truncate', breathing && BREATHE)}>
        {detail.join(' · ')}
      </span>
      <ChevronRight
        className={cn('h-3 w-3 shrink-0 transition-transform', item.expanded && 'rotate-90')}
      />
    </button>
  );
  if (!explore || !item.expanded) return head;
  // 探索组首层展开只给目标与结果，过程另开一层才平铺原始行
  return (
    <>
      {head}
      <div
        data-slot="tool-details"
        className="t-acc-reveal mt-1 mb-1.5 ml-5 overflow-hidden rounded-lg border border-border/70 bg-card text-sm shadow-xs"
      >
        {explore.goal && (
          <div className="border-b border-border/60 px-3 py-2">
            <div className="mb-0.5 text-[11px] text-muted-foreground">{t('Goal')}</div>
            <p className="whitespace-pre-wrap">{explore.goal}</p>
          </div>
        )}
        {explore.report && (
          <div className="border-b border-border/60 px-3 py-2">
            <div className="mb-0.5 text-[11px] text-muted-foreground">{t('Result')}</div>
            <Markdown text={explore.report} />
          </div>
        )}
        <button
          type="button"
          onClick={() => onToggle?.(exploreStepsKey(item.key))}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <ChevronRight
            className={cn('h-3 w-3 shrink-0 transition-transform', explore.steps && 'rotate-90')}
          />
          <span>{explore.steps ? t('Hide process') : t('Show process')}</span>
          <span>· {t('{{count}} tool calls', { count: item.count })}</span>
        </button>
      </div>
    </>
  );
}

/** 工具详情独立跟随底部：用户上滚时暂停，滚回底部后恢复。 */
function ToolContentScroller({
  children,
  className,
  follow,
}: {
  children: ReactNode;
  className?: string;
  follow: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(follow);
  const followEnabledRef = useRef(follow);
  const programmaticTargetRef = useRef<number | null>(null);
  const touchYRef = useRef<number | null>(null);
  const frameRef = useRef(0);
  followEnabledRef.current = follow;

  const pauseFollowing = useCallback(() => {
    followingRef.current = false;
    programmaticTargetRef.current = null;
    cancelAnimationFrame(frameRef.current);
  }, []);
  const pinToBottom = useCallback(() => {
    if (!followEnabledRef.current || !followingRef.current) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (!scroller || !followEnabledRef.current || !followingRef.current) return;
      const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      programmaticTargetRef.current = target;
      scroller.scrollTop = target;
    });
  }, []);

  useEffect(() => {
    if (follow) {
      followingRef.current = true;
      pinToBottom();
    } else {
      programmaticTargetRef.current = null;
      cancelAnimationFrame(frameRef.current);
    }
  }, [follow, pinToBottom]);
  useEffect(pinToBottom);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(pinToBottom);
    observer.observe(content);
    return () => observer.disconnect();
  }, [pinToBottom]);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  return (
    <div
      ref={scrollerRef}
      onWheel={(event) => {
        if (event.deltaY < 0) pauseFollowing();
      }}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        pauseFollowing();
      }}
      onTouchStart={(event) => {
        touchYRef.current = event.touches[0]?.clientY ?? null;
      }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY;
        if (y !== undefined && touchYRef.current !== null && y > touchYRef.current) {
          pauseFollowing();
        }
        touchYRef.current = y ?? null;
      }}
      onTouchEnd={() => {
        touchYRef.current = null;
      }}
      onScroll={(event) => {
        if (!followEnabledRef.current) return;
        const scroller = event.currentTarget;
        const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
        if (atBottom) {
          followingRef.current = true;
          programmaticTargetRef.current = null;
          return;
        }
        const target = programmaticTargetRef.current;
        if (target !== null && scroller.scrollTop >= target - 2) {
          programmaticTargetRef.current = null;
          pinToBottom();
          return;
        }
        pauseFollowing();
      }}
      className={cn('max-h-96 overflow-auto [overflow-anchor:none]', className)}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

function formatSandboxValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function SandboxOutput({
  source,
  output,
  view,
}: {
  source?: string | null;
  output: string | null;
  view: SandboxView | null;
}) {
  const value =
    view?.status === 'completed' ? formatSandboxValue(view.value) : (view?.error ?? output);
  return (
    <div className="space-y-1 px-3 py-1">
      {source ? <CodeBlock code={source} language="javascript" /> : null}
      {view && view.calls.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {[...new Map(view.calls.map((call) => [call.name, call])).keys()].map((name) => {
            const group = view.calls.filter((call) => call.name === name);
            const failed = group.find((call) => !call.ok);
            const label = `${name} ×${group.length}`;
            return (
              <span
                key={name}
                className={cn(
                  'rounded-md border px-1.5 py-0.5 font-mono text-[10px]',
                  failed ? 'border-destructive/40 text-destructive' : 'text-muted-foreground'
                )}
                title={group
                  .map((call) => call.summary)
                  .filter(Boolean)
                  .join('\n')}
              >
                {failed ? `${label} · ${failed.error ?? 'error'}` : label}
              </span>
            );
          })}
        </div>
      ) : null}
      {value ? (
        view?.status === 'completed' && typeof view.value !== 'string' ? (
          <CodeBlock code={value} language="json" />
        ) : (
          <pre className="font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
            {stripAnsi(value)}
          </pre>
        )
      ) : null}
      {view?.console ? (
        <pre className="border-l-2 pl-2 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {stripAnsi(view.console)}
        </pre>
      ) : null}
    </div>
  );
}

/** read 图片：按原文件渲染，限制最大边，点开看全图。加载失败时退回文本详情 */
export function ReadImagePreview({ path, fallback }: { path: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <div data-slot="read-image" className="w-full min-w-0 px-3 py-3">
      <ZoomableImage
        src={toLocalImageUrl(path)}
        onError={() => setFailed(true)}
        frameClassName="block w-full"
        className="mx-auto block max-h-80 max-w-full rounded-md bg-muted/40 object-contain"
      />
    </div>
  );
}

/** 单行工具摘要：状态点/图标 + 工具名 + 参数摘要；edit 展开为 diff,write 展开为写入内容,其余为输出 */
function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const { t } = useI18n();
  const host = useChatHost();
  const compactReadOnly = useSettingsStore((s) => s.compactReadOnlyTools);
  const expandLiveEdits = useSettingsStore((s) => s.expandLiveEdits);
  const compact = compactReadOnly && item.name !== 'bash' && isReadOnlyTool(item);
  const hasDiff = Boolean(item.edits && item.edits.length > 0);
  const hasWrite = Boolean(item.writeContent);
  const hasFileChanges = Boolean(item.fileChanges && item.fileChanges.length > 0);
  const sandbox = item.sandbox ?? null;
  // 消息类工具展开显示发出的正文（投递回执已在 timeline 剥掉）；出错时只显示错误输出
  const sentMessage = item.state === 'error' ? null : item.sentMessage;
  const hasImage = Boolean(item.imagePath) && item.state !== 'error';
  const labelKey = TOOL_LABEL_KEYS[item.name];
  const mcp = parseMcpToolName(item.name);
  // 空清单是「清空」而不是产物：不画 0/0 卡片，收成一行
  const todoCleared = item.state !== 'error' && item.todos?.length === 0;
  // 子代理按 id 指代的操作：动作词在前，长标题截断时动作仍可见
  const summary = todoCleared
    ? t('Todo list cleared')
    : item.subagentOp
      ? [t(SUBAGENT_OP_LABEL_KEYS[item.subagentOp]), item.summary].filter(Boolean).join(' · ')
      : item.summary;
  const headerSummary =
    item.nestedPending && item.state === 'running'
      ? `${summary} · ${item.nestedPending} pending`
      : sandbox?.calls.length && item.state !== 'error'
        ? summarizeSandboxCalls(sandbox.calls)
        : summary;
  const hasBody = !todoCleared && Boolean(item.output || item.source || sentMessage || item.ask);
  // 子代理等待行：运行中可展开看在等的子代理各自在干什么
  const waitProgress = item.state === 'running' && item.waiting === 'subagent' && !host;
  const expandable = hasDiff || hasWrite || hasFileChanges || hasBody || waitProgress || hasImage;
  // edit 的 diff 与 write 的内容只在本轮直播（running）且开启 expandLiveEdits 时默认展开；
  // 历史会话挂载时全部折叠——否则切会话时视口内成排 FileDiff 同步解析+高亮，
  // 主线程阻塞几秒白屏
  const autoExpand =
    expandLiveEdits && (hasDiff || hasWrite || hasImage) && item.state === 'running';
  const [expanded, setExpanded] = useState(autoExpand);
  const [userOpened, setUserOpened] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const hold = useToolHold();
  useEffect(() => {
    if (!userOpened) return;
    const node = rowRef.current;
    if (!node) return;
    const key = item.key;
    const report = hold.report;
    const observer = new IntersectionObserver(
      ([entry]) => report(key, entry?.isIntersecting === true),
      { root: hold.scroller.current }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      report(key, false);
    };
  }, [userOpened, item.key, hold]);
  const memoryHits =
    expanded && item.name === 'memory_search' ? parseMemorySearchHits(item.output) : null;
  const memoryCapture =
    expanded && item.name === 'memory_capture'
      ? parseMemoryCapture(item.output, item.memoryContent)
      : null;
  const subagentReceipt =
    expanded && item.name === 'subagent' && item.state !== 'error'
      ? parseSubagentReceipt(item.subagentOp, item.output)
      : null;
  const subagentError =
    item.name === 'subagent' && item.state === 'error' ? subagentErrorReason(item.output) : null;
  const previouslyHadFileChanges = useRef(hasFileChanges);
  // apply_patch 只在终态结果中拿到真实 diff：必须按「本行从无到有」识别直播，历史首次挂载不展开。
  useEffect(() => {
    const appliedChangesArrived = shouldAutoExpandAppliedFileChanges(
      item,
      previouslyHadFileChanges.current
    );
    previouslyHadFileChanges.current = hasFileChanges;
    if (autoExpand || (expandLiveEdits && appliedChangesArrived)) setExpanded(true);
  }, [autoExpand, expandLiveEdits, hasFileChanges, item]);

  if (item.todos && item.todos.length > 0) return <TodoRow todos={item.todos} />;
  if (item.name.startsWith('goal_')) return <GoalSignalRow item={item} />;
  if (item.plan && item.state !== 'error') return <PlanRow plan={item.plan} />;

  return (
    <div
      ref={rowRef}
      data-enso="tool-row"
      data-tool-style={compact ? 'compact' : 'full'}
      data-user-open={userOpened ? 'true' : undefined}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={!expandable}
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            setUserOpened(next);
            hold.report(item.key, next);
          }}
          className={cn(
            'group/step flex min-h-6 min-w-0 flex-1 items-center gap-2 text-left text-[13px]',
            SUBTLE_TEXT,
            expandable && 'cursor-pointer'
          )}
        >
          <StepDot state={item.state} />
          <span
            className={cn(
              'shrink-0 text-muted-foreground transition-colors group-hover/step:text-foreground',
              item.state === 'running' && cn(BREATHE, 'text-foreground')
            )}
          >
            {labelKey ? t(labelKey) : (mcp?.tool ?? item.name)}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate font-mono text-[12px]',
              item.state === 'error' ? 'text-destructive' : 'text-muted-foreground',
              item.state === 'running' && BREATHE
            )}
          >
            {item.state === 'error' && item.output
              ? summary && item.name === 'apply_patch' && hasFileChanges
                ? `${headerSummary} · ${firstLine(item.output)}`
                : subagentError
                  ? t(subagentError)
                  : shellFailureHeadline(stripAnsi(item.output))
              : summary
                ? headerSummary
                : null}
          </span>
          {item.backgroundTaskId && (
            <span
              className="shrink-0 text-[11px] text-muted-foreground"
              title={item.backgroundTaskId}
            >
              {t('Moved to background')}
            </span>
          )}
          {item.shellFailure && item.state !== 'running' && (
            <ShellFailureBadge failure={item.shellFailure} />
          )}
          {item.dcgWarning && <DcgWarningBadge warning={item.dcgWarning} />}
          {item.state === 'reviewing' ? (
            <span className={cn('shrink-0 text-[11px] text-foreground', BREATHE)}>
              {t('Assistant reviewing…')}
            </span>
          ) : item.state === 'running' && item.startedAt !== null ? (
            <>
              {item.callId && (item.name === 'bash' || item.name === 'powershell') && (
                <ShellRunStatusLive
                  callId={item.callId}
                  startedAt={item.startedAt}
                  output={item.output ?? ''}
                />
              )}
              <RunningElapsed itemKey={item.key} since={item.startedAt ?? undefined} />
            </>
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
                'h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/step:opacity-100',
                expanded && 'rotate-90 opacity-100'
              )}
            />
          )}
        </button>
        {item.state === 'running' && item.callId && !host && (
          <MoveToBackgroundButton callId={item.callId} waiting={Boolean(item.waiting)} />
        )}
        {(hasDiff || hasWrite || hasFileChanges) && (item.state === 'ok' || hasFileChanges) && (
          <button
            type="button"
            title={t('Open in side panel')}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => addSidePanelChanges()}
          >
            <GitCompare className="h-3 w-3" />
          </button>
        )}
      </div>
      {item.generatedImages?.length ? (
        <div data-slot="generated-images" className="mt-2 mb-3 ml-5 grid gap-3">
          {item.generatedImages.map((path) => (
            <ReadImagePreview
              key={path}
              path={path}
              fallback={<p className="break-all px-3 py-2 text-xs text-muted-foreground">{path}</p>}
            />
          ))}
        </div>
      ) : null}
      {expanded && expandable && (
        // 展开内容收进与工具名对齐的卡片
        <div
          data-slot="tool-details"
          className="t-acc-reveal mt-1 mb-1.5 ml-5 overflow-hidden rounded-lg border border-border/70 bg-card shadow-xs"
        >
          {mcp && (
            <div className="truncate border-b border-border/60 px-3 py-1 font-mono text-[10px] text-muted-foreground">
              {mcp.server}.{mcp.tool}
            </div>
          )}
          {waitProgress && (
            <SubagentWaitProgress
              agentIds={item.subagentTitles ? Object.keys(item.subagentTitles) : undefined}
            />
          )}
          {hasDiff && item.edits && (
            <ToolContentScroller follow={item.state === 'running'}>
              <Suspense fallback={null}>
                <EditDiff path={item.summary} blocks={item.edits} />
              </Suspense>
            </ToolContentScroller>
          )}
          {hasFileChanges && item.fileChanges && (
            <ToolContentScroller follow={item.state === 'running'}>
              {item.fileChanges.map((change, index) => (
                <div
                  key={`${change.type}:${diffCacheKey(change.path, change.oldText, change.newText)}`}
                >
                  <div
                    className={cn(
                      'flex items-center gap-2 border-border/60 px-3 py-1 font-mono text-[10px] text-muted-foreground',
                      (index > 0 || hasDiff) && 'border-t'
                    )}
                  >
                    <span className="uppercase">{change.type}</span>
                    <span className="min-w-0 flex-1 truncate" title={change.path}>
                      {change.path}
                    </span>
                    {change.truncated && <span>{t('Truncated preview')}</span>}
                  </div>
                  <Suspense fallback={null}>
                    <EditDiff path={change.path} blocks={[change]} snapshot={change} />
                  </Suspense>
                </div>
              ))}
            </ToolContentScroller>
          )}
          {shouldShowToolOutputAfterFileChanges(item) && (
            <ToolContentScroller follow={false} className="border-t border-border/60">
              <pre className="px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                {stripAnsi(item.output ?? '')}
              </pre>
            </ToolContentScroller>
          )}
          {hasWrite && item.writeContent && (
            <ToolContentScroller
              follow={item.state === 'running'}
              className={cn((hasDiff || hasFileChanges) && 'border-t border-border/60')}
            >
              <Suspense fallback={null}>
                <ReadFileView path={item.summary} contents={item.writeContent} />
              </Suspense>
            </ToolContentScroller>
          )}
          {!hasDiff && !hasWrite && !hasFileChanges && (hasBody || hasImage) && (
            <ToolContentScroller follow={item.state === 'running'}>
              {isSandboxTool(item.name) ? (
                <SandboxOutput source={item.source} output={item.output} view={sandbox} />
              ) : item.name === 'bash' || item.name === 'powershell' ? (
                <TerminalOutput
                  command={item.summary}
                  output={item.output ?? ''}
                  failure={item.shellFailure}
                />
              ) : item.name === 'read' && hasImage && item.imagePath ? (
                <ReadImagePreview
                  key={item.imagePath}
                  path={item.imagePath}
                  fallback={
                    <Suspense fallback={null}>
                      <ReadFileView path={item.summary} contents={item.output ?? ''} />
                    </Suspense>
                  }
                />
              ) : item.name === 'image_view' && item.state === 'ok' ? (
                <ImageViewResult image={item.image} output={item.output} />
              ) : item.name === 'read' ? (
                <Suspense fallback={null}>
                  <ReadFileView path={item.summary} contents={item.output ?? ''} />
                </Suspense>
              ) : item.name === 'subagent' &&
                item.state !== 'error' &&
                !sentMessage &&
                !subagentReceipt ? (
                <div className="px-3 py-2 text-sm">
                  <Markdown text={item.output ?? ''} />
                </div>
              ) : memoryHits ? (
                <MemorySearchResults hits={memoryHits} />
              ) : memoryCapture ? (
                <MemoryCaptureResult view={memoryCapture} />
              ) : (
                <>
                  {item.ask && <AskUserResult ask={item.ask} waiting={item.state === 'running'} />}
                  {sentMessage && (
                    <div className="px-3 py-2 text-sm">
                      <Markdown text={sentMessage} />
                    </div>
                  )}
                  {subagentReceipt ? (
                    <SubagentResult view={subagentReceipt} titles={item.subagentTitles} />
                  ) : (
                    item.output && (
                      <pre className="px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                        {stripAnsi(item.output)}
                      </pre>
                    )
                  )}
                </>
              )}
              <RtkToolStatsBar value={item.rtk} />
              <ApprovalReviewBar value={item.approvalReview} />
            </ToolContentScroller>
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
function PlanRow({ plan }: { plan: { title: string; text: string } }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 text-left text-xs"
      >
        <ClipboardList className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-muted-foreground">{t('Plan')}</span>
        <span className="min-w-0 flex-1 truncate">{plan.title}</span>
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
      </button>
      {expanded && (
        <div className="mt-2 border-border/60 border-t pt-2 text-sm">
          <Markdown text={plan.text} />
        </div>
      )}
    </div>
  );
}

function TodoRow({ todos }: { todos: TodoItem[] }) {
  const { t } = useI18n();
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <div data-enso="todo" className="rounded-lg border bg-card px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ListTodo className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium text-foreground">{t('Todos')}</span>
        <span className="ml-auto tabular-nums">
          {done}/{todos.length}
        </span>
      </div>
      <TodoProgress done={done} total={todos.length} className="mt-1.5 mb-2" />
      <TodoList todos={todos} />
    </div>
  );
}

/** 切会话会卸载时间线，挂载时刻不能当起点。有 since 用打点；否则按会话+行 key 记住第一次出现的时刻。 */
const elapsedStartByKey = new Map<string, number>();

/** 运行中的前台命令移交为后台任务，或结束阻塞等待（被等的继续跑）；worker 拒绝时稍后恢复可点 */
function MoveToBackgroundButton({ callId, waiting }: { callId: string; waiting: boolean }) {
  const { t } = useI18n();
  const sessionId = useSessionsStore((state) => displayedConversation(state)?.id ?? '');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(false), 5000);
    return () => clearTimeout(timer);
  }, [pending]);
  if (!sessionId) return null;
  const label = waiting
    ? pending
      ? t('Stopping wait…')
      : t('Stop waiting')
    : pending
      ? t('Moving to background…')
      : t('Move to background');
  const Icon = waiting ? SkipForward : ArrowDownToLine;
  return (
    <button
      type="button"
      disabled={pending}
      title={label}
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
      onClick={() => {
        setPending(true);
        void window.electronAPI.agent.backgroundTool(sessionId, callId).then(
          (result) => {
            if (!result.ok) setPending(false);
          },
          () => setPending(false)
        );
      }}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

/** 主路径是 Main 推送；慢速轮询只做自愈兜底（推送链路任一环断了也能收敛） */
const WAIT_PROGRESS_POLL_MS = 5000;
const NO_RUNS: AgentRunProgress[] = [];

function runActivityLabel(run: AgentRunProgress, t: TFunction): string {
  if (run.status === 'queued') return t('Queued');
  const activity = run.activity;
  if (activity?.phase === 'tool') return [activity.tool, activity.detail].filter(Boolean).join(' ');
  return activity?.phase === 'writing' ? t('Writing reply…') : t('Thinking…');
}

/** 子代理等待行展开：在等的子代理各自在干什么、跑了多久、最近说了什么（Main 推送 + 兜底轮询） */
function SubagentWaitProgress({ agentIds }: { agentIds?: string[] }) {
  const { t } = useI18n();
  const sessionId = useSessionsStore((state) => displayedConversation(state)?.id ?? '');
  const runs = useSubagentRunsStore((state) => state.byConversation[sessionId] ?? NO_RUNS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    const replace = (next: AgentRunProgress[]) => {
      if (!alive) return;
      useSubagentRunsStore.getState().replace(sessionId, next);
      setLoaded(true);
    };
    const load = () => window.electronAPI.agent.subagentProgress(sessionId).then(replace, () => {});
    const unsubscribe = window.electronAPI.agent.onSubagentProgress((push) => {
      if (push.sessionId === sessionId) replace(push.runs);
    });
    void load();
    const timer = setInterval(load, WAIT_PROGRESS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [sessionId]);
  if (!loaded) return null;
  // wait 只列它等的子代理；spawn / send 带 wait 时行上没有 agentId，列出全部在跑的
  const visible = agentIds?.length ? runs.filter((run) => agentIds.includes(run.agentId)) : runs;
  return (
    <div className="border-b border-border/60 px-3 py-2 text-xs">
      {visible.length === 0 ? (
        <div className="text-muted-foreground">{t('No running subagents')}</div>
      ) : (
        visible.map((run) => (
          <div key={run.runId} className="py-0.5">
            <div className="flex items-center gap-2">
              <span className="max-w-[40%] shrink-0 truncate font-medium">
                {run.title ?? run.agentId.slice(0, 8)}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                {runActivityLabel(run, t)}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
                {formatDuration(run.elapsedMs)}
              </span>
            </div>
            {run.text && (
              <div className="line-clamp-2 break-words pl-2 text-[11px] text-muted-foreground/80">
                {run.text.replace(/\s+/g, ' ')}
              </div>
            )}
          </div>
        ))
      )}
      <div className="mt-1 text-[11px] text-muted-foreground/80">
        {t(
          'Stopping the wait does not stop subagents; the assistant is notified when they finish.'
        )}
      </div>
    </div>
  );
}

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

/** 运行中命令的让位倒计时与静默徽章；远程节点视图没有本机 deadline，只显示静默 */
function ShellRunStatusLive({
  callId,
  startedAt,
  output,
}: {
  callId: string;
  startedAt: number | null | undefined;
  output: string;
}) {
  const host = useChatHost();
  const deadlineAt = useSessionsStore((state) =>
    host ? undefined : displayedConversation(state)?.toolDeadlineAt?.[callId]
  );
  return <ShellRunStatus startedAt={startedAt} deadlineAt={deadlineAt} output={output} />;
}

/** 日志式工具行：普通工具行与工具组头，相邻时贴紧排 */
export function isToolStepRow(item: TimelineItem): boolean {
  if (item.kind === 'tool-group') return true;
  return item.kind === 'tool' && !item.todos?.length && !item.name.startsWith('goal_');
}

const firstLine = (text: string): string => stripAnsi(text.split('\n', 1)[0] ?? '');
