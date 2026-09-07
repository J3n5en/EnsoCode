import { parseAgentUri } from '../structuredYield';
import { formatHashlineHeader, formatNumberedLines } from './format';
import { HASHLINE_WRITE_GUIDELINES, withGuidelines } from './prompts';
import type { InMemorySnapshotStore } from './snapshots';

export function withHashlineWrite<T extends { execute: (...args: never[]) => unknown }>(
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
        if (!result || typeof result !== 'object' || (result as { isError?: boolean }).isError) {
          return result;
        }
        const record =
          params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
        const filePath = typeof record.path === 'string' ? record.path : '';
        const body = typeof record.content === 'string' ? record.content : undefined;
        if (!filePath || body === undefined || parseAgentUri(filePath)) return result;
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
    HASHLINE_WRITE_GUIDELINES
  );
}
