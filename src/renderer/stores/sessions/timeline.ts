import type {
  AgentSessionCustomEntry,
  ProjectedMessage,
  TodoItem,
  TurnPerf,
} from '@shared/types/agent';

/** edit 工具的单个替换块（pi edit 工具参数 edits[] 的元素） */
export interface EditBlock {
  oldText: string;
  newText: string;
}

export type TimelineItem =
  | { kind: 'user'; key: string; text: string; images: { data: string; mimeType: string }[] }
  | {
      kind: 'text';
      key: string;
      text: string;
      streaming: boolean;
      timestamp?: number;
      perf?: TurnPerf;
      /** 本轮已结束的最后一条正文：可从这里开平行会话 */
      turnEnd?: boolean;
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
      state: 'running' | 'ok' | 'error';
      /** edit 工具的替换块，用于渲染 diff；非 edit 为 null */
      edits: EditBlock[] | null;
      /** write 工具写入的文件内容,展开即可查看;非 write 为 null */
      writeContent: string | null;
      /** todo 工具的清单快照；非 todo 为 null */
      todos: TodoItem[] | null;
      /** 工具执行耗时（完成后显示）；未知为 null */
      durationMs: number | null;
      /** subagent 工具的执行元数据（模型/token/步数）；非 subagent 为 null */
      agentMeta: { modelId?: string; outputTokens?: number; steps?: number } | null;
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
      /** 组内原始行（tool + 夹在其间的 thinking），展开时平铺为顶层行 */
      children: TimelineItem[];
    }
  | { kind: 'error'; key: string; text: string }
  /** pi 的 compaction 摘要：之前的历史已被压缩出 LLM 上下文，渲染为分隔行 */
  | { kind: 'compaction'; key: string; summary: string; tokensBefore: number | null }
  /** 压缩进行中 / 排队：钉在时间线底部，不依赖占用面板 */
  | { kind: 'compaction-progress'; key: string; state: 'queued' | 'running' }
  /** 摘要不在末尾时，底部再钉一条可展开提示 */
  | { kind: 'compaction-notice'; key: string; summary: string; tokensBefore: number | null }
  /** 后台任务完成的合成注入消息（<background-task-update>），渲染为系统通知行 */
  | { kind: 'task-note'; key: string; summary: string; detail: string }
  /** 不进入 LLM context 的 parent/child SessionManager custom entry。 */
  | { kind: 'session-custom'; key: string; entry: AgentSessionCustomEntry };

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
];

const PATH_SUMMARY_KEYS = new Set(['path', 'file_path']);

