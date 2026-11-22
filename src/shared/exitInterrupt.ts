/**
 * 应用退出（含安装更新时被 pkill）打断正在跑的回合。
 *
 * 退出前把正在跑的会话记到 userData/agent/running-at-exit.json；启动时据此把会话标成
 * interrupted，并把落在退出窗口内的断流/断连错误归到「退出导致」，不让它冒成会话失败。
 * 这里只放纯逻辑，读写文件在 main/services/runningAtExit.ts。
 */

export const RUNNING_AT_EXIT_FILE = 'running-at-exit.json';

/** 退出前多久内的错误算「退出导致」：进程被杀时最后一条消息可能早于退出时刻 */
export const EXIT_WINDOW_BEFORE_MS = 30_000;
/** 启动后多久内到达的错误仍算「退出导致」：退出瞬间的失败可能晚一步才回流 */
export const EXIT_WINDOW_AFTER_MS = 10_000;
/** 超过一天的中断记录不再采信，避免陈旧文件误伤同 id 的新回合 */
export const EXIT_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** quit = 正常退出 / 被信号杀掉；update = 安装更新后重启 */
export type ExitKind = 'quit' | 'update';

export interface RunningAtExitEntry {
  conversationId: string;
  /** 这一轮的 id（worker 在 agent_start 生成；未知时缺省） */
  turnId?: string;
  /** 这一轮开始时刻 */
  startedAt: number;
  /** 退出时最后一条消息的绝对下标（未知时缺省） */
  lastMessageIndex?: number;
}

export interface RunningAtExitRecord {
  v: 1;
  /** 写入时刻：正常退出是退出时刻，被 SIGKILL 时是最后一次心跳 */
  at: number;
  pid: number;
  kind: ExitKind;
  sessions: RunningAtExitEntry[];
}

export interface ExitWindow {
  from: number;
  to: number;
}

/** 启动时交给渲染层与秘书的中断事实 */
export interface InterruptedTurn {
  conversationId: string;
  turnId?: string;
  startedAt?: number;
  /** 应用关闭时刻（SIGKILL 时是最后一次心跳） */
  exitAt: number;
  kind: ExitKind;
  lastMessageIndex?: number;
  /** 中断时没有结果的工具调用名：可能已经执行了一半 */
  unfinishedTools: string[];
  /** 被判定为「退出导致」而吞掉的模型错误原文 */
  suppressedError?: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalIndex(value: unknown): number | undefined {
  return isFiniteNumber(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** 坏文件、脏值一律不采信：宁可不报中断，也不误标正常会话 */
export function parseRunningAtExit(value: unknown): RunningAtExitRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (!isFiniteNumber(record.at) || record.at <= 0) return null;
  if (!isFiniteNumber(record.pid) || record.pid <= 0) return null;
  if (record.kind !== 'quit' && record.kind !== 'update') return null;
  if (!Array.isArray(record.sessions)) return null;
  const sessions: RunningAtExitEntry[] = [];
  for (const item of record.sessions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.conversationId !== 'string' || entry.conversationId === '') continue;
    sessions.push({
      conversationId: entry.conversationId,
      ...(typeof entry.turnId === 'string' && entry.turnId !== '' ? { turnId: entry.turnId } : {}),
      startedAt: isFiniteNumber(entry.startedAt) ? entry.startedAt : record.at,
      ...(optionalIndex(entry.lastMessageIndex) === undefined
        ? {}
        : { lastMessageIndex: optionalIndex(entry.lastMessageIndex) }),
    });
  }
  return {
    v: 1,
    at: record.at,
    pid: Math.floor(record.pid),
    kind: record.kind,
    sessions,
  };
}

export function exitWindowOf(record: { at: number }, startupAt: number): ExitWindow {
  return { from: record.at - EXIT_WINDOW_BEFORE_MS, to: startupAt + EXIT_WINDOW_AFTER_MS };
}

/** 磁盘上的中断事实要按 unknown 收窄：坏文件不能变成假的中断 */
export function parseInterruptedTurn(value: unknown): InterruptedTurn | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const turn = value as Record<string, unknown>;
  if (typeof turn.conversationId !== 'string' || turn.conversationId === '') return null;
  if (!isFiniteNumber(turn.exitAt)) return null;
  if (turn.kind !== 'quit' && turn.kind !== 'update') return null;
  const tools = Array.isArray(turn.unfinishedTools)
    ? turn.unfinishedTools.filter((name): name is string => typeof name === 'string' && name !== '')
    : [];
  return {
    conversationId: turn.conversationId,
    ...(typeof turn.turnId === 'string' && turn.turnId !== '' ? { turnId: turn.turnId } : {}),
    ...(isFiniteNumber(turn.startedAt) ? { startedAt: turn.startedAt } : {}),
    exitAt: turn.exitAt,
    kind: turn.kind,
    ...(optionalIndex(turn.lastMessageIndex) === undefined
      ? {}
      : { lastMessageIndex: optionalIndex(turn.lastMessageIndex) }),
    unfinishedTools: tools,
    ...(typeof turn.suppressedError === 'string' && turn.suppressedError !== ''
      ? { suppressedError: turn.suppressedError }
      : {}),
  };
}

