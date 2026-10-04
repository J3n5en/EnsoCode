import { firstProgram, isReadOnlyCommand } from '@shared/readOnlyCommand';
import type { RtkToolStats } from '@shared/rtk';
import { nestedToolCallParent } from '@shared/toolCallId';
import type {
  AgentSessionCustomEntry,
  ApprovalRequestInfo,
  ProjectedCodemodeCall,
  ProjectedMessage,
  TodoItem,
  TurnPerf,
} from '@shared/types/agent';
import type { ProjectedApplyPatchOutcome, ProjectedFileChange } from '@shared/types/fileChanges';
import { unwrapMcpProxyCall } from '@/lib/mcpToolName';
import type { TimelineMessage } from './reducer';

/** edit 工具的单个替换块（pi edit 工具参数 edits[] 的元素） */
export interface EditBlock {
  oldText: string;
  newText: string;
}

export type TimelineItem =
  | {
      kind: 'user';
      key: string;
      text: string;
      images: { data: string; mimeType: string }[];
      timestamp?: number;
      turnDurationMs?: number;
      deliveryState?: 'pending' | 'rejected';
      collapsed?: boolean;
      canCollapse?: boolean;
      /** 本轮首个 assistant 回复的模型与时间，供回复身份头显示 */
      replyModel?: string;
      replyAt?: number;
    }
  | {
      kind: 'text';
      key: string;
      text: string;
      streaming: boolean;
      timestamp?: number;
      perf?: TurnPerf;
      /** 本轮已结束的最后一条正文：可从这里开平行会话 */
      turnEnd?: boolean;
      /** 本轮完结时的整轮活跃用时（毫秒） */
      turnDurationMs?: number;
    }
  | {
      kind: 'thinking';
      key: string;
      text: string;
      streaming: boolean;
      /** 思考耗时（结束后显示）；无打点为 null */
      durationMs: number | null;
      /** 思考起点（流式计时用）；无打点则缺省 */
      startedAt?: number;
    }
  | {
      kind: 'tool';
      key: string;
      name: string;
      summary: string;
      output: string | null;
      state: 'running' | 'reviewing' | 'ok' | 'error';
      /** edit 工具的替换块，用于渲染 diff；非 edit 为 null */
      edits: EditBlock[] | null;
      /** write 工具写入的文件内容,展开即可查看;非 write 为 null */
      writeContent: string | null;
      /** apply_patch 实际落盘的多文件操作；失败结果也可能非空 */
      fileChanges?: ProjectedFileChange[] | null;
      /** todo 工具的清单快照；非 todo 为 null */
      todos: TodoItem[] | null;
      /** 工具执行耗时（完成后显示）；未知为 null */
      durationMs: number | null;
      /** 真正开始执行的 wall clock；null = 已跟踪但未开跑；缺省 = 这条链路不打点 */
      startedAt?: number | null;
      /** subagent 工具的执行元数据（模型/token/步数）；非 subagent 为 null */
      agentMeta: { modelId?: string; outputTokens?: number; steps?: number } | null;
      /** exec / 隔离沙箱的 JS 源码；其它工具缺省 */
      source?: string | null;
      /** 嵌套审批未决数（codemode 脚本内 write 等） */
      nestedPending?: number;
      /** exec / codemode 沙箱卡片：结果、嵌套调用摘要；其它工具缺省 */
      sandbox?: SandboxView | null;
      /** RTK 对本次工具调用的真实处理结果；无元数据时缺省 */
      rtk?: RtkToolStats;
      /** 运行中的 bash/powershell 调用 id（转后台用）；其它缺省 */
      callId?: string;
      /** 前台命令被移交为后台任务时的任务 id；其它缺省 */
      backgroundTaskId?: string;
      /** submit_plan 提交的计划；其它工具缺省 */
      plan?: { title: string; text: string } | null;
      /** 联系主 agent / 队员、子代理 send 发出的正文，或子代理 spawn 交代的任务；其它工具缺省 */
      sentMessage?: string;
      /** memory_capture 记下的正文（写入回执不带正文）；其它工具缺省 */
      memoryContent?: string;
      /** ask_user 当时的问题、选项与用户的回答；其它工具缺省 */
      ask?: AskUserView;
      /** 子代理按 runId / agentId 指代目标的操作（summary 为 spawn 时起的标题）；其它缺省 */
      subagentOp?: SubagentOp;
      /** wait / list 行：agentId → spawn 时起的名字，展开后逐个标注；其它缺省 */
      subagentTitles?: Record<string, string>;
    }
  | {
      kind: 'tool-group';
      key: string;
      expanded: boolean;
      /** 组内工具数（不含 edit——它平铺在组外） */
      count: number;
      stats: ToolGroupStats;
      /** compact 模式下组外仍有 running 的只读行：组头显示 Exploring */
      exploring: boolean;
      /** 回答完成后的过程折叠组（任意成功工具 + 思考）；普通工具组缺省 */
      activity?: { thinking: number; workedMs: number };
      /** 成对的 explore_mark → explore_fold 探索组：组头展开只给目标与结果，steps 时才平铺过程；其它组缺省 */
      explore?: { goal: string; report: string; steps: boolean };
      /** 组内原始行（tool + 夹在其间的 thinking），展开时平铺为顶层行 */
      children: TimelineItem[];
    }
  | { kind: 'error'; key: string; text: string }
  /** pi 的 compaction 摘要：之前的历史已被压缩出 LLM 上下文，渲染为分隔行 */
  | {
      kind: 'compaction';
      key: string;
      summary: string;
      tokensBefore: number | null;
      verified?: boolean;
      memory?: boolean;
    }
  /** 压缩进行中 / 排队：钉在时间线底部，不依赖占用面板 */
  | { kind: 'compaction-progress'; key: string; state: 'queued' | 'running' }
  /** 摘要不在末尾时，底部再钉一条可展开提示 */
  | {
      kind: 'compaction-notice';
      key: string;
      summary: string;
      tokensBefore: number | null;
      verified?: boolean;
      memory?: boolean;
    }
  /** 后台任务完成的合成注入消息（<background-task-update>），渲染为系统通知行 */
  | { kind: 'task-note'; key: string; summary: string; detail: string }
  /** 不进入 LLM context 的 parent/child SessionManager custom entry。 */
  | { kind: 'session-custom'; key: string; entry: AgentSessionCustomEntry };

export function formatApplyPatchOutcome(outcome: ProjectedApplyPatchOutcome): string {
  const list = (label: string, paths: string[]): string =>
    `${label}:\n${paths.length > 0 ? paths.map((path) => `- ${path}`).join('\n') : '(none)'}`;
  return [
    `Patch ${outcome.status}.`,
    list('Applied', outcome.applied),
    list('Failed paths', outcome.failed),
    ...(outcome.error ? [`Error: ${outcome.error}`] : []),
    list('Unattempted', outcome.unattempted),
    list('Uncertain', outcome.uncertain),
    ...(outcome.status === 'success' ? [] : ['Re-read failed or uncertain paths before retrying.']),
    ...(outcome.input ? [`Input:\n${outcome.input}`] : []),
  ].join('\n');
}

export function shouldAutoExpandAppliedFileChanges(
  item: TimelineItem,
  previouslyHadFileChanges: boolean
): boolean {
  return (
    !previouslyHadFileChanges &&
    item.kind === 'tool' &&
    item.name === 'apply_patch' &&
    Boolean(item.fileChanges?.length)
  );
}

/** 推理行是否展开：手动点击优先；否则仅在开启自动展开且仍在流式时展开 */
export function thinkingRowExpanded(
  userToggled: boolean | null,
  streaming: boolean,
  expandLiveReasoning: boolean
): boolean {
  if (userToggled !== null) return userToggled;
  return expandLiveReasoning && streaming;
}

export function shouldShowToolOutputAfterFileChanges(item: TimelineItem): boolean {
  return (
    item.kind === 'tool' &&
    item.name === 'apply_patch' &&
    Boolean(item.fileChanges?.length) &&
    Boolean(item.output)
  );
}

export interface ToolGroupStats {
  commands: number;
  reads: number;
  searches: number;
  others: number;
}

/** 从工具参数里挑一个最能说明「对什么操作」的字段做摘要 */
const SUMMARY_KEYS = [
  'path',
  'file_path',
  'command',
  'pattern',
  'query',
  'url',
  'description',
  'summary',
  'reason',
  'goal',
];

