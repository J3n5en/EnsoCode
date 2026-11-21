// mockup 用的展示组件：类名照抄 TaskBar / ToolCallCard / Sidebar / SecretaryDailyBoard，不接 store
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Moon,
  Pin,
  Plus,
  Square,
  TerminalSquare,
  X,
} from 'lucide-react';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export { Button, cn };

export type TaskStatus = 'running' | 'idle' | 'kept';
export interface Task {
  command: string;
  duration: string;
  status: TaskStatus;
  idle?: string;
  reason?: string;
  keptBy?: 'agent' | 'user';
}

export function Page({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <div id="page" className="flex flex-col gap-7 bg-canvas p-8 text-foreground" style={{ width }}>
      {children}
    </div>
  );
}

/** mockup 标注：画面编号 + 一句交互说明，不属于产品 UI */
export function Frame({
  label,
  note,
  children,
}: {
  label: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 rounded bg-brand/12 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-brand">
          {label}
        </span>
        {note && <span className="text-[12px] leading-relaxed text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

const TONE = {
  ok: 'bg-success/15 text-success',
  pending: 'bg-warning/15 text-warning',
  error: 'bg-destructive/15 text-destructive',
  neutral: 'bg-muted text-muted-foreground',
} as const;
export type Tone = keyof typeof TONE;

export function Badge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('shrink-0 rounded px-1 py-px text-[10px]', TONE[tone], className)}>
      {children}
    </span>
  );
}

export function StatusBadge({ task }: { task: Task }) {
  if (task.status === 'idle') return <Badge tone="pending">疑似闲置 {task.idle}</Badge>;
  if (task.status === 'kept') return <Badge tone="neutral">已保留</Badge>;
  return <Badge tone="ok">运行中</Badge>;
}

export function StepNode({ status }: { status: TaskStatus }) {
  const idle = status === 'idle';
  return (
    <span
      className={cn(
        'relative flex size-[22px] shrink-0 items-center justify-center rounded-full border text-muted-foreground',
        idle ? 'border-dashed border-warning/60 text-warning' : 'border-transparent text-brand'
      )}
    >
      {!idle && (
        <span className="absolute -inset-px animate-spin rounded-full border-[1.5px] border-brand/20 border-t-brand" />
      )}
      {idle ? <Moon className="size-3" /> : <TerminalSquare className="size-3" />}
    </span>
  );
}

export function ReasonLine({ task, className }: { task: Task; className?: string }) {
  if (!task.reason) return null;
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/85',
        className
      )}
    >
      <Pin className="size-3 shrink-0" />
      <span className="truncate">
        {task.keptBy === 'user' ? `你手动保留 · ${task.reason}` : `保留：${task.reason}`}
      </span>
    </div>
  );
}

export function StopIcon({ hover }: { hover?: boolean }) {
  return (
    <button
      type="button"
      title="停止任务"
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
        hover && 'bg-destructive/10 text-destructive'
      )}
    >
      <Square className="h-3 w-3" />
    </button>
  );
}

export function IdleActions() {
  return (
    <>
      <Button size="xs" variant="ghost" className="text-muted-foreground">
        保留
      </Button>
      <Button size="xs" variant="outline" className="hover:text-destructive">
        <Square className="size-3" />
        停止
      </Button>
    </>
  );
}

/** 会话内任务条的一行（TaskBar DockRow） */
export function TaskRow({ task, open }: { task: Task; open?: boolean }) {
  const idle = task.status === 'idle';
  return (
    <div
      className={cn(
        'flex min-h-[30px] min-w-0 items-center gap-2 rounded-lg px-1 text-[13px]',
        task.reason && 'py-1',
        idle && 'bg-warning/[0.06]',
        open && 'bg-muted'
      )}
    >
      <StepNode status={task.status} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {task.command}
          </span>
          {idle && <Badge tone="pending">疑似闲置 {task.idle}</Badge>}
        </div>
        <ReasonLine task={task} className="mt-0.5" />
      </div>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
        {task.duration}
      </span>
      <button
        type="button"
        className={cn(
          'flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted',
          open && 'bg-foreground/[0.06] text-foreground'
        )}
      >
        输出
        <ChevronDown className={cn('h-3 w-3', open && 'rotate-180')} />
      </button>
      {idle ? <IdleActions /> : <StopIcon />}
    </div>
  );
}

