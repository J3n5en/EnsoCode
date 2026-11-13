import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { toolResultIsError, toolResultText } from './systemReminder';

export const ARTIFACT_URI_SCHEME = 'enso-artifact://';
export const DEFAULT_MAX_INLINE_BYTES = 32 * 1024;
const ARTIFACT_GREP_LIMIT = 100;
const ARTIFACT_GREP_LINE_CHARS = 500;
/**
 * 按工具的内联预算（字节）。自带分页的工具外置会把续页提示藏进 artifact、让分页失效：
 * read 完全自管；web_fetch 每页 5 万字符，放宽到容下整页英文，多字节重的页仍外置兜底。
 */
const TOOL_INLINE_BYTES: Record<string, number> = {
  read: Number.POSITIVE_INFINITY,
  web_fetch: 64 * 1024,
};

export function parseArtifactUri(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(ARTIFACT_URI_SCHEME)) return undefined;
  const id = trimmed.slice(ARTIFACT_URI_SCHEME.length).split(/[\s?#]/)[0];
  return id || undefined;
}

function safeArtifactId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'tool';
}

function utf8Start(text: string, budget: number): string {
  let used = 0;
  let result = '';
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (used + bytes > budget) break;
    result += char;
    used += bytes;
  }
  return result;
}

function utf8End(text: string, budget: number): string {
  let used = 0;
  let start = text.length;
  for (const char of [...text].reverse()) {
    const bytes = Buffer.byteLength(char);
    if (used + bytes > budget) break;
    start -= char.length;
    used += bytes;
  }
  return text.slice(start);
}

function positiveInt(value: unknown): number | undefined {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readArtifact(text: string, params: Record<string, unknown>, maxBytes: number): string {
  const lines = text.split('\n');
  const start = positiveInt(params.offset) ?? 1;
  if (start > lines.length) {
    throw new Error(`offset ${start} is beyond artifact end (${lines.length} lines)`);
  }
  const end = Math.min(lines.length, start - 1 + (positiveInt(params.limit) ?? lines.length));
  const out: string[] = [];
  let used = 0;
  let next = start - 1;
  while (next < end) {
    const line = lines[next] ?? '';
    const bytes = Buffer.byteLength(line) + 1;
    if (used + bytes > maxBytes) {
      if (out.length === 0) {
        out.push(`${utf8Start(line, maxBytes)}\n[line ${next + 1} truncated; use grep to locate]`);
        next++;
      }
      break;
    }
    out.push(line);
    used += bytes;
    next++;
  }
  const body = out.join('\n');
  return next < lines.length
    ? `${body}\n\n[Showing lines ${start}-${next} of ${lines.length}. Use offset=${next + 1} to continue.]`
    : body;
}

function grepArtifact(text: string, params: Record<string, unknown>): string {
  const pattern = typeof params.pattern === 'string' ? params.pattern : '';
  if (!pattern) throw new Error('pattern is required');
  const source = params.literal === true ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  const re = new RegExp(source, params.ignoreCase === true ? 'i' : '');
  const limit = positiveInt(params.limit) ?? ARTIFACT_GREP_LIMIT;
  const context = Math.max(0, Math.floor(Number(params.context) || 0));
  const lines = text.split('\n');
  const hits: number[] = [];
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    if (re.test(lines[i] ?? '')) hits.push(i);
  }
  if (hits.length === 0) return 'No matches found';
  const matched = new Set(hits);
  const shown = new Set<number>();
  for (const i of hits) {
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
      shown.add(j);
    }
  }
  const out = [...shown]
    .sort((a, b) => a - b)
    .map(
      (i) =>
        `${i + 1}${matched.has(i) ? ':' : '-'} ${(lines[i] ?? '').slice(0, ARTIFACT_GREP_LINE_CHARS)}`
    );
  if (hits.length >= limit) out.push(`\n[${limit} matches limit reached; refine the pattern]`);
  return out.join('\n');
}

function receiptSource(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  if (toolName === 'grep') {
    const parts = [record.pattern, record.path ?? record.file_path].filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    );
    if (parts.length) return parts.join('; ');
  }
  for (const key of ['query', 'url', 'pattern', 'path', 'file_path', 'command']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 256);
  }
  return undefined;
}

