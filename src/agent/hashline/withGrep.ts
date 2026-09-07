import { formatHashlineHeader } from './format';
import type { InMemorySnapshotStore } from './snapshots';

const HIT = /^(.+?):(\d+)(?::\d+)?:/;

function extractHitPaths(text: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of text.split('\n')) {
    const match = HIT.exec(line);
    if (!match) continue;
    const filePath = match[1]!;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
  }
  return paths;
}

function resultText(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') return undefined;
  return first.text;
}

export function withHashlineGrep<T extends { execute: (...args: never[]) => unknown }>(
  definition: T,
  store: InMemorySnapshotStore,
  readFileText: (path: string) => Promise<string | undefined>
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
      const text = resultText(result);
      if (text === undefined) return result;
      const trimmed = text.trim();
      if (!trimmed || /^no matches found$/i.test(trimmed)) return result;
      const headers: string[] = [];
      for (const filePath of extractHitPaths(text)) {
        const body = await readFileText(filePath);
        if (body === undefined) continue;
        const tag = store.record(filePath, body);
        headers.push(formatHashlineHeader(filePath, tag));
      }
      if (headers.length === 0) return result;
      return {
        ...(result as object),
        content: [{ type: 'text', text: `${headers.join('\n')}\n${text}` }],
      };
    }) as T['execute'],
  };
}