export function TaskBar({ tasks, open }: { tasks: Task[]; open?: number }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border bg-card p-1 shadow-xs">
      {tasks.map((task, i) => (
        <TaskRow key={task.command} task={task} open={open === i} />
      ))}
    </div>
  );
}

/** TaskBar 展开的输出面板；产品里浮在任务条上方 */
export function OutputPanel({
  task,
  actions,
  children,
  tail,
  tailNote,
}: {
  task: Task;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  tail: string;
  tailNote?: string;
}) {
  return (
    <div className="rounded-xl border bg-card shadow-float">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate font-mono text-muted-foreground">{task.command}</span>
        <StatusBadge task={task} />
        <span className="flex-1" />
        {actions}
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {children && <div className="space-y-2.5 px-3 py-2.5 text-xs">{children}</div>}
      <div className="flex items-center gap-2 border-t border-border/60 px-3 pt-2 text-[11px] text-subtle-foreground">
        <span>最近输出</span>
        {tailNote && <span className="tabular-nums">{tailNote}</span>}
      </div>
      <pre className="max-h-56 overflow-auto px-3 pt-1 pb-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {tail}
      </pre>
    </div>
  );
}

export function Composer() {
  return (
    <div className="rounded-[24px] border bg-card px-4 pt-3 pb-2.5 shadow-[0_2px_6px_rgb(0_0_0/0.03),0_12px_32px_rgb(0_0_0/0.07)]">
      <div className="min-h-10 text-sm text-subtle-foreground">输入消息…</div>
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted">
          <Plus className="size-4" />
        </span>
        <span className="text-xs text-muted-foreground">Claude · 高</span>
        <span className="flex-1" />
        <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <ArrowUp className="size-4" />
        </span>
      </div>
    </div>
  );
}

/** 对话区底色 + 居中时间线列 */
export function ChatSurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-background shadow-surface">
      <div className="mx-auto flex max-w-[720px] flex-col px-6 pt-5 pb-4">{children}</div>
    </div>
  );
}

export function AssistantText({ children }: { children: React.ReactNode }) {
  return <div className="my-1.5 space-y-2 text-sm leading-relaxed">{children}</div>;
}

export function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-2 flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm">
        {children}
      </div>
    </div>
  );
}

/** ToolCallCard 的标题行 + 展开体 */
export function ToolCard({
  title,
  badge,
  open,
  children,
}: {
  title: React.ReactNode;
  badge?: { tone: Tone; text: string };
  open?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="my-0.5 w-full min-w-0 text-[13px]">
      <div className="flex min-h-6 items-center gap-2 text-[13px] text-muted-foreground">
        <span className="flex size-3 shrink-0 items-center justify-center">
          <span className="size-1 rounded-full bg-current opacity-60" />
        </span>
        <span className="min-w-0 truncate">{title}</span>
        {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
        <ChevronRight className={cn('h-3 w-3 shrink-0', open && 'rotate-90')} />
      </div>
      {open && <div className="space-y-1 py-0.5 pl-5 text-[12px]">{children}</div>}
    </div>
  );
}

export function ToolListItem({
  title,
  badge,
  detail,
}: {
  title: string;
  badge: { tone: Tone; text: string };
  detail: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
      <span className="shrink-0 font-mono text-foreground/85">{title}</span>
      <Badge tone={badge.tone}>{badge.text}</Badge>
      <span className="min-w-0 truncate text-muted-foreground">{detail}</span>
    </div>
  );
}