const PATH_SUMMARY_KEYS = new Set(['path', 'file_path']);
const HASHLINE_HEADER = /^\[(.+)#([0-9A-Fa-f]{4})\]$/;
const PATCH_FILE_HEADER = /^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/;

/** Windows 盘符根路径还原成 POSIX，便于远程 SSH 工具路径和项目 cwd 对齐 */
function posixifyPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const drive = /^[A-Za-z]:(\/.*)?$/.exec(normalized);
  if (drive) return drive[1] && drive[1].length > 0 ? drive[1] : '/';
  return normalized;
}

/** 项目内绝对路径收成相对路径；前缀碰巧相同的目录不误切 */
export function toProjectRelativePath(value: string, cwd?: string): string {
  if (!cwd) return value;
  const root = posixifyPath(cwd).replace(/\/+$/, '');
  const posixValue = posixifyPath(value);
  if (!root) return posixValue;
  if (posixValue === root) return '.';
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (posixValue.startsWith(prefix)) return posixValue.slice(prefix.length);
  return posixValue === value ? value : posixValue;
}

function hashlinePathFromInput(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return HASHLINE_HEADER.exec(trimmed)?.[1];
  }
  return undefined;
}

/** apply_patch 尚无落盘结果时从补丁头取目标文件（move 计入新路径，与落盘结果口径一致） */
function patchPathsFromArgs(args: unknown): string[] | null {
  if (!args || typeof args !== 'object') return null;
  const input = (args as Record<string, unknown>).input;
  if (typeof input !== 'string') return null;
  const paths = new Set<string>();
  for (const line of input.split('\n')) {
    const path = PATCH_FILE_HEADER.exec(line.trim())?.[1];
    if (path) paths.add(path);
  }
  return [...paths];
}

function summarizeArgs(args: unknown, cwd?: string): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value) {
      return PATH_SUMMARY_KEYS.has(key) ? toProjectRelativePath(value, cwd) : value;
    }
  }
  const hashlinePath = hashlinePathFromInput(record.input);
  if (hashlinePath) return toProjectRelativePath(hashlinePath, cwd);
  const json = JSON.stringify(record);
  return json === '{}' ? '' : json.slice(0, 80);
}

/** 时间线顶部：翻页在途 / 已到第 0 条 / 不占文案 */
export type HistoryPageChrome = 'none' | 'loading' | 'start' | 'more';

/** 到头提示只给「曾经有更早、现已翻完」的会话；刚开场 / 一页就完的短会话不显示 */
export function historyPageChrome(
  hasItems: boolean,
  loading: boolean,
  hasOlder: boolean | undefined,
  everHadOlder = false,
  offerLoadMore = false
): HistoryPageChrome {
  if (!hasItems) return 'none';
  if (loading) return 'loading';
  if (hasOlder && offerLoadMore) return 'more';
  if (hasOlder === false && everHadOlder) return 'start';
  return 'none';
}

/**
 * 非虚拟化时间线（PWA）：探索组收拢后内容往往撑不满一屏，
 * 用户滚不到顶。撑不满时只展示可点的加载入口，避免一进会话就拉一整页历史。
 */
export function shouldPrefetchOlderHistory(
  hasOlder: boolean,
  loading: boolean,
  scrollHeight: number,
  clientHeight: number,
  slack = 80
): boolean {
  return hasOlder && !loading && scrollHeight <= clientHeight + slack;
}

export function execSourceFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const code = [record.code, record.command].find(
    (value) => typeof value === 'string' && value.trim()
  );
  return typeof code === 'string' ? code : null;
}

export function summarizeExecSource(code: string): string {
  const line =
    code
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? '';
  return line.length > 72 ? `${line.slice(0, 72)}…` : line;
}

export interface SandboxCallView {
  name: string;
  ok: boolean;
  error?: string;
  summary?: string;
}

export interface SandboxView {
  status: 'completed' | 'failed';
  value?: unknown;
  error?: string;
  calls: SandboxCallView[];
}