/** 项目内绝对路径收成相对路径；前缀碰巧相同的目录不误切 */
export function toProjectRelativePath(value: string, cwd?: string): string {
  if (!cwd) return value;
  const root = cwd.replace(/[/\\]+$/, '');
  if (!root) return value;
  if (value === root) return '.';
  const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`;
  if (value.startsWith(prefix)) return value.slice(prefix.length);
  const winPrefix = `${root}\\`;
  if (value.startsWith(winPrefix)) return value.slice(winPrefix.length).replace(/\\/g, '/');
  return value;
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
  const json = JSON.stringify(record);
  return json === '{}' ? '' : json.slice(0, 80);
}

/** write 工具参数里取出写入内容 */
function extractWriteContent(name: string, args: unknown): string | null {
  if (name !== 'write' || !args || typeof args !== 'object') return null;
  const content = (args as Record<string, unknown>).content;
  return typeof content === 'string' && content ? content : null;
}

/** edit 工具参数里取出替换块（保持同一数组引用，供 memo 做引用比较） */
function extractEdits(name: string, args: unknown): EditBlock[] | null {
  if (name !== 'edit' || !args || typeof args !== 'object') return null;
  let edits = (args as Record<string, unknown>).edits;
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

/** 从该 step 的计时打点算 hover 操作条读数；打点不全则无对应字段。
 * turnStartMs 为本轮首 step 的起点，仅在「多 step 轮次的末 step」传入→ 附带整轮总耗时 turnMs */
function perfFromTiming(message: ProjectedMessage, turnStartMs?: number): TurnPerf | undefined {
  const timing = message.timing;
  if (!timing?.completedMs) return undefined;
  const { stepStartMs, firstTokenMs, completedMs } = timing;
  const out = message.usage?.output ?? 0;
  const decodeMs = firstTokenMs !== undefined ? completedMs - firstTokenMs : 0;
  return {
    runMs: Math.max(0, completedMs - stepStartMs),
    ...(turnStartMs !== undefined ? { turnMs: Math.max(0, completedMs - turnStartMs) } : {}),
    ...(firstTokenMs !== undefined ? { ttftMs: Math.max(0, firstTokenMs - stepStartMs) } : {}),
    ...(out > 0 && decodeMs > 0 ? { tps: out / (decodeMs / 1000) } : {}),
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
function buildMessageTimeline(
  messages: ProjectedMessage[],
  running: boolean,
  cwd?: string
): TimelineItem[] {
  const results = new Map<
    string,
    {
      output: string;
      isError: boolean;
      todos: TodoItem[] | null;
      durationMs: number | null;
      agentMeta: { modelId?: string; outputTokens?: number; steps?: number } | null;
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
      });
    }
  }

  // 工具只可能在最后一轮运行：它所在的 assistant 消息之后只会紧跟 toolResult。
  // 更晚出现 user/assistant = 轮次已推进，缺结果只是 abort 残留或同步未齐（手机端
  // 分帧同步），不得标 running——否则 ToolRow 会把历史 diff 自动展开。
  let lastTurnIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'toolResult') {
      lastTurnIndex = i;
      break;
    }
  }
  const items: TimelineItem[] = [];
  // 每条消息之后的首个非 toolResult 角色（反向一次扫完）：用于判定「本轮末 step」
  const nextTurnRole: (string | undefined)[] = new Array(messages.length);
  for (let i = messages.length - 1, seen: string | undefined; i >= 0; i--) {
    nextTurnRole[i] = seen;
    if (messages[i].role !== 'toolResult') seen = messages[i].role;
  }
  // 整轮计时：首 step 起点与本轮已见 step 数；遇 user 消息重置
  let turnStartMs: number | undefined;
  let turnSteps = 0;
  messages.forEach((message, messageIndex) => {
    const isLastMessage = messageIndex === messages.length - 1;
    if (message.role === 'user') {
      turnStartMs = undefined;
      turnSteps = 0;
      const text = partText(message);
      const images = message.content.filter((part) => part.type === 'image');
      // 后台任务完成的合成注入：不按用户气泡渲染，转为系统通知行
      const noteMatch =
        /^<background-task-update>\n?([\s\S]*?)\n?<\/background-task-update>\s*$/.exec(text.trim());
      if (noteMatch && images.length === 0) {
        const detail = noteMatch[1].trim();
        items.push({
          kind: 'task-note',
          key: `${messageIndex}`,
          summary: detail.split('\n', 1)[0] ?? detail,
          detail,
        });
        return;
      }
      if (text || images.length > 0) {
        items.push({ kind: 'user', key: `${messageIndex}`, text, images });
      }
      return;
    }
    if (message.role === 'compactionSummary') {
      items.push({
        kind: 'compaction',
        key: `${messageIndex}`,
        summary: partText(message),
        tokensBefore: message.tokensBefore ?? null,
      });
      return;
    }
    if (message.role === 'toolResult') return;
    if (message.role !== 'assistant') return;

    // 本轮末 step（后面只剩 toolResult 或已到新一轮 user）且轮内有多个 step 时，正文读数附带整轮总耗时
    turnSteps += 1;
    if (turnStartMs === undefined && message.timing) turnStartMs = message.timing.stepStartMs;
    const isLastStepOfTurn =
      nextTurnRole[messageIndex] === undefined || nextTurnRole[messageIndex] === 'user';
    const perfTurnStart = isLastStepOfTurn && turnSteps > 1 ? turnStartMs : undefined;
    // 「流式中」= 最后一个有内容的 part：pi 流式时 thinking/text 后面常已跟着
    // 空占位 part，按「最后一个 part」判会把正在生成的块误判为已完结
    const lastActiveIndex = findLastActivePartIndex(message.content);
    message.content.forEach((part, partIndex) => {
      const key = `${messageIndex}-${partIndex}`;
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
            items.push({
              kind: 'text',
              key,
              text: part.text,
              streaming,
              timestamp: message.timestamp,
              perf: perfFromTiming(message, perfTurnStart),
              ...(isLastStepOfTurn && !streaming ? { turnEnd: true } : {}),
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
            items.push({
              kind: 'text',
              key: pieceKey,
              text: piece.text,
              streaming: pieceStreaming,
              timestamp: message.timestamp,
              perf: perfFromTiming(message, perfTurnStart),
              ...(isLastStepOfTurn && !pieceStreaming && i === pieces.length - 1
                ? { turnEnd: true }
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
          items.push({
            kind: 'tool',
            key,
            name: part.name,
            summary: summarizeArgs(part.arguments, cwd),
            output: result ? result.output : null,
            state: result
              ? result.isError
                ? 'error'
                : 'ok'
              : running && messageIndex === lastTurnIndex
                ? 'running'
                : running
                  ? 'ok'
                  : 'error',
            edits: extractEdits(part.name, part.arguments),
            writeContent: extractWriteContent(part.name, part.arguments),
            todos: result?.todos ?? null,
            durationMs: result?.durationMs ?? null,
            agentMeta: result?.agentMeta ?? null,
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
        items.push({ kind: 'error', key: `${messageIndex}-err`, text: message.errorMessage });
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

const messageItemTime = (item: TimelineItem, messages: readonly ProjectedMessage[]): number => {
  const separator = item.key.indexOf('-');
  const index = Number.parseInt(separator === -1 ? item.key : item.key.slice(0, separator), 10);
  return Number.isInteger(index)
    ? (messages[index]?.timestamp ?? Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;
};

function appendCompactionChrome(
  items: TimelineItem[],
  compaction?: 'queued' | 'running'
): TimelineItem[] {
  if (compaction) {
    return [
      ...items,
      { kind: 'compaction-progress', key: `compaction:${compaction}`, state: compaction },
    ];
  }
  const lastSummary = items.findLast((item) => item.kind === 'compaction');
  if (!lastSummary || items.at(-1)?.kind === 'compaction') return items;
  return [
    ...items,
    {
      kind: 'compaction-notice',
      key: `compaction-notice:${lastSummary.key}`,
      summary: lastSummary.summary,
      tokensBefore: lastSummary.tokensBefore,
    },
  ];
}

/** Messages 与 custom entries 仅在展示层按时间合并；custom entries 从不进入 messages。 */
export function buildTimeline(
  messages: ProjectedMessage[],
  running: boolean,
  customEntries: readonly AgentSessionCustomEntry[] = [],
  cwd?: string,
  options?: { compaction?: 'queued' | 'running' }
): TimelineItem[] {
  const messageItems = buildMessageTimeline(messages, running, cwd);
  const merged =
    customEntries.length === 0
      ? messageItems
      : [
          ...messageItems.map((item, order) => ({
            item,
            at: messageItemTime(item, messages),
            order,
          })),
          ...customEntries.map((entry, index) => ({
            item: {
              kind: 'session-custom' as const,
              key:
                entry.kind === 'capability-receipt'
                  ? `custom:receipt:${entry.receipt.receiptId}`
                  : `custom:${entry.kind}:${entry.child.generation}:${entry.at}:${index}`,
              entry,
            },
            at: customEntryTime(entry),
            order: messageItems.length + index,
          })),
        ]
          .sort((left, right) => left.at - right.at || left.order - right.order)
          .map(({ item }) => item);
  return appendCompactionChrome(merged, options?.compaction);
}

/** 折叠门槛：段内非 edit 工具数达到该值才收拢 */
const FOLD_MIN_TOOLS = 3;

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

/** 只读 bash 白名单：段首程序在这里且无写副作用标志才算探索（env/xargs/tee 等能转执行或写文件的不收） */
const READ_ONLY_PROGRAMS = new Set([
  'ls',
  'tree',
  'pwd',
  'cd',
  'cat',
  'bat',
  'head',
  'tail',
  'wc',
  'nl',
  'tac',
  'less',
  'more',
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ag',
  'find',
  'fd',
  'fdfind',
  'which',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'sort',
  'uniq',
  'cut',
  'tr',
  'awk',
  'sed',
  'diff',
  'jq',
  'yq',
  'echo',
  'printf',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'printenv',
  'date',
  'whoami',
  'uname',
  'column',
  'true',
  'test',
  '[',
  'git',
]);
const READ_FILE_PROGRAMS = new Set(['cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'tac']);
const GIT_READ_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'grep',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'describe',
  'shortlog',
  'reflog',
  'cat-file',
  'name-rev',
  'remote',
  'config',
  'branch',
  'tag',
]);
/** 各程序里会写文件 / 转执行的参数，命中即非只读 */
const WRITE_FLAGS: Record<string, RegExp> = {
  sed: /^(-[a-zA-Z]*i|--in-place)|\/[a-zA-Z]*e[a-zA-Z]*['"]?$|^['"]?e\b/,
  awk: /system\s*\(/,
  yq: /^(-i|--inplace)$/,
  sort: /^(-o|--output)/,
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fprint0|fls)$/,
  git: /^--output/,
};
/** git 只读子命令里带这些参数就是写：branch -d / tag -a / config --unset / remote add … */
const GIT_WRITE_ARGS: Record<string, RegExp> = {
  branch: /^-(d|D|m|M|c|C|u|f|-delete|-move|-copy|-set-upstream-to|-unset-upstream|-force)/,
  tag: /^-(a|s|d|f|m|F|-annotate|-sign|-delete|-force|-message)/,
  config: /^(-e|--edit|--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section)$/,
  remote: /^(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)$/,
};

function splitEnvPrefix(segment: string): { env: string[]; tokens: string[] } {
  const tokens = segment.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  return { env: tokens.slice(0, i), tokens: tokens.slice(i) };
}

function firstProgram(segment: string): string {
  const head = splitEnvPrefix(segment).tokens[0] ?? '';
  return head.slice(head.lastIndexOf('/') + 1);
}

/**
 * 判定一条 bash 命令是否纯只读（ls/rg/cat/git status …），用于精简模式把它当探索折进组。
 * 只影响展示密度，不参与审批；策略保守：重定向、命令/进程替换、后台 &、写参数、
 * 未知程序、GIT_* 环境前缀（GIT_EXTERNAL_DIFF 等会转执行）一律判非只读。
 */
function hasC0Control(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f && code !== 0x0a) return true;
  }
  return false;
}

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // 命令替换 / 进程替换 / 反引号可藏任意命令；控制字符（\r 等）可拼接隐藏命令
  if (/\$\(|<\(|`/.test(trimmed) || hasC0Control(trimmed)) return false;
  // 去掉无害的 stderr 重定向后，剩余任何 > 都视为写文件
  const withoutStderr = trimmed.replace(/2>&1|[12]?>\s*\/dev\/null/g, '');
  if (withoutStderr.includes('>')) return false;
  // 段分隔：| || && ; & 换行（单个 & 是后台执行，同样开新命令）
  const segments = withoutStderr.split(/\|\|?|&&?|;|\n/);
  for (const raw of segments) {
    const segment = raw.trim();
    if (!segment) continue;
    const { env, tokens } = splitEnvPrefix(segment);
    if (env.some((e) => e.startsWith('GIT_'))) return false;
    const program = firstProgram(segment);
    if (!READ_ONLY_PROGRAMS.has(program)) return false;
    const writeFlag = WRITE_FLAGS[program];
    if (writeFlag && tokens.slice(1).some((t) => writeFlag.test(t))) return false;
    if (program === 'git') {
      const sub = tokens.find((t, i) => i > 0 && !t.startsWith('-'));
      if (!sub || !GIT_READ_SUBCOMMANDS.has(sub)) return false;
      const args = tokens.slice(tokens.indexOf(sub) + 1);
      const writeArg = GIT_WRITE_ARGS[sub];
      if (writeArg && args.some((t) => writeArg.test(t))) return false;
      // git config 只读形态：--get/--list/-l；裸 `git config a b` 是写
      if (
        sub === 'config' &&
        !args.some((t) => /^(--get|--get-all|--list|-l|--get-regexp)$/.test(t))
      )
        return false;
    }
  }
  return true;
}

