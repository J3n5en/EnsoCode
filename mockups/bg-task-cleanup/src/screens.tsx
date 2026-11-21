import {
  Activity,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock,
  Cpu,
  Filter,
  Info,
  Link2,
  Moon,
  Pin,
  Square,
  Unplug,
} from 'lucide-react';
import type * as React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DEV,
  DEV_TAIL,
  GROUPS,
  HTTP,
  IPROXY,
  IPROXY_TAIL,
  NGROK,
  POSTGRES,
  type SessionGroup,
  VITEST,
} from './data';
import {
  AssistantText,
  Button,
  ChatSurface,
  Composer,
  cn,
  Frame,
  IdleActions,
  OutputPanel,
  Page,
  ReasonLine,
  StatusBadge,
  StepNode,
  StopIcon,
  type Task,
  TaskBar,
  ToolCard,
  ToolListItem,
  UserBubble,
} from './ui';

/* ───────────── A 会话内任务条 ───────────── */

function ChatTail() {
  return (
    <AssistantText>
      <p>登录页已经拆成独立的表单组件，校验规则改用 zod，相关测试 18 个全部通过。</p>
    </AssistantText>
  );
}

function Evidence({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
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

function MetaLine({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-subtle-foreground tabular-nums">{children}</div>;
}

const A_TASKS = [IPROXY, DEV, VITEST];

function ScreenA() {
  return (
    <Page width={860}>
      <Frame
        label="A1 收起"
        note="三个任务：agent 留下理由的 iproxy、疑似闲置的 dev server、刚起的 vitest。闲置行直接给「保留」「停止」，单个停止不弹确认。"
      >
        <ChatSurface>
          <ChatTail />
          <div className="mt-3 mb-1.5">
            <TaskBar tasks={A_TASKS} />
          </div>
          <Composer />
        </ChatSurface>
      </Frame>
      <Frame
        label="A2 展开疑似闲置"
        note="点「输出」展开：上方是闲置依据（三条同时满足才标），下方最近输出。点「保留」后行内显示「你手动保留 · 时间」，之后不再提醒。"
      >
        <ChatSurface>
          <div className="mb-1.5">
            <OutputPanel
              task={DEV}
              actions={<IdleActions />}
              tail={DEV_TAIL}
              tailNote="最后一行 14:08"
            >
              <div className="grid grid-cols-3 gap-1.5">
                <Evidence icon={Clock} label="无新输出" value="42 分钟" />
                <Evidence icon={Unplug} label="端口 5173" value="无连接" />
                <Evidence icon={Cpu} label="CPU" value="0%" />
              </div>
              <MetaLine>agent 启动 · 已跑 1h 05m · 疑似闲置不会自动停止，只提醒一次</MetaLine>
            </OutputPanel>
          </div>
          <div className="mb-1.5">
            <TaskBar tasks={A_TASKS} open={1} />
          </div>
          <Composer />
        </ChatSurface>
      </Frame>
      <Frame
        label="A3 展开已保留"
        note="agent 收尾时写下的理由原样显示；已保留的任务不参与闲置提醒，可「取消保留」恢复。"
      >
        <ChatSurface>
          <div className="mb-1.5">
            <OutputPanel
              task={IPROXY}
              actions={
                <Button size="xs" variant="ghost" className="text-muted-foreground">
                  取消保留
                </Button>
              }
              tail={IPROXY_TAIL}
              tailNote="最后一行 14:31"
            >
              <div className="flex items-start gap-2 rounded-md bg-muted px-2.5 py-2">
                <Pin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-[13px]">用户的 iproxy，SSH 仍在用</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    agent 在 14:32 回合收尾时保留
                  </div>
                </div>
              </div>
              <MetaLine>agent 启动 · 已跑 2h 14m · 端口 2222 有 1 个连接</MetaLine>
            </OutputPanel>
          </div>
          <div className="mb-1.5">
            <TaskBar tasks={A_TASKS} open={0} />
          </div>
          <Composer />
        </ChatSurface>
      </Frame>
    </Page>
  );
}

/* ───────────── B agent 收尾消息 ───────────── */

function SettleCard({ open }: { open?: boolean }) {
  return (
    <ToolCard title="后台任务收尾" badge={{ tone: 'neutral', text: '停 2 · 留 1' }} open={open}>
      <ToolListItem
        title={VITEST.command}
        badge={{ tone: 'neutral', text: '已停止' }}
        detail="测试已全部通过，watch 不再需要"
      />
      <ToolListItem
        title={DEV.command}
        badge={{ tone: 'neutral', text: '已停止' }}
        detail="预览已确认，dev server 不再需要"
      />
      <ToolListItem
        title={IPROXY.command}
        badge={{ tone: 'pending', text: '保留' }}
        detail="用户的 iproxy，SSH 仍在用"
      />
    </ToolCard>
  );
}

function SystemNudge() {
  return (
    <div className="my-1 flex items-center gap-1.5 text-[12px] text-subtle-foreground">
      <Info className="size-3.5 shrink-0" />
      还有 3 个后台任务没表态，已要求 agent 逐个停止或写明保留理由
    </div>
  );
}

function ScreenB() {
  return (
    <Page width={860}>
      <Frame
        label="B1 默认（收起）"
        note="收尾表态是一条普通工具结果，和其他工具卡同一层级；标题徽标只给计数，不打断阅读。"
      >
        <ChatSurface>
          <UserBubble>登录页重构完了吗？做完把没用的进程清一下。</UserBubble>
          <ToolCard title="编辑 Login.tsx 等 3 个文件" />
          <ToolCard title="运行 pnpm vitest run src/auth" badge={{ tone: 'ok', text: '通过' }} />
          <SettleCard />
          <AssistantText>
            <p>
              重构完成，18 个测试全部通过。vitest watch 和 dev server 已停掉；iproxy 留着，你的 SSH
              还在用它。
            </p>
          </AssistantText>
          <div className="mt-3 mb-1.5">
            <TaskBar tasks={[IPROXY]} />
          </div>
          <Composer />
        </ChatSurface>
      </Frame>
      <Frame
        label="B2 展开 + 漏表态时的提醒"
        note="展开后逐条列出停了什么、留了什么及理由。若 agent 想直接结束回合，系统先追加一行灰色提醒（可选，见待定问题），agent 再补表态。"
      >
        <ChatSurface>
          <ToolCard title="运行 pnpm vitest run src/auth" badge={{ tone: 'ok', text: '通过' }} />
          <SystemNudge />
          <SettleCard open />
          <AssistantText>
            <p>
              重构完成，18 个测试全部通过。vitest watch 和 dev server 已停掉；iproxy 留着，你的 SSH
              还在用它。
            </p>
          </AssistantText>
        </ChatSurface>
      </Frame>
    </Page>
  );
}

/* ───────────── C 侧栏 ───────────── */

function TaskMarker({ running = 0, idle = 0 }: { running?: number; idle?: number }) {
  if (!running && !idle) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground/70">
      {running > 0 && (
        <span className="inline-flex items-center gap-0.5" title={`${running} 个后台任务在跑`}>
          <Activity className="h-3 w-3" />
          {running}
        </span>
      )}
      {idle > 0 && (
        <span
          className="inline-flex items-center gap-0.5 text-warning"
          title={`${idle} 个疑似闲置`}
        >
          <Moon className="h-3 w-3" />
          {idle}
        </span>
      )}
    </span>
  );
}

function Dot({ tone }: { tone?: 'running' | 'unread' }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {tone && (
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            tone === 'running' ? 'bg-brand' : 'bg-green-500'
          )}
        />
      )}
    </span>
  );
}