function buildReceipt(
  toolName: string,
  args: unknown,
  reference: string,
  isError: boolean
): string {
  const source = receiptSource(toolName, args);
  return [
    '[Tool output externalized',
    `Tool: ${toolName}`,
    source ? `Source: ${source}` : '',
    isError ? 'Result: error' : '',
    `Artifact: ${reference}`,
    '',
    'Recover the needed facts from this artifact now, before answering, inferring, or searching another source.',
    `Search it with grep(path="${reference}", pattern), then read ranges with read(path="${reference}", offset, limit).`,
    'The artifact URI works only with read/grep; do not pass it to bash or guess a filesystem path.',
    'Do not treat this receipt as evidence.]',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export class ToolOutputBudget {
  readonly rootDir: string;
  readonly maxInlineBytes: number;

  constructor(options: { rootDir: string; maxInlineBytes?: number }) {
    this.rootDir = options.rootDir;
    this.maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  }

  write(id: string, text: string): string {
    mkdirSync(this.rootDir, { recursive: true });
    const safe = safeArtifactId(id);
    writeFileSync(path.join(this.rootDir, `${safe}.txt`), text, 'utf8');
    return `${ARTIFACT_URI_SCHEME}${safe}`;
  }

  read(uri: string): string | undefined {
    const id = parseArtifactUri(uri);
    // uri 来自模型：只认 write() 产出的安全 id，带 `/`、`\`、`..` 的路径会把读取带出 rootDir
    if (!id || safeArtifactId(id) !== id) return undefined;
    try {
      return readFileSync(path.join(this.rootDir, `${id}.txt`), 'utf8');
    } catch {
      return undefined;
    }
  }
}

function mergeDetails(details: unknown, extra: Record<string, unknown>): Record<string, unknown> {
  const base =
    details && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : {};
  return { ...base, ...extra };
}

export function withToolOutputBudget(
  definition: ToolDefinition,
  budget: ToolOutputBudget
): ToolDefinition {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (definition.name === 'read' || definition.name === 'grep') {
        const args = (params ?? {}) as Record<string, unknown>;
        const filePath = String(args.path ?? '');
        if (parseArtifactUri(filePath)) {
          const text = budget.read(filePath);
          if (text === undefined) throw new Error(`unknown artifact: ${filePath}`);
          const output =
            definition.name === 'read'
              ? readArtifact(text, args, budget.maxInlineBytes)
              : grepArtifact(text, args);
          return { content: [{ type: 'text' as const, text: output }], details: undefined };
        }
      }
      const result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
      const inlineBytes = TOOL_INLINE_BYTES[definition.name] ?? budget.maxInlineBytes;
      if (inlineBytes === Number.POSITIVE_INFINITY) return result;
      const text = toolResultText(result);
      const originalBytes = Buffer.byteLength(text);
      if (!text || originalBytes <= Math.max(inlineBytes, budget.maxInlineBytes)) return result;
      const media = result.content.filter((part) => part.type !== 'text');
      try {
        const reference = budget.write(toolCallId, text);
        return {
          ...result,
          content: [
            {
              type: 'text',
              text: buildReceipt(definition.name, params, reference, toolResultIsError(result)),
            },
            ...media,
          ],
          details: mergeDetails(result.details, {
            externalized: true,
            fallback: false,
            original_bytes: originalBytes,
            reference,
          }),
        };
      } catch {
        const previewBytes = Math.min(budget.maxInlineBytes, 2_048);
        const notice = `\n\n[tool output truncated: ${originalBytes} bytes; artifact persistence failed]\n\n`;
        return {
          ...result,
          content: [
            {
              type: 'text',
              text: `${utf8Start(text, Math.ceil(previewBytes / 2))}${notice}${utf8End(text, Math.floor(previewBytes / 2))}`,
            },
            ...media,
          ],
          details: mergeDetails(result.details, {
            externalized: false,
            fallback: true,
            original_bytes: originalBytes,
          }),
        };
      }
    },
  };
}
