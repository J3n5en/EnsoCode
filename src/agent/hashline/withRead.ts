import { parseAgentUri } from '../structuredYield';
import { formatHashlineHeader, formatNumberedLines } from './format';
import { HASHLINE_READ_GUIDELINES, withGuidelines } from './prompts';
import type { InMemorySnapshotStore } from './snapshots';

interface ContentPart {
  type?: string;
  text?: string;
}

function snapshotText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') return undefined;
    const item = part as ContentPart;
    if (item.type === 'image') return undefined;
    if (item.type !== 'text' || typeof item.text !== 'string') return undefined;
    texts.push(item.text);
  }
  return texts.join('');
}

export function withHashlineRead<T extends { execute: (...args: never[]) => unknown }>(
  definition: T,
  store: InMemorySnapshotStore
): T {
  const execute = definition.execute as (
    toolCallId: string,
    params: unknown,
    ...rest: unknown[]
  ) => unknown;
  return withGuidelines(
    {
      ...definition,
      execute: (async (toolCallId: string, params: unknown, ...rest: unknown[]) => {
        const result = await execute(toolCallId, params, ...rest);
        const filePath = String((params as { path?: string } | undefined)?.path ?? '');
        if (!filePath || parseAgentUri(filePath)) return result;
        if (!result || typeof result !== 'object') return result;
        const body = snapshotText((result as { content?: unknown }).content);
        if (body === undefined) return result;
        const tag = store.record(filePath, body);
        return {
          ...(result as object),
          content: [
            {
              type: 'text',
              text: `${formatHashlineHeader(filePath, tag)}\n${formatNumberedLines(body)}`,
            },
          ],
        };
      }) as T['execute'],
    },
    HASHLINE_READ_GUIDELINES
  );
}