function ConvRow({
  title,
  time,
  tone,
  active,
  hover,
  running,
  idle,
}: {
  title: string;
  time: string;
  tone?: 'running' | 'unread';
  active?: boolean;
  hover?: boolean;
  running?: number;
  idle?: number;
}) {
  return (
    <div
      className={cn(
        'group flex h-8 items-center gap-2 rounded-lg px-2 text-[0.9286rem]',
        active
          ? 'bg-foreground/[0.075] [.dark_&]:bg-foreground/10'
          : 'text-foreground/88 hover:bg-foreground/5',
        hover && 'bg-foreground/5'
      )}
    >
      <Dot tone={tone} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <TaskMarker running={running} idle={idle} />
      <span className="shrink-0 text-[0.7857rem] text-subtle-foreground tabular-nums">{time}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-3.5 pr-1 pb-1 pl-2 text-[0.8214rem] font-medium text-subtle-foreground">
      {children}
    </div>
  );
}

function ProjectRow({ name, folded }: { name: string; folded?: boolean }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg px-2 text-[0.9286rem] font-medium">
      <span className="flex size-4 shrink-0 items-center justify-center text-subtle-foreground">
        <ChevronRight className={cn('size-3.5', !folded && 'rotate-90')} />
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </div>
  );
}

function SecretaryRow() {
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] px-2 py-1.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-[#8b5cf6] text-[13px] font-semibold text-white">
        秘
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium">秘书</span>
        <span className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
          2 件进行中 · 1 件等你
        </span>
      </span>
    </div>
  );
}

