import type { BackgroundTaskInfo, SubagentActivity, SubagentInfo } from '@shared/types/agent';
import { modelDisplayName } from '@shared/virtualModels';
import {
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Cpu,
  FileText,
  LoaderCircle,
  type LucideIcon,
  Pin,
  Search,
  Terminal,
  Unplug,
  Wrench,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { parseMcpToolName, unwrapMcpProxyCall } from '@/lib/mcpToolName';
import { stripAnsi } from '@/lib/terminalText';
import { formatBytes } from '@/lib/toolCards/render';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { formatDuration } from '@/stores/sessions/stats';
import { useSettingsStore } from '@/stores/settings';
import {
  clockText,
  IdleActions,
  idleLabel,
  KeepLine,
  keepBackgroundTask,
  StopTaskButton,
  shortSpan,
  spanText,
  stopBackgroundTask,
  TaskBadge,
  TaskNode,
  TaskStatusBadge,
  taskView,
  useNow,
} from './backgroundTaskUi';
import { Markdown } from './Markdown';
import { StepNode } from './StepNode';
import { summarizeSubagentToolArgs } from './subagentToolSummary';
import { shouldFollowTaskBarOutput } from './taskBarScroll';

interface TaskBarProps {
  sessionId: string;
  tasks: BackgroundTaskInfo[];
  subagents: SubagentInfo[];
  /** 手机只读配对：停止会被 host 拦截，不给按钮 */
  readOnly?: boolean;
}

/** 按会话记住已收起的条目。TaskBar 用 conversation.id 当 key，切会话/coworker 会卸载重挂，组件 state 会丢。 */
const dismissedBySession = new Map<string, Set<string>>();

const readDismissed = (sessionId: string): Set<string> => {
  const cached = dismissedBySession.get(sessionId);
  return cached ? new Set(cached) : new Set();
};

const writeDismissed = (sessionId: string, next: Set<string>): Set<string> => {
  dismissedBySession.set(sessionId, next);
  return next;
};

/** 本次运行中见过 running 的条目。首次出现即终态（重启后由快照/缓存恢复的历史）不再闪现。 */
const seenRunningBySession = new Map<string, Set<string>>();

const trackRunning = (sessionId: string, ids: string[]): ReadonlySet<string> => {
  const seen = seenRunningBySession.get(sessionId) ?? new Set<string>();
  seenRunningBySession.set(sessionId, seen);
  for (const id of ids) seen.add(id);
  return seen;
};

/**
 * 后台任务状态行（grok-build 风）：输入框上方每任务一行；
 * 点「查看」在行下内嵌展开输出;done 5s 自动移除,failed 手动关闭。
 */
export function TaskBar({ sessionId, tasks, subagents, readOnly }: TaskBarProps) {
  const virtualModels = useSettingsStore((state) => state.virtualModels);
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => readDismissed(sessionId));
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const pendingOpen = useSessionsStore((s) => s.pendingAgentOpen);

  useEffect(() => {
    if (!pendingOpen || pendingOpen.sessionId !== sessionId) return;
    setOpenTaskId(pendingOpen.agentId);
    useSessionsStore.setState({ pendingAgentOpen: null });
  }, [pendingOpen, sessionId]);
  const seenRunning = trackRunning(sessionId, [
    ...tasks.filter((task) => task.status === 'running').map((task) => task.taskId),
    ...subagents.filter((agent) => agent.status === 'running').map((agent) => agent.id),
  ]);
  const shown = (id: string, status: string) =>
    !dismissed.has(id) && (status === 'running' || seenRunning.has(id));
  const visible = tasks.filter((task) => shown(task.taskId, task.status));
  const visibleAgents = subagents.filter((agent) => shown(agent.id, agent.status));

  // 结束的条目(done/failed)5s 后自动收起（展开中的不收）
  useEffect(() => {
    const seen = seenRunningBySession.get(sessionId);
    const finished = [
      ...tasks.filter((task) => task.status !== 'running').map((task) => task.taskId),
      ...subagents.filter((agent) => agent.status !== 'running').map((agent) => agent.id),
    ].filter((id) => seen?.has(id) && !dismissed.has(id) && id !== openTaskId);
    if (finished.length === 0) return;
    const timer = setTimeout(() => {
      setDismissed((prev) => {
        const next = new Set(prev);
        for (const id of finished) next.add(id);
        return writeDismissed(sessionId, next);
      });
    }, 5000);
    return () => clearTimeout(timer);
  }, [sessionId, tasks, subagents, dismissed, openTaskId]);

  if (visible.length === 0 && visibleAgents.length === 0) return null;

  const dismiss = (taskId: string) => {
    setDismissed((prev) => writeDismissed(sessionId, new Set(prev).add(taskId)));
    if (openTaskId === taskId) setOpenTaskId(null);
  };

  const openTask = visible.find((task) => task.taskId === openTaskId) ?? null;
  const openAgent = visibleAgents.find((agent) => agent.id === openTaskId) ?? null;

  return (
    <div className="relative mb-1.5">
      {(openTask || openAgent) && (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-1.5 rounded-xl border bg-card shadow-float">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {openTask ? openTask.command : openAgent?.description}
              {openAgent?.modelId ? ` · ${modelDisplayName(virtualModels, openAgent.modelId)}` : ''}
            </span>
            {openTask && (
              <TaskPanelActions sessionId={sessionId} task={openTask} readOnly={readOnly} />
            )}
            <button
              type="button"
              onClick={() => setOpenTaskId(null)}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {openTask && <TaskDetails sessionId={sessionId} task={openTask} readOnly={readOnly} />}
          {openAgent && <AgentDetails key={openAgent.id} agent={openAgent} />}
        </div>
      )}
      <div className="flex flex-col gap-0.5 rounded-xl border bg-card p-1 shadow-xs">
        {visible.map((task) => (
          <TaskRow
            key={task.taskId}
            sessionId={sessionId}
            task={task}
            readOnly={readOnly}
            open={openTaskId === task.taskId}
            onToggle={() => setOpenTaskId(openTaskId === task.taskId ? null : task.taskId)}
            onDismiss={() => dismiss(task.taskId)}
          />
        ))}
        {visibleAgents.map((agent) => (
          <DockRow
            key={agent.id}
            icon={Bot}
            status={agent.status}
            meta={<AgentMeta agent={agent} />}
            open={openTaskId === agent.id}
            onToggle={() => setOpenTaskId(openTaskId === agent.id ? null : agent.id)}
            stopTitle={t('Stop subagent')}
            onStop={
              readOnly
                ? undefined
                : () => void window.electronAPI.agent.stopSubagent(sessionId, agent.id)
            }
            onDismiss={() => dismiss(agent.id)}
          >
            {agent.agentType && <span className="shrink-0 font-medium">{agent.agentType}</span>}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {agent.description}
              {agent.modelId && (
                <span className="text-muted-foreground/60">
                  {' '}
                  · {modelDisplayName(virtualModels, agent.modelId)}
                </span>
              )}
              {agent.status === 'running' && agent.currentActivity && (
                <span className="text-muted-foreground/60"> · {agent.currentActivity}</span>
              )}
            </span>
          </DockRow>
        ))}
      </div>
    </div>
  );
}

