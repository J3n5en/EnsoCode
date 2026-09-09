const DEFAULT_READ_BYTES_LIMIT = 50 * 1024;
const SHOWING_LINES = /Showing lines \d+-\d+ of (\d+)/;

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function startLine(offset: number): number {
  return Number.isFinite(offset) && offset > 1 ? Math.floor(offset) : 1;
}

/** pi 的 truncation.totalLines 是从 offset 起的剩余行（wc -l），还原成文件总行数。 */
function fileTotalLines(remaining: number | undefined, offset: number): number | undefined {
  if (remaining == null) return undefined;
  const start = startLine(offset);
  return start > 1 ? remaining + start - 1 : remaining;
}

function rewriteShowingFooter(text: string, totalLines: number): string {
  return text.replace(SHOWING_LINES, (_all, reported: string) =>
    Number(reported) === totalLines ? _all : _all.replace(` of ${reported}`, ` of ${totalLines}`)
  );
}

/** 去掉 truncation.content 正文，只留分页续读需要的元数据。 */
export function sanitizeTruncationDetails(details: unknown, offset = 1): unknown {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return details;
  const record = details as Record<string, unknown>;
  const truncation = record.truncation;
  if (!truncation || typeof truncation !== 'object' || Array.isArray(truncation)) return details;
  const raw = truncation as Record<string, unknown>;
  const shownLines = asPositiveInt(raw.outputLines);
  const remainingLines = asPositiveInt(raw.totalLines);
  const totalLines = fileTotalLines(remainingLines, offset);
  const truncated =
    raw.truncated === true ||
    (shownLines != null && remainingLines != null && shownLines < remainingLines);
  const start = startLine(offset);
  const nextOffset = truncated && shownLines != null ? start + shownLines : undefined;
  const bytesLimit =
    asPositiveInt(raw.maxBytes) ?? (truncated ? DEFAULT_READ_BYTES_LIMIT : undefined);
  const meta: Record<string, unknown> = {};
  if (truncated) meta.truncated = true;
  if (shownLines != null) meta.shownLines = shownLines;
  if (totalLines != null) meta.totalLines = totalLines;
  if (bytesLimit != null) meta.bytesLimit = bytesLimit;
  if (nextOffset != null) meta.nextOffset = nextOffset;
  return { ...record, truncation: meta };
}

export function withReadTruncationMeta<T extends { execute: (...args: never[]) => unknown }>(
  definition: T
): T {
  const execute = definition.execute as (
    toolCallId: string,
    params: unknown,
    ...rest: unknown[]
  ) => unknown;
  return {
    ...definition,
    execute: (async (toolCallId: string, params: unknown, ...rest: unknown[]) => {
      const result = await execute(toolCallId, params, ...rest);
      if (!result || typeof result !== 'object') return result;
      const offset = Number((params as { offset?: unknown } | undefined)?.offset ?? 1);
      const details = (result as { details?: unknown }).details;
      const next = sanitizeTruncationDetails(details, offset);
      const totalLines =
        next && typeof next === 'object' && !Array.isArray(next)
          ? asPositiveInt(
              (next as { truncation?: { totalLines?: unknown } }).truncation?.totalLines
            )
          : undefined;
      const content = (result as { content?: unknown }).content;
      const rewritten =
        typeof totalLines === 'number' && Array.isArray(content)
          ? content.map((part) => {
              if (!part || typeof part !== 'object') return part;
              const item = part as { type?: string; text?: string };
              if (item.type !== 'text' || typeof item.text !== 'string') return part;
              const text = rewriteShowingFooter(item.text, totalLines);
              return text === item.text ? part : { ...item, text };
            })
          : content;
      if (next === details && rewritten === content) return result;
      return {
        ...(result as object),
        ...(next === details ? {} : { details: next }),
        ...(rewritten === content ? {} : { content: rewritten }),
      };
    }) as T['execute'],
  };
}