/** 精简模式下按「探索」处理的工具行：只读工具，或只读的 bash 命令 */
export function isReadOnlyTool(item: { name: string; summary: string }): boolean {
  return (
    READ_ONLY_TOOLS.has(item.name) || (item.name === 'bash' && isReadOnlyCommand(item.summary))
  );
}

/**
 * 工具行分组折叠（折中方案）：
 * - 段 = 连续的 tool/thinking 行（text/user/error 打断）；thinking 收进段内，门槛只数 tool。
 * - 带 diff 的 edit 行不进组，紧跟组头之后平铺（改动是核心产物，不折）。
 * - 默认：running 时最后一个 user 之后的段不折（进行中的轮实时展示）。
 * - compact（对齐 Cursor 的 Explored）：段只收只读工具（read/grep/find/ls/glob），
 *   bash 等其它工具打断段并平铺；live 也折，running 行钉在组外，组头标 exploring。
 * - expandedKeys 含组 key 时组头后平铺 children（参与虚拟化）。
 * 纯函数。
 */
export function foldTimeline(
  items: TimelineItem[],
  running: boolean,
  expandedKeys: ReadonlySet<string>,
  options: { compact?: boolean } = {}
): TimelineItem[] {
  const compact = options.compact === true;
  const lastUserIndex = items.findLastIndex((item) => item.kind === 'user');
  const inSegment = (s: TimelineItem): boolean =>
    s.kind === 'thinking' || (s.kind === 'tool' && (!compact || isReadOnlyTool(s)));
  const result: TimelineItem[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (!inSegment(item)) {
      result.push(item);
      i += 1;
      continue;
    }
    // 收集连续段
    let end = i;
    while (end < items.length && inSegment(items[end])) end += 1;
    const segment = items.slice(i, end);
    const liveSegment = !compact && running && lastUserIndex >= 0 && i > lastUserIndex;
    // 钉住的行不进组：edit 的 diff、write 的内容、todo 清单是核心产物，
    // running 行是「此刻在跑什么」，都不折进黑盒
    const pinned = (s: TimelineItem): boolean =>
      s.kind === 'tool' &&
      (s.edits !== null || !!s.writeContent || s.name === 'todo' || s.state === 'running');
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
        exploring: compact && editRows.some((s) => s.kind === 'tool' && s.state === 'running'),
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