/** 建议的「后台任务」入口：秘书下方、活跃中上方；没有在跑的任务时整行隐藏 */
function TasksEntry({ active }: { active?: boolean }) {
  return (
    <div
      className={cn(
        'flex h-8 items-center gap-2 rounded-lg px-2 text-[0.9286rem]',
        active ? 'bg-foreground/[0.075] [.dark_&]:bg-foreground/10' : 'text-foreground/88'
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <Activity className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">后台任务</span>
      <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground/70">
        <span className="inline-flex items-center gap-0.5 text-warning">
          <Moon className="h-3 w-3" />3
        </span>
      </span>
      <span className="shrink-0 text-[0.7857rem] text-subtle-foreground tabular-nums">7</span>
    </div>
  );
}

function SidebarBody({ entryActive, hoverCi }: { entryActive?: boolean; hoverCi?: boolean }) {
  return (
    <div className="flex flex-col px-1.5 pt-2 pb-2">
      <SecretaryRow />
      <TasksEntry active={entryActive} />
      <div className="mx-2 mt-1 border-t border-border" />
      <SectionLabel>活跃中</SectionLabel>
      <ConvRow
        title="重构登录页"
        time="刚刚"
        tone="running"
        active={!entryActive}
        running={2}
        idle={1}
      />
      <ConvRow title="接入支付回调" time="12 分钟" tone="unread" running={1} idle={1} />
      <ConvRow title="升级依赖版本" time="40 分钟" running={1} />
      <ConvRow title="整理周报" time="1 小时" />
      <SectionLabel>项目</SectionLabel>
      <ProjectRow name="infra" />
      <ConvRow title="修复 CI 缓存" time="3 小时" idle={1} hover={hoverCi} />
      <ConvRow title="调整告警阈值" time="昨天" />
      <ProjectRow name="web-console" folded />
      <ProjectRow name="api-server" folded />
    </div>
  );
}

function MiniTaskRow({ task }: { task: Task }) {
  return (
    <div className="flex min-h-[30px] min-w-0 items-center gap-2 rounded-lg px-1.5 text-[13px]">
      <StepNode status={task.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-muted-foreground">{task.command}</div>
        <div className="mt-0.5 text-[11px] text-warning">疑似闲置 {task.idle}</div>
      </div>
      <IdleActions />
    </div>
  );
}

function ScreenC() {
  return (
    <Page width={860}>
      <Frame
        label="C 侧栏会话行"
        note={
          <>
            标题右侧的计数沿用浏览器/终端计数的样式：
            <Activity className="inline size-3" /> N = N 个任务在跑（灰），
            <Moon className="inline size-3 text-warning" /> N = N
            个疑似闲置（琥珀色）。悬停标记弹出任务卡，没打开的会话也能直接停。
          </>
        }
      >
        <div className="relative flex h-[560px] overflow-hidden rounded-xl bg-canvas ring-1 ring-border">
          <div className="w-[280px] shrink-0">
            <SidebarBody hoverCi />
          </div>
          <div className="my-2 mr-2 flex-1 rounded-xl bg-background shadow-surface" />
          <div className="absolute top-[318px] left-[268px] w-[340px] rounded-xl border bg-popover p-1 shadow-float">
            <div className="flex items-center gap-1.5 px-1.5 pt-1 pb-1.5 text-[11px] text-muted-foreground">
              <span className="min-w-0 truncate">修复 CI 缓存 的后台任务</span>
              <span className="rounded bg-muted px-1 text-[10px]">会话未打开</span>
            </div>
            <MiniTaskRow task={HTTP} />
            <div className="mt-1 flex items-center gap-3 border-t border-border/60 px-1.5 pt-1.5 pb-0.5 text-[11px] text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">端口 8000 无连接 · CPU 0%</span>
              <span className="inline-flex items-center gap-0.5 text-foreground/80">
                全部任务
                <ArrowUpRight className="size-3" />
              </span>
            </div>
          </div>
        </div>
      </Frame>
    </Page>
  );
}

/* ───────────── D 所有在跑任务 ───────────── */

function Segmented({ idleOnly }: { idleOnly?: boolean }) {
  const item = 'flex h-6 items-center gap-1 rounded-md px-2.5 text-xs';
  const on = 'bg-background text-foreground shadow-xs [.dark_&]:bg-foreground/10';
  return (
    <div className="inline-flex rounded-lg bg-muted p-0.5 text-muted-foreground">
      <span className={cn(item, !idleOnly && on)}>
        全部 <span className="tabular-nums opacity-70">7</span>
      </span>
      <span className={cn(item, idleOnly && on)}>
        <Moon className="size-3 text-warning" />
        只看疑似闲置 <span className="tabular-nums opacity-70">3</span>
      </span>
    </div>
  );
}

function ListRow({ task, checked }: { task: Task; checked?: boolean }) {
  return (
    <div
      className={cn(
        'grid grid-cols-[16px_22px_minmax(0,1fr)_136px_64px_112px] items-center gap-x-3 px-3 py-1.5',
        checked && 'bg-brand/[0.06]'
      )}
    >
      <Checkbox checked={!!checked} />
      <StepNode status={task.status} />
      <div className="min-w-0">
        <div className="truncate font-mono text-xs text-muted-foreground">{task.command}</div>
        <ReasonLine task={task} className="mt-0.5" />
      </div>
      <div>
        <StatusBadge task={task} />
      </div>
      <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums">
        {task.duration}
      </span>
      <div className="flex items-center justify-end gap-0.5">
        {task.status === 'idle' && (
          <Button size="xs" variant="ghost" className="text-muted-foreground">
            保留
          </Button>
        )}
        <StopIcon />
      </div>
    </div>
  );
}

function GroupCard({
  group,
  selected,
  idleOnly,
}: {
  group: SessionGroup;
  selected: Set<string>;
  idleOnly?: boolean;
}) {
  const tasks = idleOnly ? group.tasks.filter((t) => t.status === 'idle') : group.tasks;
  if (!tasks.length) return null;
  const all = tasks.every((t) => selected.has(t.command));
  const some = tasks.some((t) => selected.has(t.command));
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div className="flex items-center gap-3 border-b border-border/60 px-3 py-2">
        <Checkbox checked={all} indeterminate={some && !all} />
        <span className="text-[13px] font-medium">{group.title}</span>
        <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">
          {group.project}
        </span>
        {group.note && <span className="text-[11px] text-subtle-foreground">{group.note}</span>}
        <span className="flex-1" />
        <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
          打开会话
          <ArrowUpRight className="size-3.5" />
        </span>
      </div>
      <div className="divide-y divide-border/50">
        {tasks.map((t) => (
          <ListRow key={t.command} task={t} checked={selected.has(t.command)} />
        ))}
      </div>
    </div>
  );
}

function Toolbar({
  idleOnly,
  count,
  names,
}: {
  idleOnly?: boolean;
  count: number;
  names?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Segmented idleOnly={idleOnly} />
      <span className="flex-1" />
      {count > 0 && (
        <>
          <span className="text-xs text-muted-foreground tabular-nums">已选 {count} 个</span>
          <Button size="xs" variant="ghost" className="text-muted-foreground">
            取消选择
          </Button>
          <Button
            size="xs"
            variant="destructive"
            className={cn(names && 'ring-2 ring-destructive/25')}
          >
            <Square className="size-3" />
            停止所选
          </Button>
        </>
      )}
    </div>
  );
}

function TasksPage({
  idleOnly,
  selected,
  confirm,
}: {
  idleOnly?: boolean;
  selected: string[];
  confirm?: boolean;
}) {
  const sel = new Set(selected);
  return (
    <div className="relative px-8 pt-6 pb-8">
      <div className="flex items-baseline gap-3">
        <h1 className="text-[18px] font-semibold">后台任务</h1>
        <span className="text-[12.5px] text-muted-foreground">
          7 个在跑 · <span className="text-warning">3 个疑似闲置</span> · 来自 4 个会话
        </span>
      </div>
      <div className="mt-4">
        <Toolbar idleOnly={idleOnly} count={sel.size} names={confirm} />
      </div>
      <div className="mt-3 grid grid-cols-[16px_22px_minmax(0,1fr)_136px_64px_112px] gap-x-3 px-[13px] pb-1.5 text-[11px] text-subtle-foreground">
        <span />
        <span />
        <span>命令</span>
        <span>状态</span>
        <span>已运行</span>
        <span />
      </div>
      <div className="flex flex-col gap-2.5">
        {GROUPS.map((g) => (
          <GroupCard key={g.title} group={g} selected={sel} idleOnly={idleOnly} />
        ))}
      </div>
      {idleOnly && (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-subtle-foreground">
          <Filter className="size-3" />
          判定：30 分钟无新输出、监听端口无活跃连接、CPU 近 0，三条同时满足。已保留的任务不计入。
        </div>
      )}
      {confirm && <ConfirmPopover />}
    </div>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex overflow-hidden rounded-xl bg-canvas ring-1 ring-border">
      <div className="w-[260px] shrink-0">
        <SidebarBody entryActive />
      </div>
      <div className="my-2 mr-2 min-w-0 flex-1 rounded-xl bg-background shadow-surface">
        {children}
      </div>
    </div>
  );
}

function ScreenD() {
  return (
    <Page width={1220}>
      <Frame
        label="D1 所有在跑任务"
        note="入口建议放侧栏秘书下方的「后台任务」行（琥珀色数字 = 疑似闲置数），点开占主区。按会话分组，可整组勾选；未打开的会话同样能停。"
      >
        <AppShell>
          <TasksPage selected={[DEV.command, NGROK.command, HTTP.command]} />
        </AppShell>
      </Frame>
      <Frame
        label="D2 只看疑似闲置"
        note="筛选后只剩 3 个疑似闲置任务；组头复选框一键全选，再「停止所选」。"
      >
        <AppShell>
          <TasksPage idleOnly selected={[]} />
        </AppShell>
      </Frame>
    </Page>
  );
}

/* ───────────── E 批量停止确认 ───────────── */

function ConfirmPopover() {
  const items: [Task, string][] = [
    [DEV, '重构登录页'],
    [NGROK, '接入支付回调'],
    [HTTP, '修复 CI 缓存（未打开）'],
  ];
  return (
    <div className="absolute top-[94px] right-8 z-10 w-[340px] rounded-xl border bg-popover p-3 shadow-float">
      <div className="text-[13px] font-medium">停止 3 个后台任务？</div>
      <ul className="mt-2 space-y-1">
        {items.map(([t, s]) => (
          <li key={t.command} className="flex min-w-0 items-baseline gap-2 text-xs">
            <span className="min-w-0 truncate font-mono text-foreground/85">{t.command}</span>
            <span className="ml-auto shrink-0 text-[11px] text-subtle-foreground">{s}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-end gap-1.5">
        <Button size="xs" variant="ghost">
          取消
        </Button>
        <Button size="xs" variant="destructive">
          停止 3 个
        </Button>
      </div>
    </div>
  );
}

function ScreenE() {
  return (
    <Page width={1220}>
      <Frame
        label="E 批量停止确认"
        note="点「停止所选」后在按钮下方弹出轻量确认（非模态，Esc / 点外面取消），列出任务名和所属会话。单个停止按钮不经过这一步。"
      >
        <AppShell>
          <TasksPage selected={[DEV.command, NGROK.command, HTTP.command]} confirm />
        </AppShell>
      </Frame>
    </Page>
  );
}

/* ───────────── G 秘书看板「已完成（有遗留任务）」 ───────────── */

const CHIP =
  'inline-flex h-[18px] items-center gap-1 rounded-full bg-foreground/[0.06] px-1.5 font-medium';

function LeftoverRow({ task }: { task: Task }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 py-0.5">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-foreground/80">{task.command}</div>
        {task.status === 'idle' ? (
          <div className="text-[10.5px] text-warning">疑似闲置 {task.idle}</div>
        ) : (
          <ReasonLine task={task} className="text-[10.5px]" />
        )}
      </div>
      {task.status === 'idle' && (
        <span className="shrink-0 rounded-[5px] px-1 text-[11px] text-muted-foreground hover:bg-foreground/5">
          保留
        </span>
      )}
      <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
        <Square className="h-3 w-3" />
      </span>
    </div>
  );
}

function BoardCard({
  title,
  body,
  time,
  leftovers,
  hover,
}: {
  title: string;
  body: string;
  time: string;
  leftovers?: Task[];
  hover?: boolean;
}) {
  const idle = leftovers?.filter((t) => t.status === 'idle').length ?? 0;
  return (
    <div
      className={cn(
        'relative rounded-md border border-border bg-card px-2.5 py-2 shadow-[0_1px_2px_0_rgb(0_0_0/0.05)]',
        hover && 'ring-1 ring-foreground/10'
      )}
    >
      <div className="pr-6 text-[12.5px] font-medium leading-[1.45]">{title}</div>
      <div className="mt-[3px] line-clamp-3 text-[12px] text-muted-foreground">{body}</div>
      {leftovers && (
        <div className="mt-[7px] rounded-[5px] bg-foreground/[0.04] px-1.5 py-1">
          {leftovers.map((t) => (
            <LeftoverRow key={t.command} task={t} />
          ))}
        </div>
      )}
      <div className="mt-[7px] flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={CHIP}>
          <Link2 className="size-3" />
          会话
        </span>
        {leftovers && (
          <span className={cn(CHIP, idle > 0 && 'text-warning')}>
            {idle > 0
              ? `已完成（${leftovers.length} 个遗留任务）`
              : `已完成（保留 ${leftovers.length} 个任务）`}
          </span>
        )}
        <span className="tabular-nums">{time}</span>
      </div>
      {hover && (
        <span
          title="停止疑似闲置的遗留任务"
          className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-[5px] bg-destructive/10 text-destructive"
        >
          <Square className="h-3.5 w-3.5" />
        </span>
      )}
    </div>
  );
}

function ScreenG() {
  return (
    <Page width={640}>
      <Frame
        label="G 秘书看板卡片"
        note="「已完成（N 个遗留任务）」卡片里直接列出遗留任务及理由/闲置时长，可逐个保留或停止；悬停卡片右上角的停止只停疑似闲置的，不动已保留的。"
      >
        <div className="flex gap-3">
          <div className="w-[260px] flex-none rounded-lg bg-[color-mix(in_oklch,var(--muted)_55%,transparent)] p-1 pb-1.5 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--border)_60%,transparent)]">
            <div className="flex min-h-[30px] items-center gap-1 px-1 pt-0.5 pb-1.5">
              <ChevronDown className="size-3.5 text-muted-foreground" />
              <span
                className="ml-0.5 size-[7px] rounded-full"
                style={{
                  background: '#10b981',
                  boxShadow: '0 0 0 3px color-mix(in oklch, #10b981 18%, transparent)',
                }}
              />
              <span className="ml-1.5 text-[12.5px] font-semibold">完成了什么</span>
              <span className="ml-1 rounded-full bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                3
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <BoardCard
                title="重构登录页"
                body="登录页拆成独立表单组件，校验改用 zod，18 个测试全部通过。"
                time="派出 10:12 · 完成 11:40"
                leftovers={[IPROXY]}
              />
              <BoardCard
                title="接入支付回调"
                body="回调验签和幂等处理已完成，本地用 ngrok 联调通过。"
                time="派出 09:30 · 完成 11:05"
                leftovers={[POSTGRES, NGROK]}
                hover
              />
              <BoardCard
                title="整理周报"
                body="汇总本周 12 个 PR 与 3 个线上问题，已发到草稿。"
                time="派出 08:50 · 完成 09:10"
              />
            </div>
          </div>
          <div className="flex flex-col gap-2 pt-9 text-[12px] leading-relaxed text-muted-foreground">
            <div className="flex items-start gap-1.5">
              <Pin className="mt-1 size-3 shrink-0" />
              有理由的保留只显示理由，不再算待处理。
            </div>
            <div className="flex items-start gap-1.5">
              <Moon className="mt-1 size-3 shrink-0 text-warning" />
              疑似闲置的用琥珀色，和侧栏标记一致。
            </div>
            <div className="flex items-start gap-1.5">
              <CircleCheck className="mt-1 size-3 shrink-0" />
              只剩有理由的保留时，徽标退回灰色；全部停掉后变回普通「已完成」。
            </div>
          </div>
        </div>
      </Frame>
    </Page>
  );
}

export const screens = [
  { id: 'A', title: '会话内任务条', element: <ScreenA /> },
  { id: 'B', title: 'agent 收尾消息', element: <ScreenB /> },
  { id: 'C', title: '侧栏会话行标记', element: <ScreenC /> },
  { id: 'D', title: '所有在跑任务列表', element: <ScreenD /> },
  { id: 'E', title: '批量停止确认', element: <ScreenE /> },
  { id: 'G', title: '秘书看板遗留任务卡片', element: <ScreenG /> },
];
