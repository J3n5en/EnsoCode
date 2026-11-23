import { redactSecrets as sharedRedactSecrets } from './redactSecrets';

/** 应用日志：结构化行（JSONL）的格式、解析、脱敏与错误汇总。纯函数，Main / worker / 测试共用 */

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type AppLogSource = 'main' | 'agent' | 'plugin' | 'mcp';

export interface AppLogEntry {
  time: number;
  level: AppLogLevel;
  source: AppLogSource;
  /** 首行摘要 */
  message: string;
  /** 完整文本（含堆栈） */
  detail: string;
}

export const APP_LOG_SOURCES: readonly AppLogSource[] = ['main', 'agent', 'plugin', 'mcp'];
export const LOG_EXPORT_HOURS = [1, 6, 24, 72, 168] as const;
export const DEFAULT_LOG_EXPORT_HOURS = 24;
export type LogSummaryLevel = 'warn' | 'error';
export type LogExportResult =
  | { ok: true; cancelled: true }
  | { ok: true; cancelled?: false; path: string; files: number }
  | { ok: false; error: string };

export function parseLogSummaryLevel(value: unknown): LogSummaryLevel {
  return value === 'warn' ? 'warn' : 'error';
}

export function parseLogExportHours(value: unknown): number | null {
  return typeof value === 'number' && LOG_EXPORT_HOURS.some((h) => h === value) ? value : null;
}
const LEVEL_RANK: Record<AppLogLevel, number> = { debug: -1, info: 0, warn: 1, error: 2 };
const MAX_TEXT = 8 * 1024;
const MAX_MESSAGE = 300;

export function isAppLogLevel(value: unknown): value is AppLogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function isAppLogSource(value: unknown): value is AppLogSource {
  return typeof value === 'string' && (APP_LOG_SOURCES as readonly string[]).includes(value);
}

export function redactSecrets(text: string): string {
  return sharedRedactSecrets(text, { mask: '***', preserveUrlUser: false, redactPii: true });
}

/** console 文本按 `[模块]` 前缀归属来源；没有前缀用进程默认来源 */
export function inferLogSource(message: string, fallback: AppLogSource): AppLogSource {
  const tag = /^\s*\[([\w.-]+)/.exec(message)?.[1]?.toLowerCase();
  if (!tag) return fallback;
  if (tag === 'mcp' || tag.startsWith('mcp')) return 'mcp';
  if (tag.startsWith('plugin') || tag.startsWith('extension-plugin')) return 'plugin';
  return fallback;
}

function truncate(text: string): string {
  return text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}…[truncated ${text.length - MAX_TEXT} chars]`
    : text;
}

export function formatAppLogLine(input: {
  time: number;
  level: AppLogLevel;
  source: AppLogSource;
  text: string;
}): string {
  const t = new Date(input.time).toISOString();
  return `${JSON.stringify({ t, l: input.level, s: input.source, m: redactSecrets(truncate(input.text)) })}\n`;
}

function entry(time: number, level: AppLogLevel, source: AppLogSource, text: string): AppLogEntry {
  const detail = redactSecrets(truncate(text.trimEnd()));
  const first = detail.split('\n', 1)[0] ?? '';
  return {
    time,
    level,
    source,
    message: first.length > MAX_MESSAGE ? `${first.slice(0, MAX_MESSAGE)}…` : first,
    detail,
  };
}

export function parseAppLogLines(text: string): AppLogEntry[] {
  const out: AppLogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const raw: unknown = JSON.parse(line);
      if (!raw || typeof raw !== 'object') continue;
      const { t, l, s, m } = raw as Record<string, unknown>;
      const time = typeof t === 'string' ? Date.parse(t) : Number.NaN;
      if (Number.isNaN(time) || !isAppLogLevel(l) || !isAppLogSource(s) || typeof m !== 'string')
        continue;
      out.push(entry(time, l, s, m));
    } catch {
      // 被截断的半行
    }
  }
  return out;
}

const PLUGIN_LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(debug|info|warn|error)\] (.*)$/;

/** 插件日志：`ISO [level] msg`，每行一条 */
export function parsePluginLogLines(text: string, pluginId: string): AppLogEntry[] {
  const out: AppLogEntry[] = [];
  for (const line of text.split('\n')) {
    const match = PLUGIN_LINE.exec(line);
    if (!match) continue;
    const level = match[2];
    if (!isAppLogLevel(level)) continue;
    out.push(entry(Date.parse(match[1]), level, 'plugin', `[${pluginId}] ${match[3]}`));
  }
  return out;
}

const STAMPED_LINE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] ?/;
const CRASH_TEXT = /uncaught|unhandled|error|exception|fatal|oom|crash/i;
const TAIL_ERROR_LINE = /\b(?:error|fatal|panic)\b|exception|uncaught|unhandled/i;

/** worker-exits.log 混有正常优雅重启记录与崩溃退出：按内容分级，避免把正常日志算成错误 */
export function classifyWorkerExitLevel(text: string): AppLogLevel {
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  if (first.startsWith('[quit-watchdog]')) return 'error';
  if (first.startsWith('[graceful-restart]')) {
    return /超时|强制退出|没在|失败|出错/.test(first) ? 'warn' : 'info';
  }
  if (first.startsWith('exit pid=')) {
    const expected =
      /\bcode=0(?:\s|\(|$)/.test(first) || /\((?:graceful restart|expected stop)\)$/.test(first);
    return expected && !CRASH_TEXT.test(first) ? 'info' : 'error';
  }
  if (first.startsWith('gone reason=')) {
    return /^gone reason=clean-exit\b/.test(first) ? 'info' : 'error';
  }
  if (first.startsWith('output tail pid=')) {
    const normal = /\(normal exit\)$/.test(first);
    return normal && !TAIL_ERROR_LINE.test(text.slice(first.length)) ? 'info' : 'warn';
  }
  return 'error';
}

/** appendCappedLog 写的 `[ISO] text`，后续无时间戳的行并入上一条 */
export function parseStampedLog(
  text: string,
  source: AppLogSource,
  level: AppLogLevel | ((text: string) => AppLogLevel)
): AppLogEntry[] {
  const out: AppLogEntry[] = [];
  let current: { time: number; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.lines.join('\n');
    const resolved = typeof level === 'function' ? level(body) : level;
    out.push(entry(current.time, resolved, source, body));
  };
  for (const line of text.split('\n')) {
    const match = STAMPED_LINE.exec(line);
    if (match) {
      flush();
      current = { time: Date.parse(match[1]), lines: [line.slice(match[0].length)] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return out;
}

/** 任意日志行的时间戳（JSONL / `[ISO]` / `ISO ` 开头），认不出返回 null */
export function logLineTime(line: string): number | null {
  const match =
    /^\{"t":"([^"]+)"/.exec(line) ??
    STAMPED_LINE.exec(line) ??
    /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s/.exec(line);
  if (!match) return null;
  const time = Date.parse(match[1]);
  return Number.isNaN(time) ? null : time;
}

export function summarizeErrors(
  entries: readonly AppLogEntry[],
  options: { minLevel: AppLogLevel; limit: number }
): AppLogEntry[] {
  const min = LEVEL_RANK[options.minLevel];
  return entries
    .filter((e) => LEVEL_RANK[e.level] >= Math.max(min, LEVEL_RANK.warn))
    .sort((a, b) => b.time - a.time)
    .slice(0, options.limit);
}
