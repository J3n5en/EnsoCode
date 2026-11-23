/** 应用日志：结构化行（JSONL）的格式、解析、脱敏与错误汇总。纯函数，Main / worker / 测试共用 */

export type AppLogLevel = 'info' | 'warn' | 'error';
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
const LEVEL_RANK: Record<AppLogLevel, number> = { info: 0, warn: 1, error: 2 };
const MAX_TEXT = 8 * 1024;
const MAX_MESSAGE = 300;

export function isAppLogLevel(value: unknown): value is AppLogLevel {
  return value === 'info' || value === 'warn' || value === 'error';
}

function isAppLogSource(value: unknown): value is AppLogSource {
  return typeof value === 'string' && (APP_LOG_SOURCES as readonly string[]).includes(value);
}

const MASK = '***';
const SECRET_NAME =
  '(?<![\\w-])[\\w-]*(?:key|token|secret|password|passwd|pwd|passphrase|authorization|auth|cookie|credentials?|signature)';
/** 顺序有讲究：先整段（私钥、URL 凭据、已知前缀），再键值对兜底。宁可多脱 */
const REDACTIONS: [RegExp, string][] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    `${MASK}PRIVATE KEY${MASK}`,
  ],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, MASK],
  [/\d{6,12}:[A-Za-z0-9_-]{30,}/g, MASK],
  // "password": "a b c" —— 引号内整段
  [
    new RegExp(`(${SECRET_NAME}["']?\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\2)[^\\\\])*\\2`, 'gi'),
    `$1$2${MASK}$2`,
  ],
  // password=xxx / token: xxx / ?api_key=xxx
  [new RegExp(`(${SECRET_NAME}["']?\\s*[:=]\\s*)(?!\\*{3})[^\\s"'&,;}\\]]+`, 'gi'), `$1${MASK}`],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
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

const PLUGIN_LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(info|warn|error)\] (.*)$/;

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

/** appendCappedLog 写的 `[ISO] text`，后续无时间戳的行并入上一条 */
export function parseStampedLog(
  text: string,
  source: AppLogSource,
  level: AppLogLevel
): AppLogEntry[] {
  const out: AppLogEntry[] = [];
  let current: { time: number; lines: string[] } | null = null;
  const flush = () => {
    if (current) out.push(entry(current.time, level, source, current.lines.join('\n')));
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