/** 后台任务 / subagent 共用一行：与时间线工具行同一节点列与字号 */
function DockRow({
  icon,
  status,
  meta,
  open,
  onToggle,
  stopTitle,
  onStop,
  onDismiss,
  children,
}: {
  icon: LucideIcon;
  status: 'running' | 'done' | 'failed';
  meta: ReactNode;
  open: boolean;
  onToggle: () => void;
  stopTitle: string;
  onStop?: () => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[30px] min-w-0 items-center gap-2 px-1 text-[13px]">
      <StepNode
        icon={icon}
        state={status === 'running' ? 'running' : status === 'failed' ? 'error' : 'ok'}
      />
      {children}
      {meta}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {t('Output')}
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {status === 'running' ? (
        onStop && (
          <button
            type="button"
            onClick={onStop}
            title={stopTitle}
            className="flex h-6 shrink-0 items-center rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            {t('Stop')}
          </button>
        )
      ) : (
        <button
          type="button"
          onClick={onDismiss}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** 后台任务一行：疑似闲置琥珀底 + 行内「保留」「停止」，保留的任务下方一行理由 */
function TaskRow({
  sessionId,
  task,
  readOnly,
  open,
  onToggle,
  onDismiss,
}: {
  sessionId: string;
  task: BackgroundTaskInfo;
  readOnly?: boolean;
  open: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const now = useNow();
  const view = taskView(task);
  return (
    <div
      data-enso="background-task-row"
      data-view={view}
      className={cn(
        'flex min-h-[30px] min-w-0 items-center gap-2 rounded-lg px-1 text-[13px]',
        view === 'kept' && 'py-1',
        view === 'idle' && 'bg-warning/[0.06]',
        open && 'bg-muted'
      )}
    >
      <TaskNode task={task} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate font-mono text-xs text-muted-foreground"
            title={task.command}
          >
            {task.command}
          </span>
          {view === 'idle' && <TaskBadge tone="pending">{idleLabel(task, now, t)}</TaskBadge>}
        </div>
        <KeepLine task={task} className="mt-0.5" />
      </div>
      <TaskMeta task={task} />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          open && 'bg-foreground/[0.06] text-foreground'
        )}
      >
        {t('Output')}
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {task.status === 'running' ? (
        readOnly ? null : view === 'idle' ? (
          <IdleActions sessionId={sessionId} taskId={task.taskId} />
        ) : (
          <StopTaskButton onStop={() => stopBackgroundTask(sessionId, task.taskId)} />
        )
      ) : (
        <button
          type="button"
          onClick={onDismiss}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function TaskPanelActions({
  sessionId,
  task,
  readOnly,
}: {
  sessionId: string;
  task: BackgroundTaskInfo;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const now = useNow();
  const view = taskView(task);
  return (
    <>
      <TaskStatusBadge task={task} now={now} />
      {!readOnly && view === 'idle' && <IdleActions sessionId={sessionId} taskId={task.taskId} />}
      {!readOnly && view === 'kept' && (
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => keepBackgroundTask(sessionId, task.taskId, null)}
        >
          {t('Unkeep')}
        </Button>
      )}
    </>
  );
}

function Evidence({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-2 py-1.5">
      <Icon className="size-3.5 shrink-0 text-warning" />
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="ml-auto shrink-0 font-medium tabular-nums">{value}</span>
    </div>
  );
}

function MetaLine({ children }: { children: ReactNode }) {
  return <div className="text-[11px] text-subtle-foreground tabular-nums">{children}</div>;
}

/** 展开的任务：疑似闲置给三条依据，保留的给理由（手动保留可补一句），下面是最近输出 */
function TaskDetails({
  sessionId,
  task,
  readOnly,
}: {
  sessionId: string;
  task: BackgroundTaskInfo;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const now = useNow();
  const view = taskView(task);
  const ran = shortSpan(now - task.startedAt);
  const ports = task.idle?.ports ?? [];
  const extra = view === 'idle' || view === 'kept';
  return (
    <>
      {view === 'idle' && (
        <div className="space-y-2.5 px-3 py-2.5 text-xs">
          <div className="grid grid-cols-3 gap-1.5">
            <Evidence
              icon={Clock}
              label={t('No new output')}
              value={spanText(now - (task.idle?.since ?? now), t)}
            />
            <Evidence
              icon={Unplug}
              label={
                ports.length > 0 ? t('Port {{ports}}', { ports: ports.join(', ') }) : t('Ports')
              }
              value={ports.length > 0 ? t('No connections') : t('Not listening')}
            />
            <Evidence icon={Cpu} label="CPU" value="0%" />
          </div>
          <MetaLine>
            {t('Running for {{duration}} · Suspected idle tasks are never stopped automatically', {
              duration: ran,
            })}
          </MetaLine>
        </div>
      )}
      {view === 'kept' && task.keep && (
        <div className="space-y-2.5 px-3 py-2.5 text-xs">
          <div className="flex items-start gap-2 rounded-md bg-muted px-2.5 py-2">
            <Pin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              {task.keep.by === 'user' && !readOnly ? (
                <input
                  key={task.keep.at}
                  data-enso="background-task-keep-reason"
                  defaultValue={task.keep.reason ?? ''}
                  maxLength={200}
                  placeholder={t('Add a reason (optional)')}
                  className="w-full bg-transparent text-[13px] outline-none placeholder:text-subtle-foreground"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                  onBlur={(event) => {
                    const reason = event.currentTarget.value.trim();
                    if (reason !== (task.keep?.reason ?? ''))
                      keepBackgroundTask(sessionId, task.taskId, reason);
                  }}
                />
              ) : (
                <div className="text-[13px]">{task.keep.reason ?? '—'}</div>
              )}
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {task.keep.by === 'agent'
                  ? t('Kept by the agent at {{time}} when wrapping up', {
                      time: clockText(task.keep.at),
                    })
                  : t('Kept by you at {{time}}', { time: clockText(task.keep.at) })}
              </div>
            </div>
          </div>
          <MetaLine>{t('Running for {{duration}}', { duration: ran })}</MetaLine>
        </div>
      )}
      {extra && (
        <div className="flex items-center gap-2 border-t border-border/60 px-3 pt-2 text-[11px] text-subtle-foreground">
          <span>{t('Recent output')}</span>
        </div>
      )}
      <TailView
        tail={task.tail}
        outputBytes={task.outputBytes}
        running={task.status === 'running'}
        framed={!extra}
      />
    </>
  );
}

function AgentDetails({ agent }: { agent: SubagentInfo }) {
  const { t } = useI18n();
  const activities = agent.activities ?? [];
  const ref = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 流式活动或终态报告变化时贴底
  useEffect(() => {
    const el = ref.current;
    if (el && followingRef.current) el.scrollTop = el.scrollHeight;
  }, [activities, agent.resultText]);
  return (
    <div
      ref={ref}
      className="max-h-96 space-y-2 overflow-auto px-3 py-2 text-sm"
      onScroll={(event) => {
        followingRef.current = shouldFollowTaskBarOutput(event.currentTarget);
      }}
    >
      {activities.map((activity) => (
        <AgentActivityView key={activity.id} activity={activity} />
      ))}
      {activities.length === 0 && !agent.resultText && (
        <pre className="font-mono text-xs whitespace-pre-wrap text-muted-foreground">
          {(agent.activityLog ?? []).join('\n') || t('(no output yet)')}
        </pre>
      )}
      {agent.detailsPruned && (
        <div className="rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
          {t('Earlier activity details were cleared; the final report is still available.')}
        </div>
      )}
      {agent.resultText && agent.status !== 'running' && (
        <section
          className={cn(
            'rounded-lg border px-3 py-2',
            agent.status === 'failed'
              ? 'border-destructive/30 bg-destructive/5'
              : 'border-blue-500/30 bg-blue-500/5'
          )}
        >
          <div className="mb-1.5 font-medium text-xs text-foreground">{t('Final report')}</div>
          <Markdown text={agent.resultText} />
        </section>
      )}
    </div>
  );
}

export function AgentActivityView({ activity }: { activity: SubagentActivity }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (activity.type === 'assistant') {
    return (
      <section className="rounded-md bg-muted/30 px-2.5 py-2">
        <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('Assistant')}
        </div>
        <FoldedContent text={activity.text} markdown />
      </section>
    );
  }
  const summary = summarizeSubagentToolArgs(activity.toolName, activity.argumentsText);
  const toolName = unwrapMcpProxyCall(activity.toolName, activity.argumentsText).name;
  const mcp = parseMcpToolName(toolName);
  const contentId = `subagent-tool-${activity.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return (
    <section className="border-b border-border/40 last:border-b-0">
      <button
        type="button"
        aria-controls={contentId}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-muted/50"
      >
        <SubagentToolIcon toolName={toolName} />
        <span className="shrink-0 font-medium text-foreground/80">{mcp?.tool ?? toolName}</span>
        {summary && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
            title={summary}
          >
            {summary}
          </span>
        )}
        {!summary && <span className="min-w-0 flex-1" />}
        <SubagentToolStatus status={activity.status} label={t(activity.status)} />
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
      </button>
      {expanded && (
        <div id={contentId} className="ml-5 border-border/50 border-l pb-2 pl-2.5">
          {mcp && (
            <div className="mb-1 truncate font-mono text-[10px] text-muted-foreground/70">
              {mcp.server}.{mcp.tool}
            </div>
          )}
          <div className="text-[10px] text-muted-foreground/70">{t('Arguments')}</div>
          <pre className="max-h-28 overflow-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground/80">
            {stripAnsi(activity.argumentsText)}
          </pre>
          {activity.outputText && (
            <div className="mt-1.5 border-border/40 border-t pt-1.5">
              <div className="mb-0.5 text-[10px] text-muted-foreground">{t('Result')}</div>
              <pre className="overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/80">
                {stripAnsi(activity.outputText)}
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SubagentToolIcon({ toolName }: { toolName: string }) {
  const name = toolName.toLowerCase();
  const className = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';
  if (name.includes('search') || name.includes('grep') || name === 'find') {
    return <Search aria-hidden="true" className={className} />;
  }
  if (
    name === 'read' ||
    name === 'write' ||
    name === 'edit' ||
    name === 'apply_patch' ||
    name.endsWith('_read')
  ) {
    return <FileText aria-hidden="true" className={className} />;
  }
  if (
    name === 'bash' ||
    name === 'exec' ||
    name === 'codemode' ||
    name.includes('shell') ||
    name.includes('terminal')
  ) {
    return <Terminal aria-hidden="true" className={className} />;
  }
  return <Wrench aria-hidden="true" className={className} />;
}

function SubagentToolStatus({
  status,
  label,
}: {
  status: Extract<SubagentActivity, { type: 'tool' }>['status'];
  label: string;
}) {
  const className = 'h-3.5 w-3.5';
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn('shrink-0', status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}
    >
      {status === 'running' ? (
        <LoaderCircle aria-hidden="true" className={cn(className, 'animate-spin')} />
      ) : status === 'done' ? (
        <Check aria-hidden="true" className={className} />
      ) : status === 'failed' ? (
        <CircleAlert aria-hidden="true" className={className} />
      ) : (
        <Ban aria-hidden="true" className={className} />
      )}
    </span>
  );
}

function FoldedContent({
  text,
  label,
  markdown = false,
}: {
  text: string;
  label?: string;
  markdown?: boolean;
}) {
  const { t } = useI18n();
  const long = text.length > 800 || text.split('\n').length > 16;
  const body = markdown ? (
    <Markdown text={text} />
  ) : (
    <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
      {stripAnsi(text)}
    </pre>
  );
  if (!long) {
    return (
      <div>
        {label && <div className="mb-0.5 text-[10px] text-muted-foreground">{label}</div>}
        {body}
      </div>
    );
  }
  return (
    <details className="group/details">
      <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
        {label ? `${label} · ` : ''}
        {t('{{count}} chars', { count: text.length })}
      </summary>
      <div className="mt-1.5">{body}</div>
    </details>
  );
}

function AgentMeta({ agent }: { agent: SubagentInfo }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (agent.status !== 'running') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [agent.status]);
  return (
    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
      {agent.steps > 0 ? `${agent.steps} steps · ` : ''}
      {agent.outputTokens ? `${agent.outputTokens} tok · ` : ''}
      {agent.status === 'running' ? formatDuration(Date.now() - agent.startedAt) : agent.status}
    </span>
  );
}

function TaskMeta({ task }: { task: BackgroundTaskInfo }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (task.status !== 'running') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [task.status]);
  return (
    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
      {task.status === 'running'
        ? formatDuration(Date.now() - task.startedAt)
        : task.exitCode !== undefined
          ? `exit ${task.exitCode}`
          : task.status}
    </span>
  );
}

/** 输出尾部：等宽流式,新内容自动贴底。没内容时区分：还没拿到 worker 数据 / 有输出没拿到 / 进程确实没写 */
export function TailView({
  tail,
  outputBytes,
  running,
  framed = true,
}: {
  tail: string;
  outputBytes?: number;
  running?: boolean;
  /** false：上方已有分隔标题，不再画顶边 */
  framed?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLPreElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tail 变化时贴底
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);
  return (
    <pre
      ref={ref}
      className={cn(
        'max-h-56 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground',
        framed ? 'border-t border-border/60 px-2.5 py-2' : 'px-3 pt-1 pb-2.5'
      )}
    >
      {stripAnsi(tail) ||
        (outputBytes === undefined
          ? t('Loading…')
          : outputBytes > 0
            ? t('Output written ({{size}}), not loaded yet', { size: formatBytes(outputBytes) })
            : running
              ? `${t('(no output yet)')}\n${t('The process has not written anything. Without a terminal, some programs buffer output and only write it in blocks or on exit.')}`
              : t('(no output yet)'))}
    </pre>
  );
}