export function parseInterruptedTurns(value: unknown): InterruptedTurn[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseInterruptedTurn).filter((turn): turn is InterruptedTurn => turn !== null);
}

export function inExitWindow(at: number, window: ExitWindow): boolean {
  return at >= window.from && at <= window.to;
}

/**
 * 进程被杀时模型层只会看到连接断掉，报出来的都是这几种。
 * 退出收尾中止模型请求时则是 undici fetch 的 AbortError（This operation was aborted）
 * 或 pi-ai 重试等待被中止（Request aborted）；只有落在退出窗口内的才算退出导致。
 * 只认明确的断流/断连；鉴权、限流、5xx、上下文超限仍按真实失败处理。
 */
const EXIT_CAUSED_ERROR_PATTERNS = [
  /stream ended before a terminal response event/i,
  /\bECONNRESET\b/,
  /socket hang up/i,
  /other side closed/i,
  /UND_ERR_SOCKET/i,
  /\bEPIPE\b/,
  /^This operation was aborted$/,
  /^Request aborted$/,
];

export function isExitCausedStreamError(text: string | undefined): boolean {
  if (!text) return false;
  return EXIT_CAUSED_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/** 本地钟点：用户要能直接对上「几点被关的」 */
export function formatExitClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const KIND_TEXT: Record<'zh' | 'en', Record<ExitKind, string>> = {
  zh: { quit: '被关闭', update: '被关闭（安装更新）' },
  en: { quit: 'was closed', update: 'was closed (installing an update)' },
};

/**
 * 中断原因：说清是应用退出打断的，而不是模型/网络出错。
 * 有未完成的工具调用必须点名——那些调用可能只执行了一半。
 */
export function interruptReason(input: {
  at: number;
  kind: ExitKind;
  unfinishedTools: readonly string[];
  lang: 'zh' | 'en';
}): string {
  const clock = formatExitClock(input.at);
  const tools = [...new Set(input.unfinishedTools)];
  if (input.lang === 'en') {
    const head = `The app ${KIND_TEXT.en[input.kind]} at ${clock} and this turn was interrupted.`;
    const toolsLine =
      tools.length > 0
        ? ` ${tools.length} tool call(s) never returned (${tools.join(', ')}) and may have run halfway — check the result before continuing.`
        : '';
    return `${head}${toolsLine}`.trim();
  }
  const head = `应用在 ${clock} ${KIND_TEXT.zh[input.kind]}，这一轮被中断。`;
  const toolsLine =
    tools.length > 0
      ? `中断时有 ${tools.length} 个工具调用没有结果（${tools.join('、')}），可能只执行了一半，继续前请先检查。`
      : '';
  return `${head}${toolsLine}`;
}

/** 会话里的系统提示：原因 + 重试引导 */
export function interruptNotice(input: {
  at: number;
  kind: ExitKind;
  unfinishedTools: readonly string[];
  lang: 'zh' | 'en';
}): string {
  const reason = interruptReason(input);
  return input.lang === 'en' ? `${reason} You can retry to continue.` : `${reason}可以点重试继续。`;
}