export function summarizeSandboxCalls(calls: SandboxCallView[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name} ×${count}`).join(' ');
}

/** exec（历史）与 codemode 共用沙箱卡片 */
export const isSandboxTool = (name: string): boolean => name === 'exec' || name === 'codemode';

const CODEMODE_HEADER = /^Script (?:completed|failed)\nWall time [^\n]*\nOutput:\n/;

export function stripCodemodeHeader(output: string | null): string | null {
  if (output === null) return null;
  return output.replace(CODEMODE_HEADER, '') || null;
}

export function codemodeView(
  body: string | null,
  isError: boolean,
  calls: readonly SandboxCallView[] | null
): SandboxView {
  const text = body ?? '';
  return isError
    ? { status: 'failed', error: text, calls: [...(calls ?? [])] }
    : { status: 'completed', value: text, calls: [...(calls ?? [])] };
}

export function parseSandboxOutput(output: string | null): SandboxView | null {
  if (!output?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.status !== 'completed' && record.status !== 'failed') return null;
    const calls = Array.isArray(record.calls)
      ? record.calls.flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const call = entry as Record<string, unknown>;
          if (typeof call.name !== 'string' || !call.name) return [];
          return [
            {
              name: call.name,
              ok: call.ok === true,
              ...(typeof call.error === 'string' ? { error: call.error } : {}),
              ...(typeof call.summary === 'string' ? { summary: call.summary } : {}),
            },
          ];
        })
      : [];
    return {
      status: record.status,
      ...(record.status === 'failed' && typeof record.error === 'string'
        ? { error: record.error }
        : {}),
      ...(record.status === 'completed' ? { value: record.value } : {}),
      calls,
    };
  } catch {
    return null;
  }
}

/** write 工具参数里取出写入内容 */
export function extractSubmittedPlan(
  name: string,
  args: unknown
): { title: string; text: string } | null {
  if (name !== 'submit_plan' || !args || typeof args !== 'object') return null;
  const { title, plan } = args as Record<string, unknown>;
  return typeof title === 'string' && typeof plan === 'string' && plan.trim()
    ? { title: title.trim(), text: plan.trim() }
    : null;
}

export function extractWriteContent(name: string, args: unknown): string | null {
  if (name !== 'write' || !args || typeof args !== 'object') return null;
  const content = (args as Record<string, unknown>).content;
  return typeof content === 'string' && content ? content : null;
}

/** 消息类工具的 [正文, 收件人]；子代理收件人只认本时间线 spawn 过的名字，查不到不显示 UUID */
const MESSAGE_PARTS = new Map<
  string,
  (args: Record<string, unknown>, agents: ReadonlyMap<string, string>) => unknown[]
>([
  ['message_main_agent', (args) => [args.message]],
  ['message_coworker', (args) => [args.text, args.to]],
  [
    'subagent',
    (args, agents) =>
      args.operation === 'send'
        ? [args.message, agents.get(String(args.agentId))]
        : args.operation === 'message'
          ? [args.text, agents.get(String(args.to))]
          : [],
  ],
]);
/** 投递成功回执只给模型看；失败回执与前面捎带的系统提醒不匹配，照常显示 */
const DELIVERY_RECEIPT =
  /(?:^|\n)\((?:delivered to |the main agent is blocked waiting )[^\n]*\)\s*$/;
/** 子代理 send 的纯投递回执；带 report（wait）等其它内容时整段保留 */
const SEND_RECEIPT_KEYS = new Set(['agentId', 'runId', 'delivery', 'status']);

function extractSentMessage(
  name: string,
  args: unknown,
  agents: ReadonlyMap<string, string>
): { text: string; summary: string } | null {
  const parts = MESSAGE_PARTS.get(name);
  if (!parts || !args || typeof args !== 'object') return null;
  const [body, to] = parts(args as Record<string, unknown>, agents);
  if (typeof body !== 'string' || !body.trim()) return null;
  const text = body.trim();
  return { text, summary: typeof to === 'string' && to.trim() ? `${to.trim()} · ${text}` : text };
}

/** 子代理 spawn 交代的任务；行头仍是 spawn 起的标题 */
function extractSpawnTask(name: string, args: unknown): string | null {
  if (name !== 'subagent' || !args || typeof args !== 'object') return null;
  const { operation, prompt } = args as Record<string, unknown>;
  return operation === 'spawn' && typeof prompt === 'string' && prompt.trim()
    ? prompt.trim()
    : null;
}

/** 子代理结果是末尾一段 JSON，前面可能被捎带的系统提醒顶开 */
export function splitTrailingJson(
  output: string | null | undefined
): { head: string; value: Record<string, unknown> } | null {
  if (!output) return null;
  const start = output.startsWith('{') ? 0 : output.lastIndexOf('\n{') + 1;
  try {
    const value: unknown = JSON.parse(output.slice(start));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { head: output.slice(0, start).trimEnd(), value: value as Record<string, unknown> }
      : null;
  } catch {
    return null;
  }
}

function stripDeliveryReceipt(output: string | null): string | null {
  const json = splitTrailingJson(output);
  const rest =
    json && Object.keys(json.value).every((key) => SEND_RECEIPT_KEYS.has(key))
      ? json.head
      : output?.replace(DELIVERY_RECEIPT, '');
  return rest?.trimEnd() || null;
}

/** 回执顶层带 agentId / runId 的操作；report / wait 的大段结果不在建时间线时解析 */
const RECEIPT_OPS = new Set<unknown>(['spawn', 'send', 'message']);

/** spawn 回执里的 agentId → 派活时起的名字；回执里的 runId → agentId，供后续按 id 指代的行显示标题 */
function recordSubagent(
  agents: Map<string, string>,
  runs: Map<string, string>,
  args: unknown,
  output: string | undefined
): void {
  if (!args || typeof args !== 'object') return;
  const { operation, name, description } = args as Record<string, unknown>;
  if (!RECEIPT_OPS.has(operation)) return;
  const { agentId, runId } = splitTrailingJson(output)?.value ?? {};
  if (typeof agentId !== 'string') return;
  if (typeof runId === 'string') runs.set(runId, agentId);
  if (operation !== 'spawn') return;
  const label = [name, description].find((value) => typeof value === 'string' && value.trim());
  if (typeof label === 'string') agents.set(agentId, label.trim());
}

export type SubagentOp = 'report' | 'wait' | 'stop' | 'dismiss' | 'list';
const SUBAGENT_OPS = new Set<unknown>(['report', 'wait', 'stop', 'dismiss', 'list']);

/**
 * 子代理行头：spawn 起了名字时带上名字（后续行的标题就是它）；
 * 按 runId / agentId 指代的操作带上动作，标题只认本时间线 spawn 过的名字，查不到留空也不显示 id
 */
function extractSubagentHeader(
  args: unknown,
  agents: ReadonlyMap<string, string>,
  runs: ReadonlyMap<string, string>
): { op?: SubagentOp; title: string; titles?: Record<string, string> } | null {
  if (!args || typeof args !== 'object') return null;
  const { operation, name, description, agentId, runId, runIds } = args as Record<string, unknown>;
  if (operation === 'spawn') {
    if (typeof name !== 'string' || !name.trim()) return null;
    const parts = [name, description].flatMap((part) =>
      typeof part === 'string' && part.trim() ? [part.trim()] : []
    );
    return { title: [...new Set(parts)].join(' · ') };
  }
  if (!SUBAGENT_OPS.has(operation)) return null;
  // list 结果只有 agentId，展开后按此前 spawn 过的名字逐个标注
  if (operation === 'list') {
    return agents.size > 0
      ? { op: 'list', title: '', titles: Object.fromEntries(agents) }
      : { op: 'list', title: '' };
  }
  const ids =
    operation === 'dismiss'
      ? [agentId]
      : [runId, ...(Array.isArray(runIds) ? runIds : [])].map((id) =>
          typeof id === 'string' ? runs.get(id) : undefined
        );
  const titles: Record<string, string> = {};
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const title = agents.get(id);
    if (title) titles[id] = title;
  }
  const title = [...new Set(Object.values(titles))].join(', ');
  // wait 可能等多个 run，展开后要逐个标注是哪个子代理
  return operation === 'wait' && title
    ? { op: 'wait', title, titles }
    : { op: operation as SubagentOp, title };
}

/** memory_capture 的标题（缺省取正文首行）与正文 */
function extractCapturedMemory(
  name: string,
  args: unknown
): { title: string; content: string } | null {
  if (name !== 'memory_capture' || !args || typeof args !== 'object') return null;
  const { title, content } = args as Record<string, unknown>;
  if (typeof content !== 'string' || !content.trim()) return null;
  const text = content.trim();
  const heading = typeof title === 'string' ? title.trim() : '';
  return { title: heading || text.split('\n', 1)[0].trim(), content: text };
}

export interface AskUserView {
  question: string;
  /** 当时展示的选项（ask_user 最多展示前 4 个）；自由问答为空 */
  options: string[];
  /** 用户的回答；等待中、已取消或超时失败为 null */
  answer: string | null;
  /** 超时无人回答，按 default_option 自动选择 */
  autoSelected: boolean;
}

/** 工具结果前捎带的系统提醒块（withSystemReminders 注入），不是回答的一部分 */
const LEADING_NOTICE = /^\s*<(system-reminder|background-task-update)>[\s\S]*?<\/\1>/;
const AUTO_SELECTED = / \(auto-selected: no response in time\)$/;

/** ask_user 的问题与选项取自参数，回答取自回执；回执里捎带的提醒留给调用方照常显示 */
function extractAsk(
  name: string,
  args: unknown,
  output: string | null,
  answered: boolean
): { ask: AskUserView; output: string | null } | null {
  if (name !== 'ask_user' || !args || typeof args !== 'object') return null;
  const { question, options } = args as Record<string, unknown>;
  if (typeof question !== 'string' || !question.trim()) return null;
  const shown = Array.isArray(options)
    ? options
        .slice(0, 4)
        .flatMap((option) => (typeof option === 'string' && option.trim() ? [option.trim()] : []))
    : [];
  const ask = { question: question.trim(), options: shown, answer: null, autoSelected: false };
  if (!answered || !output) return { ask, output };
  let rest = output;
  const notices: string[] = [];
  for (let block = LEADING_NOTICE.exec(rest); block; block = LEADING_NOTICE.exec(rest)) {
    notices.push(block[0].trim());
    rest = rest.slice(block[0].length);
  }
  const reply = rest.trim();
  const answer = reply.replace(AUTO_SELECTED, '');
  return {
    ask: { ...ask, answer: answer || null, autoSelected: answer !== reply },
    output: notices.join('\n\n') || null,
  };
}

/** edit 工具参数里取出替换块（保持同一数组引用，供 memo 做引用比较） */
export function extractEdits(name: string, args: unknown): EditBlock[] | null {
  if (name !== 'edit' || !args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  // legacy 单块 {path, oldText, newText}（Hashline 松 schema 下模型常用）
  if (
    !('edits' in record) &&
    typeof record.oldText === 'string' &&
    typeof record.newText === 'string'
  ) {
    return singleBlock(record, record.oldText, record.newText);
  }
  let edits = record.edits;
  // 部分模型把 edits 数组双重编码成 JSON 字符串（worker 执行侧已归一化，渲染侧同样兜底）
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const ok = edits.every(
    (e) =>
      e &&
      typeof e === 'object' &&
      typeof (e as EditBlock).oldText === 'string' &&
      typeof (e as EditBlock).newText === 'string'
  );
  return ok ? (edits as EditBlock[]) : null;
}

/** Hashline edit 无 edits[] 时，用 toolResult 前后全文合成一块可渲 diff */
function extractHashlineDiff(
  name: string,
  editDiff: { oldText: string; newText: string } | null | undefined
): EditBlock[] | null {
  if (name !== 'edit' || !editDiff) return null;
  if (typeof editDiff.oldText !== 'string' || typeof editDiff.newText !== 'string') return null;
  return singleBlock(editDiff, editDiff.oldText, editDiff.newText);
}

/** 合成的单块按来源对象缓存，保持引用稳定供行 memo 比较 */
const singleBlockCache = new WeakMap<object, EditBlock[]>();
function singleBlock(key: object, oldText: string, newText: string): EditBlock[] {
  let blocks = singleBlockCache.get(key);
  if (!blocks) {
    blocks = [{ oldText, newText }];
    singleBlockCache.set(key, blocks);
  }
  return blocks;
}

const partText = (message: ProjectedMessage): string =>
  message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

/** content 中最后一个「有内容」的 part（空白 text / unknown 不算）；全空返回 -1 */
function findLastActivePartIndex(content: ProjectedMessage['content']): number {
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (part.type === 'text' && part.text.trim()) return i;
    if (part.type === 'thinking' && part.text) return i;
    if (part.type === 'toolCall' || part.type === 'image') return i;
  }
  return -1;
}

/** 已完成 step 的模型活跃耗时；优先采用 pi 的整段请求 duration。 */
function completedStepRunMs(message: ProjectedMessage): number | undefined {
  const timing = message.timing;
  if (!timing?.completedMs) return undefined;
  return typeof message.duration === 'number' && message.duration > 0
    ? message.duration
    : Math.max(0, timing.completedMs - timing.stepStartMs);
}

/** 从该 step 的计时打点算 hover 操作条读数；打点不全则无对应字段。
 * turnActiveMs 仅在「多 step 轮次的末 step」传入，排除用户回答与审批等等待时间。 */
function perfFromTiming(message: ProjectedMessage, turnActiveMs?: number): TurnPerf | undefined {
  const timing = message.timing;
  const runMs = completedStepRunMs(message);
  if (!timing || runMs === undefined) return undefined;
  const { stepStartMs, firstTokenMs } = timing;
  const out = message.usage?.output ?? 0;
  const ttftMs =
    typeof message.ttft === 'number' && message.ttft > 0
      ? message.ttft
      : firstTokenMs !== undefined
        ? Math.max(0, firstTokenMs - stepStartMs)
        : undefined;
  return {
    runMs,
    ...(turnActiveMs !== undefined ? { turnMs: turnActiveMs } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    ...(out > 0 && runMs > 0 ? { tps: out / (runMs / 1000) } : {}),
  };
}

const THINKING_OPEN = '<thinking>';
const THINKING_CLOSE = '</thinking>';

/** Gemini 无签名思考会降级成 <thinking> 正文；拆成 thinking/text 片段，标签本身丢掉 */
function splitThinkingTaggedText(text: string): Array<{ kind: 'text' | 'thinking'; text: string }> {
  const pieces: Array<{ kind: 'text' | 'thinking'; text: string }> = [];
  const push = (kind: 'text' | 'thinking', raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed) pieces.push({ kind, text: trimmed });
  };
  let i = 0;
  while (i < text.length) {
    const openAt = text.indexOf(THINKING_OPEN, i);
    if (openAt === -1) {
      push('text', text.slice(i));
      break;
    }
    if (openAt > i) push('text', text.slice(i, openAt));
    const contentStart = openAt + THINKING_OPEN.length;
    const closeAt = text.indexOf(THINKING_CLOSE, contentStart);
    if (closeAt === -1) {
      push('thinking', text.slice(contentStart));
      break;
    }
    push('thinking', text.slice(contentStart, closeAt));
    i = closeAt + THINKING_CLOSE.length;
  }
  return pieces;
}

/**
 * 把消息投影聚合为渲染时间线：
 * - toolResult 不单独成行，折进对应 toolCall 条目（按 toolCallId 关联）
 * - assistant 的 text/thinking 各自成块，未完结（isLast 且会话 running）的块标 streaming
 * 纯函数，输入不被修改。
 */
function reviewingToolCallIds(
  pendingApprovals: readonly ApprovalRequestInfo[] | undefined
): Set<string> {
  const ids = new Set<string>();
  for (const request of pendingApprovals ?? []) {
    if (request.phase === 'reviewing' && request.toolCallId) {
      ids.add(request.toolCallId);
      const parent = nestedToolCallParent(request.toolCallId);
      if (parent) ids.add(parent);
    }
  }
  return ids;
}

function nestedPendingCount(
  toolCallId: string,
  pendingApprovals: readonly ApprovalRequestInfo[] | undefined
): number {
  return (pendingApprovals ?? []).filter(
    (request) => request.toolCallId && nestedToolCallParent(request.toolCallId) === toolCallId
  ).length;
}

function buildMessageTimeline(
  messages: TimelineMessage[],
  running: boolean,
  cwd?: string,
  toolOutputs?: Record<string, string>,
  pendingApprovals?: readonly ApprovalRequestInfo[],
  toolStartedAt?: Record<string, number>,
  historyBaseIndex = 0
): TimelineItem[] {
  const reviewingIds = reviewingToolCallIds(pendingApprovals);
  const results = new Map<
    string,
    {
      output: string;
      isError: boolean;
      todos: TodoItem[] | null;
      durationMs: number | null;
      agentMeta: { modelId?: string; outputTokens?: number; steps?: number } | null;
      editDiff: { oldText: string; newText: string } | null;
      fileChanges: ProjectedFileChange[] | null;
      applyPatchOutcome: ProjectedApplyPatchOutcome | null;
      codemodeCalls: ProjectedCodemodeCall[] | null;
      rtk?: RtkToolStats;
      backgroundTaskId?: string;
    }
  >();
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolCallId) {
      results.set(message.toolCallId, {
        output: partText(message),
        isError: message.isError === true,
        todos: message.todos ?? null,
        durationMs: message.toolDurationMs ?? null,
        agentMeta: message.subagentMeta ?? null,
        editDiff: message.editDiff ?? null,
        fileChanges: message.fileChanges ?? null,
        applyPatchOutcome: message.applyPatchOutcome ?? null,
        codemodeCalls: message.codemodeCalls ?? null,
        rtk: message.rtk,
        backgroundTaskId: message.backgroundTaskId,
      });
    }
  }

  // 工具只可能在最后一轮运行：它所在的 assistant 消息之后只会紧跟 toolResult。
  // 更晚出现 user/assistant = 轮次已推进，缺结果只是 abort 残留或同步未齐（手机端
  // 分帧同步），不得标 running——否则 ToolRow 会把历史 diff 自动展开。
  let lastTurnIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i].optimistic && messages[i].role !== 'toolResult') {
      lastTurnIndex = i;
      break;
    }
  }
  const items: TimelineItem[] = [];
  const spawnedAgents = new Map<string, string>();
  const subagentRuns = new Map<string, string>();
  // 每条消息之后的首个非 toolResult 角色（反向一次扫完）：用于判定「本轮末 step」
  const nextTurnRole: (string | undefined)[] = new Array(messages.length);
  for (let i = messages.length - 1, seen: string | undefined; i >= 0; i--) {
    nextTurnRole[i] = seen;
    if (!messages[i].optimistic && messages[i].role !== 'toolResult') seen = messages[i].role;
  }
  const lastUserMessageIndex = messages.findLastIndex((m) => m.role === 'user' && !m.optimistic);
  const lastMessageIndex = messages.findLastIndex((m) => !m.optimistic);
  // 整轮计时只累计模型请求与非交互工具的真实执行耗时；用户回答、审批、排队等空档不计。
  let turnActiveMs = 0;
  let turnSteps = 0;
  // 首个 step 失败后被重试（虚拟模型会换成员）时，回复头改用随后成功的那条的模型
  let replyModelFailed = false;
  let turnUserTimestamp: number | undefined;
  let turnHadAskUser = false;
  let currentTurnUserItem: Extract<TimelineItem, { kind: 'user' }> | undefined;
  messages.forEach((message, messageIndex) => {
    const isLastMessage = messageIndex === lastMessageIndex;
    const absIndex = historyBaseIndex + messageIndex;
    // 本地气泡不是 worker 的新轮次，不能截断前一轮的计时、流式和工具状态。
    if (message.role === 'user' && message.optimistic) {
      items.push({
        kind: 'user',
        key: `${absIndex}`,
        text: partText(message),
        images: message.content.filter((part) => part.type === 'image'),
        timestamp: message.timestamp,
        canCollapse: false,
        deliveryState: message.deliveryRejected ? 'rejected' : 'pending',
      });
      return;
    }
    if (message.role === 'user') {
      turnUserTimestamp = message.timestamp;
      turnHadAskUser = false;
      turnActiveMs = 0;
      turnSteps = 0;
      replyModelFailed = false;
      const text = partText(message);
      const images = message.content.filter((part) => part.type === 'image');
      // 后台任务完成的合成注入：不按用户气泡渲染，转为系统通知行
      const noteMatch =
        /^<background-task-update>\n?([\s\S]*?)\n?<\/background-task-update>\s*$/.exec(text.trim());
      if (noteMatch && images.length === 0) {
        const detail = noteMatch[1].trim();
        items.push({
          kind: 'task-note',
          key: `${absIndex}`,
          summary: detail.split('\n', 1)[0] ?? detail,
          detail,
        });
        // 注入消息不是用户轮次：后续回复的耗时不能回写到上一条真实 user 消息
        currentTurnUserItem = undefined;
        return;
      }
      if (text || images.length > 0) {
        let next = messageIndex + 1;
        while (messages[next]?.role === 'system' || messages[next]?.optimistic) next++;
        const hasNextReply = next < messages.length && messages[next].role !== 'user';
        const isLastTurn = messageIndex === lastUserMessageIndex;
        const canCollapse = hasNextReply && !(running && isLastTurn);
        const userItem: Extract<TimelineItem, { kind: 'user' }> = {
          kind: 'user',
          key: `${absIndex}`,
          text,
          images,
          timestamp: message.timestamp,
          canCollapse,
        };
        items.push(userItem);
        currentTurnUserItem = userItem;
      }
      return;
    }
    if (message.role === 'compactionSummary') {
      items.push({
        kind: 'compaction',
        key: `${absIndex}`,
        summary: partText(message),
        tokensBefore: message.tokensBefore ?? null,
        ...(message.verified ? { verified: true } : {}),
        ...(message.memory ? { memory: true } : {}),
      });
      return;
    }
    if (message.role === 'toolResult') {
      // ask_user 的执行期本质是等用户，不属于任务活跃用时；其余工具采用 worker 实测时长。
      if (message.toolName === 'ask_user') turnHadAskUser = true;
      if (
        turnSteps > 0 &&
        message.toolName !== 'ask_user' &&
        typeof message.toolDurationMs === 'number' &&
        Number.isFinite(message.toolDurationMs) &&
        message.toolDurationMs > 0
      ) {
        turnActiveMs += message.toolDurationMs;
      }
      return;
    }
    if (message.role !== 'assistant') return;

    // 本轮末 step（后面只剩 toolResult 或已到新一轮 user）且轮内有多个 step 时，正文读数附带活跃总耗时。
    turnSteps += 1;
    if (currentTurnUserItem && message.model && (turnSteps === 1 || replyModelFailed)) {
      currentTurnUserItem.replyModel = message.model;
      replyModelFailed = message.stopReason === 'error';
    }
    if (turnSteps === 1 && currentTurnUserItem && message.timestamp !== undefined) {
      currentTurnUserItem.replyAt = message.timestamp;
    }
    const stepRunMs = completedStepRunMs(message);
    if (stepRunMs !== undefined) turnActiveMs += stepRunMs;
    const isLastStepOfTurn =
      nextTurnRole[messageIndex] === undefined || nextTurnRole[messageIndex] === 'user';
    const perfTurnActive = isLastStepOfTurn && turnSteps > 1 ? turnActiveMs : undefined;
    const isLatestTurn = nextTurnRole[messageIndex] === undefined;
    const turnSettled = !(isLatestTurn && (running || message.stopReason === 'pending'));
    let turnDurationMs: number | undefined;
    if (isLastStepOfTurn && turnSettled) {
      if (turnActiveMs > 0) {
        turnDurationMs = turnActiveMs;
      } else if (!turnHadAskUser) {
        // 缺 step 计时才用墙钟差；有 ask_user 时墙钟含等待，不能兜底
        const endTimestamp = message.timing?.completedMs ?? message.timestamp;
        if (
          typeof turnUserTimestamp === 'number' &&
          typeof endTimestamp === 'number' &&
          endTimestamp > turnUserTimestamp
        ) {
          turnDurationMs = endTimestamp - turnUserTimestamp;
        }
      }
      if (currentTurnUserItem && turnDurationMs !== undefined) {
        currentTurnUserItem.turnDurationMs = turnDurationMs;
      }
    }
    // 「流式中」= 最后一个有内容的 part：pi 流式时 thinking/text 后面常已跟着
    // 空占位 part，按「最后一个 part」判会把正在生成的块误判为已完结
    const lastActiveIndex = findLastActivePartIndex(message.content);
    message.content.forEach((part, partIndex) => {
      const key = `${absIndex}-${partIndex}`;
      const isStreamingPart = isLastMessage && partIndex === lastActiveIndex;
      // pi 流式中的消息 stopReason 是 "pending"（非空！），只有真正的终止原因才算完结
      const settled = Boolean(message.stopReason) && message.stopReason !== 'pending';
      const streaming = running && isStreamingPart && !settled;
      switch (part.type) {
        case 'text': {
          // trim：纯空白正文（工具轮的空 text part）不产出——否则显示为幽灵空行
          if (!part.text.trim()) return;
          const pieces = splitThinkingTaggedText(part.text);
          if (pieces.length === 0) return;
          // 无标签：保持原文（含首尾空白），避免改已有 text 行形态
          if (pieces.length === 1 && pieces[0].kind === 'text') {
            const isTurnEnd = isLastStepOfTurn && !streaming;
            items.push({
              kind: 'text',
              key,
              text: part.text,
              streaming,
              timestamp: message.timestamp,
              perf: perfFromTiming(message, perfTurnActive),
              ...(isTurnEnd
                ? {
                    turnEnd: true,
                    ...(turnDurationMs !== undefined ? { turnDurationMs } : {}),
                  }
                : {}),
            });
            return;
          }
          pieces.forEach((piece, i) => {
            const pieceKey = pieces.length === 1 ? key : `${key}-${i}`;
            const pieceStreaming = streaming && i === pieces.length - 1;
            if (piece.kind === 'thinking') {
              items.push({
                kind: 'thinking',
                key: pieceKey,
                text: piece.text,
                streaming: pieceStreaming,
                durationMs: null,
              });
              return;
            }
            const isTurnEnd = isLastStepOfTurn && !pieceStreaming && i === pieces.length - 1;
            items.push({
              kind: 'text',
              key: pieceKey,
              text: piece.text,
              streaming: pieceStreaming,
              timestamp: message.timestamp,
              perf: perfFromTiming(message, perfTurnActive),
              ...(isTurnEnd
                ? {
                    turnEnd: true,
                    ...(turnDurationMs !== undefined ? { turnDurationMs } : {}),
                  }
                : {}),
            });
          });
          return;
        }
        case 'thinking':
          if (part.text) {
            // 思考耗时：step 起点到首个非 thinking 输出（无则到 step 完成）
            const timing = message.timing;
            const end = timing?.thinkingEndMs ?? timing?.completedMs;
            items.push({
              kind: 'thinking',
              key,
              text: part.text,
              streaming,
              durationMs:
                timing && end !== undefined ? Math.max(0, end - timing.stepStartMs) : null,
              ...(timing ? { startedAt: timing.stepStartMs } : {}),
            });
          }
          return;
        case 'toolCall': {
          const result = results.get(part.id);
          // 未完成时退而用执行中的输出快照（空串不算，否则行会变“可展开但空”）
          const partial = toolOutputs?.[part.id];
          const sandboxTool = isSandboxTool(part.name);
          const execSource = sandboxTool ? execSourceFromArgs(part.arguments) : null;
          const rawOutput = result
            ? result.applyPatchOutcome
              ? formatApplyPatchOutcome(result.applyPatchOutcome)
              : result.output
            : (partial ?? null) || null;
          const output = part.name === 'codemode' ? stripCodemodeHeader(rawOutput) : rawOutput;
          const sandboxView =
            part.name === 'exec'
              ? parseSandboxOutput(output)
              : part.name === 'codemode' && result
                ? codemodeView(output, result.isError, result.codemodeCalls)
                : null;
          const call = unwrapMcpProxyCall(part.name, part.arguments);
          if (part.name === 'subagent') {
            recordSubagent(spawnedAgents, subagentRuns, part.arguments, result?.output);
          }
          const subagent =
            part.name === 'subagent'
              ? extractSubagentHeader(part.arguments, spawnedAgents, subagentRuns)
              : null;
          const sent = extractSentMessage(part.name, part.arguments, spawnedAgents);
          const sentMessage = sent?.text ?? extractSpawnTask(part.name, part.arguments);
          const captured = extractCapturedMemory(part.name, part.arguments);
          const asked = extractAsk(
            part.name,
            part.arguments,
            output,
            Boolean(result && !result.isError)
          );
          const patchPaths =
            part.name !== 'apply_patch'
              ? null
              : result?.fileChanges?.length
                ? result.fileChanges.map((change) => change.path)
                : patchPathsFromArgs(part.arguments);
          const liveCommand =
            !result &&
            running &&
            messageIndex === lastTurnIndex &&
            (part.name === 'bash' || part.name === 'powershell');
          items.push({
            kind: 'tool',
            key,
            name: call.name,
            summary: execSource
              ? summarizeExecSource(execSource)
              : patchPaths
                ? patchPaths.length > 1
                  ? `${patchPaths.length} files`
                  : toProjectRelativePath(patchPaths[0] ?? '', cwd)
                : (sent?.summary ??
                  captured?.title ??
                  asked?.ask.question ??
                  subagent?.title ??
                  call.summary ??
                  summarizeArgs(call.args, cwd)),
            source: execSource,
            output: sent ? stripDeliveryReceipt(output) : asked ? asked.output : output,
            nestedPending: nestedPendingCount(part.id, pendingApprovals) || undefined,
            ...(sandboxTool ? { sandbox: sandboxView } : {}),
            state: result
              ? result.isError || sandboxView?.status === 'failed'
                ? 'error'
                : 'ok'
              : running && messageIndex === lastTurnIndex
                ? reviewingIds.has(part.id)
                  ? 'reviewing'
                  : 'running'
                : running
                  ? 'ok'
                  : 'error',
            // 执行失败 = 文件没改，参数里的意图 diff 不能显示成已应用
            edits: result?.isError
              ? null
              : (extractEdits(part.name, part.arguments) ??
                extractHashlineDiff(part.name, result?.editDiff)),
            writeContent: extractWriteContent(part.name, part.arguments),
            fileChanges: result?.fileChanges ?? null,
            todos: result?.todos ?? null,
            durationMs: result?.durationMs ?? null,
            agentMeta: result?.agentMeta ?? null,
            ...(result?.rtk ? { rtk: result.rtk } : {}),
            ...(liveCommand ? { callId: part.id } : {}),
            ...(result?.backgroundTaskId ? { backgroundTaskId: result.backgroundTaskId } : {}),
            ...(part.name === 'submit_plan'
              ? { plan: extractSubmittedPlan(part.name, part.arguments) }
              : {}),
            ...(sentMessage ? { sentMessage } : {}),
            ...(captured ? { memoryContent: captured.content } : {}),
            ...(asked ? { ask: asked.ask } : {}),
            ...(subagent?.op ? { subagentOp: subagent.op } : {}),
            ...(subagent?.titles ? { subagentTitles: subagent.titles } : {}),
            ...(result || !toolStartedAt ? {} : { startedAt: toolStartedAt[part.id] ?? null }),
          });
          return;
        }
        default:
          return;
      }
    });
    if (message.errorMessage) {
      // 瞬态错误不渲染：后面紧跟另一条 assistant = 已重试过（覆盖 resume 回放）；
      // 末条且 running = 重试倒计时中（错误文本展示在 RetryBar 上，先渲染再删会抽搐）。
      // 只有真正的终态错误（非 running 的末次尝试）才落红。
      const retried = messages[messageIndex + 1]?.role === 'assistant';
      const pendingRetry = running && messageIndex === messages.length - 1;
      if (!retried && !pendingRetry) {
        items.push({ kind: 'error', key: `${absIndex}-err`, text: message.errorMessage });
      }
    }
  });
  return items;
}

/**
 * 底部终态错误行的去重：turn-failed 的 error 与末条错误消息同文本时（503 等），
 * 时间线里已有带图标的错误项，不再重复渲染；spawn 失败等没有消息载体的错误照常显示。
 */
export function terminalErrorText(
  messages: readonly ProjectedMessage[],
  error: string | undefined
): string | undefined {
  if (!error) return undefined;
  const lastErrored = [...messages].reverse().find((message) => message.errorMessage);
  return lastErrored?.errorMessage === error ? undefined : error;
}

const customEntryTime = (entry: AgentSessionCustomEntry): number =>
  entry.kind === 'capability-receipt' ? entry.receipt.occurredAt : entry.at;

/** 行 key 的消息下标（`3` 或 `3-1`）；非消息行（custom/chrome）返回 -1 */
const messageItemIndex = (item: TimelineItem): number => {
  const separator = item.key.indexOf('-');
  const index = Number.parseInt(separator === -1 ? item.key : item.key.slice(0, separator), 10);
  return Number.isInteger(index) ? index : -1;
};

const messageItemTime = (
  item: TimelineItem,
  messages: readonly ProjectedMessage[],
  historyBaseIndex = 0
): number => {
  const index = messageItemIndex(item) - historyBaseIndex;
  return index >= 0
    ? (messages[index]?.timestamp ?? Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;
};

/**
 * 压完提示锚定在「压缩结束那一刻的消息数」上，而不是算到时间线末尾——
 * 后者会让提示永远贴底、新消息被顶到它上方。锚点之后的消息一律排它下面。
 */
function insertCompactionNotice(items: TimelineItem[], noticeAt: number): TimelineItem[] {
  const lastSummary = items.findLast((item) => item.kind === 'compaction');
  if (!lastSummary) return items;
  // 锚点必须在它提示的那次摘要之后；更早说明锚点已失效（如冷缓存清空时记成 0）。
  // 否则提示会顶成首行，上滑分页的前置行对不上，翻一页就停
  if (noticeAt <= messageItemIndex(lastSummary)) return items;
  let at = items.length;
  for (let i = 0; i < items.length; i++) {
    const index = messageItemIndex(items[i]);
    if (index >= noticeAt) {
      at = i;
      break;
    }
  }
  // 锚点比消息还靠后：投影尚未追上或已被回退，宁可不显示
  if (at === items.length && messageItemIndex(items.at(-1) ?? items[0]) + 1 < noticeAt)
    return items;
  // 整段都被压掉：摘要行本身就在锚点位置，不重复
  if (items[at - 1]?.kind === 'compaction') return items;
  const notice: TimelineItem = {
    kind: 'compaction-notice',
    key: `compaction-notice:${lastSummary.key}`,
    summary: lastSummary.summary,
    tokensBefore: lastSummary.tokensBefore,
    ...(lastSummary.verified ? { verified: true } : {}),
    ...(lastSummary.memory ? { memory: true } : {}),
  };
  return [...items.slice(0, at), notice, ...items.slice(at)];
}

function appendCompactionChrome(
  items: TimelineItem[],
  compaction?: 'queued' | 'running',
  noticeAt?: number
): TimelineItem[] {
  const withNotice = noticeAt === undefined ? items : insertCompactionNotice(items, noticeAt);
  if (!compaction) return withNotice;
  return [
    ...withNotice,
    { kind: 'compaction-progress', key: `compaction:${compaction}`, state: compaction },
  ];
}

/** Messages 与 custom entries 仅在展示层按时间合并；custom entries 从不进入 messages。 */
/**
 * 末条 assistant 仍在流式思考/正文变长：复用前缀行对象，只替换那一行。
 * 结构对不上（新 part、工具结果、非 running）返回 null，调用方全量重建。
 */
export function patchStreamingTimeline(
  previous: readonly TimelineItem[],
  messages: readonly ProjectedMessage[],
  running: boolean,
  historyBaseIndex = 0
): TimelineItem[] | null {
  if (!running || previous.length === 0) return null;
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return null;
  const settled = Boolean(last.stopReason) && last.stopReason !== 'pending';
  if (settled) return null;
  const lastActive = findLastActivePartIndex(last.content);
  if (lastActive < 0) return null;
  const part = last.content[lastActive];
  if (!part || (part.type !== 'thinking' && part.type !== 'text')) return null;
  if (part.type === 'text') {
    const pieces = splitThinkingTaggedText(part.text);
    if (pieces.length !== 1 || pieces[0].kind !== 'text') return null;
  }
  const key = `${historyBaseIndex + messages.length - 1}-${lastActive}`;
  let hit = -1;
  for (let i = previous.length - 1; i >= 0; i--) {
    const item = previous[i];
    if (item.key !== key) continue;
    if (item.kind === 'thinking' || item.kind === 'text') {
      hit = i;
      break;
    }
  }
  if (hit < 0) return null;
  const item = previous[hit];
  if (item.kind === 'thinking') {
    if (part.type !== 'thinking' || item.streaming !== true) return null;
    if (item.text === part.text) return previous as TimelineItem[];
    const next = previous.slice();
    next[hit] = { ...item, text: part.text };
    return next;
  }
  if (item.kind !== 'text' || part.type !== 'text' || item.streaming !== true) return null;
  if (item.text === part.text) return previous as TimelineItem[];
  const next = previous.slice();
  next[hit] = { ...item, text: part.text };
  return next;
}

/** 已完成的 edit/write 身份；思考/正文流式变长时保持不变，供 Files/Changes 跳过重渲染。 */
export function completedEditWriteFingerprint(messages: readonly ProjectedMessage[]): string {
  const failed = new Map<string, boolean>();
  const appliedPatches = new Map<string, ProjectedFileChange[]>();
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolCallId) {
      failed.set(message.toolCallId, message.isError === true);
      if (message.toolName === 'apply_patch' && message.fileChanges?.length) {
        appliedPatches.set(message.toolCallId, message.fileChanges);
      }
    }
  }
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      if (part.name === 'apply_patch') {
        const changes = appliedPatches.get(part.id);
        if (!changes) continue;
        parts.push(
          part.id,
          part.name,
          changes
            .map(
              (change) =>
                `${change.path}:${change.type}:${change.oldText.length}:${change.newText.length}:${change.truncated === true}`
            )
            .join('|')
        );
        continue;
      }
      if (part.name !== 'edit' && part.name !== 'write') continue;
      const isError = failed.get(part.id);
      if (isError === undefined || isError) continue;
      parts.push(part.id, part.name, JSON.stringify(part.arguments));
    }
  }
  return parts.join('\0');
}

export function buildTimeline(
  messages: TimelineMessage[],
  running: boolean,
  customEntries: readonly AgentSessionCustomEntry[] = [],
  cwd?: string,
  options?: {
    compaction?: 'queued' | 'running';
    compactionNoticeAt?: number;
    /** 当前权威消息对应的 worker 绝对起点；尾窗分页时行 key 用绝对下标 */
    historyBaseIndex?: number;
    /** 运行中工具的输出快照（toolCallId → 文本）；真实 toolResult 到位后优先用后者 */
    toolOutputs?: Record<string, string>;
    pendingApprovals?: readonly ApprovalRequestInfo[];
    toolStartedAt?: Record<string, number>;
  }
): TimelineItem[] {
  const historyBaseIndex = options?.historyBaseIndex ?? 0;
  const messageItems = buildMessageTimeline(
    messages,
    running,
    cwd,
    options?.toolOutputs,
    options?.pendingApprovals,
    options?.toolStartedAt,
    historyBaseIndex
  );
  const merged =
    customEntries.length === 0
      ? messageItems
      : [
          ...messageItems.map((item, order) => ({
            item,
            at: messageItemTime(item, messages, historyBaseIndex),
            order,
          })),
          ...customEntries.map((entry, index) => ({
            item: {
              kind: 'session-custom' as const,
              key:
                entry.kind === 'capability-receipt'
                  ? `custom:receipt:${entry.receipt.receiptId}`
                  : entry.kind === 'oauth-account-selected'
                    ? `custom:${entry.kind}:${entry.accountKey}:${entry.at}:${index}`
                    : `custom:${entry.kind}:${entry.child.generation}:${entry.at}:${index}`,
              entry,
            },
            at: customEntryTime(entry),
            order: messageItems.length + index,
          })),
        ]
          .sort((left, right) => left.at - right.at || left.order - right.order)
          .map(({ item }) => item);
  // reducer 必须保持「权威前缀 + 乐观尾巴」。只移动展示行，保留绝对 key 和权威轮次顺序。
  const localUsers = messageItems.filter((item) => item.kind === 'user' && item.deliveryState);
  const ordered = localUsers.length
    ? merged.filter((item) => !(item.kind === 'user' && item.deliveryState))
    : merged;
  for (const local of localUsers) {
    const at = local.kind === 'user' ? local.timestamp : undefined;
    const before =
      at !== undefined && Number.isFinite(at)
        ? ordered.findIndex(
            (item) =>
              item.kind === 'user' &&
              !item.deliveryState &&
              item.timestamp !== undefined &&
              Number.isFinite(item.timestamp) &&
              item.timestamp > at
          )
        : -1;
    ordered.splice(before < 0 ? ordered.length : before, 0, local);
  }
  return appendCompactionChrome(ordered, options?.compaction, options?.compactionNoticeAt);
}

/** 折叠门槛：段内非 edit 工具数达到该值才收拢 */
const FOLD_MIN_TOOLS = 3;

/** 轮次折叠时可被隐藏的行：回复正文与工具；压缩标记、错误等会话状态行必须保留 */
function isTurnSwallowable(item: TimelineItem): boolean {
  switch (item.kind) {
    case 'compaction':
    case 'compaction-notice':
    case 'compaction-progress':
    case 'error':
      return false;
    default:
      return true;
  }
}

const SEARCH_TOOLS = new Set(['grep', 'find', 'glob', 'ls']);

function classifyTool(
  name: string,
  summary: string,
  stats: ToolGroupStats,
  compact: boolean
): void {
  if (name === 'read') stats.reads += 1;
  else if (SEARCH_TOOLS.has(name)) stats.searches += 1;
  else if (name === 'bash') {
    if (!compact || !isReadOnlyCommand(summary)) stats.commands += 1;
    else if (READ_FILE_PROGRAMS.has(firstProgram(summary))) stats.reads += 1;
    else stats.searches += 1;
  } else stats.others += 1;
}

const READ_ONLY_TOOLS = new Set(['read', ...SEARCH_TOOLS]);

const READ_FILE_PROGRAMS = new Set(['cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'tac']);

/** 精简模式下按「探索」处理的工具行：只读工具，或只读的 bash 命令 */
export function isReadOnlyTool(item: { name: string; summary: string }): boolean {
  return (
    READ_ONLY_TOOLS.has(item.name) || (item.name === 'bash' && isReadOnlyCommand(item.summary))
  );
}

/** 仅展示层合并同一消息的相邻思考；保留原始 part 行供流式补丁定位。 */
function mergeAdjacentThinking(items: TimelineItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  for (const item of items) {
    const previous = result.at(-1);
    if (
      item.kind === 'thinking' &&
      previous?.kind === 'thinking' &&
      messageItemIndex(item) >= 0 &&
      messageItemIndex(previous) === messageItemIndex(item)
    ) {
      result[result.length - 1] = {
        ...previous,
        text: `${previous.text}\n\n${item.text}`,
        streaming: previous.streaming || item.streaming,
        // 各 part 共用 step 计时，不能累加；标签思考可能没有打点。
        durationMs: previous.durationMs ?? item.durationMs,
        startedAt: previous.startedAt ?? item.startedAt,
      };
    } else {
      result.push(item);
    }
  }
  return result;
}

const EXPLORE_TOOLS = new Set(['explore_mark', 'explore_fold']);
const EXPLORE_FOLD_HEAD = /^Explore folded\.[^\n]*\n*/;

/** 探索组「过程」展开态的 key：须与组头同时展开才平铺原始行 */
export const exploreStepsKey = (key: string): string => `${key}:steps`;

/** 成功的 explore_mark 到 explore_fold（含两端与其间正文/思考）收成探索组；其它行断开配对 */
function pairExploreFolds(
  items: TimelineItem[],
  expandedKeys: ReadonlySet<string>,
  compact: boolean
): TimelineItem[] {
  const result: TimelineItem[] = [];
  let start = -1;
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'thinking' && item.kind !== 'text') start = -1;
    else if (item.kind === 'tool' && item.state === 'ok') {
      if (item.name === 'explore_fold' && start >= 0) {
        const children = [...result.splice(start), item];
        const mark = children[0] as Extract<TimelineItem, { kind: 'tool' }>;
        const stats: ToolGroupStats = { commands: 0, reads: 0, searches: 0, others: 0 };
        let count = 0;
        for (const row of children) {
          if (row.kind !== 'tool' || EXPLORE_TOOLS.has(row.name)) continue;
          classifyTool(row.name, row.summary, stats, compact);
          count += 1;
        }
        const key = `explore-${mark.key}`;
        const expanded = expandedKeys.has(key);
        result.push({
          kind: 'tool-group',
          key,
          expanded,
          count,
          stats,
          exploring: false,
          explore: {
            goal: mark.summary,
            report: (item.output ?? '').replace(EXPLORE_FOLD_HEAD, '').trim(),
            steps: expanded && expandedKeys.has(exploreStepsKey(key)),
          },
          children,
        });
        start = -1;
        continue;
      }
      if (item.name === 'explore_mark' && start < 0) start = result.length;
    }
    result.push(item);
  }
  return result;
}

/** 探索组展开过程时其原始行紧随组头 */
function withExploreChildren(item: TimelineItem): TimelineItem[] {
  return item.kind === 'tool-group' && item.explore?.steps ? [item, ...item.children] : [item];
}

function activitySegment(
  segment: TimelineItem[],
  expandedKeys: ReadonlySet<string>
): TimelineItem[] {
  if (segment.length < 2) return segment.flatMap(withExploreChildren);
  const stats: ToolGroupStats = { commands: 0, reads: 0, searches: 0, others: 0 };
  let thinking = 0;
  let workedMs = 0;
  let count = 0;
  for (const row of segment.flatMap((s) => (s.kind === 'tool-group' ? s.children : [s]))) {
    if (row.kind === 'thinking') thinking += 1;
    else if (row.kind === 'tool') {
      classifyTool(row.name, row.summary, stats, false);
      count += 1;
    }
    if (row.kind === 'thinking' || row.kind === 'tool') workedMs += row.durationMs ?? 0;
  }
  const key = `group-${segment[0].key}`;
  const expanded = expandedKeys.has(key);
  const group: TimelineItem = {
    kind: 'tool-group',
    key,
    expanded,
    count,
    stats,
    exploring: false,
    activity: { thinking, workedMs },
    children: segment,
  };
  return expanded ? [group, ...segment.flatMap(withExploreChildren)] : [group];
}

/**
 * 工具行分组折叠（折中方案）：
 * - 段 = 连续的 tool/thinking 行（text/user/error 打断）；thinking 收进段内，门槛只数 tool。
 * - 带 diff 的 edit 行不进组，紧跟组头之后平铺（改动是核心产物，不折）。
 * - 默认：running 时最后一个 user 之后的段不折（进行中的轮实时展示）。
 * - compact（对齐 Cursor 的 Explored）：段只收只读工具（read/grep/find/ls/glob），
 *   bash 等其它工具打断段并平铺；live 也折，running 只读行进组，组头标 exploring。
 * - collapseCompletedActivity（对齐 deepchat）：已完成轮次里连续的思考 + 成功工具（不分类型，
 *   含 edit/write/todo）≥2 条折成一个过程组；失败/未完成工具与目标信号打断段。进行中的轮不受影响。
 * - 成功配对的 explore_mark → explore_fold 先收成探索组：平时独立成行，完成后并入过程组。
 * - expandedKeys 含组 key 时组头后平铺 children（参与虚拟化）。
 * 纯函数。
 */
export function foldTimeline(
  items: TimelineItem[],
  running: boolean,
  expandedKeys: ReadonlySet<string>,
  options: {
    compact?: boolean;
    /** 用户显式操作过的轮次：key → 是否折叠；优先于自动折叠默认值 */
    turnOverrides?: ReadonlyMap<string, boolean>;
    autoCollapseCompletedTurns?: boolean;
    collapseCompletedActivity?: boolean;
  } = {}
): TimelineItem[] {
  const compact = options.compact === true;
  const autoCollapse = options.autoCollapseCompletedTurns === true;
  const turnOverrides = options.turnOverrides;
  const origLastUserIndex = items.findLastIndex(
    (item) => item.kind === 'user' && !item.deliveryState
  );

  // 第一步：轮次折叠。正在生成的最新一轮不折叠，确保实时输出可见；
  // 自动折叠只作用于历史轮次（最后一轮默认展开），显式操作优先于默认值。
  // 压缩标记和错误行是会话状态，不随轮次隐藏。
  let sourceItems: TimelineItem[] = items;
  if (autoCollapse || (turnOverrides && turnOverrides.size > 0)) {
    const nextItems: TimelineItem[] = [];
    let idx = 0;
    while (idx < items.length) {
      const item = items[idx];
      if (item.kind === 'user') {
        const isLastUser = idx === origLastUserIndex;
        const defaultCollapsed = autoCollapse && !isLastUser && item.canCollapse === true;
        const isCollapsed =
          !item.deliveryState &&
          !(running && isLastUser) &&
          (turnOverrides?.get(item.key) ?? defaultCollapsed);
        nextItems.push(isCollapsed ? { ...item, collapsed: true } : item);
        idx += 1;
        if (isCollapsed) {
          while (idx < items.length && items[idx].kind !== 'user') {
            const hidden = items[idx];
            if (!isTurnSwallowable(hidden)) nextItems.push(hidden);
            idx += 1;
          }
        }
      } else {
        nextItems.push(item);
        idx += 1;
      }
    }
    sourceItems = nextItems;
  }
  sourceItems = pairExploreFolds(sourceItems, expandedKeys, compact);
  const lastUserIndex = sourceItems.findLastIndex(
    (item) => item.kind === 'user' && !item.deliveryState
  );
  // 生成中只有最后一段正文之后的尾段仍在进行；被正文隔开的前段已完成，可立即折叠
  const liveFrom = Math.max(
    lastUserIndex,
    sourceItems.findLastIndex((item) => item.kind === 'text')
  );
  const activityAt = (index: number): boolean =>
    options.collapseCompletedActivity === true && !(running && index > liveFrom);
  const inSegment = (s: TimelineItem, index: number): boolean =>
    s.kind === 'thinking' ||
    (s.kind === 'tool-group' && activityAt(index)) ||
    (s.kind === 'tool' &&
      (activityAt(index)
        ? s.state === 'ok' && !s.name.startsWith('goal_') && s.name !== 'submit_plan'
        : !compact || isReadOnlyTool(s)));
  const result: TimelineItem[] = [];
  let i = 0;
  while (i < sourceItems.length) {
    const item = sourceItems[i];
    if (!inSegment(item, i)) {
      result.push(...withExploreChildren(item));
      i += 1;
      continue;
    }
    // 收集连续段
    let end = i;
    while (end < sourceItems.length && inSegment(sourceItems[end], end)) end += 1;
    const segment = mergeAdjacentThinking(sourceItems.slice(i, end));
    if (activityAt(i)) {
      result.push(...activitySegment(segment, expandedKeys));
      i = end;
      continue;
    }
    const liveSegment = !compact && running && lastUserIndex >= 0 && i > lastUserIndex;
    // 钉住的行不进组：edit 的 diff、write 的内容、todo 清单是核心产物。
    // compact 下 running 只读行进组（避免完成后从平铺跳进组头抽动）；
    // 非 compact 仍把 running 钉在组外，方便看此刻在跑什么。
    const pinned = (s: TimelineItem): boolean => {
      if (s.kind !== 'tool') return false;
      if (
        s.edits !== null ||
        s.writeContent ||
        s.fileChanges?.length ||
        s.name === 'todo' ||
        s.name === 'submit_plan'
      )
        return true;
      if (s.state !== 'running' && s.state !== 'reviewing') return false;
      return !(compact && isReadOnlyTool(s));
    };
    const editRows = segment.filter(pinned);
    const groupRows = segment.filter((s) => !pinned(s));
    const toolCount = groupRows.filter((s) => s.kind === 'tool').length;
    if (liveSegment || toolCount < FOLD_MIN_TOOLS) {
      result.push(...segment);
    } else {
      const stats: ToolGroupStats = { commands: 0, reads: 0, searches: 0, others: 0 };
      for (const row of groupRows) {
        if (row.kind === 'tool') classifyTool(row.name, row.summary, stats, compact);
      }
      const key = `group-${segment[0].key}`;
      const expanded = expandedKeys.has(key);
      result.push({
        kind: 'tool-group',
        key,
        expanded,
        count: toolCount,
        stats,
        // 运行中的尾段在两次调用之间也算探索中，避免组头在「探索了 / 探索中」间来回跳
        exploring:
          compact &&
          ((running && end === sourceItems.length) ||
            groupRows.some(
              (s) => s.kind === 'tool' && (s.state === 'running' || s.state === 'reviewing')
            )),
        children: groupRows,
      });
      // 展开：原始顺序全量平铺；收拢：仅 edit 行（diff）跟在组头后
      if (expanded) result.push(...segment);
      else result.push(...editRows);
    }
    i = end;
  }
  return result;
}
