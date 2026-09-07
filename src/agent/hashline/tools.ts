import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { applyHashlineToFile } from './applyToFile';
import { classifyEditArgs } from './classify';
import { createHashlineEditTool } from './editTool';
import { formatHashlineHeader, formatNumberedLines } from './format';
import type { InMemorySnapshotStore } from './snapshots';
import { withHashlineGrep } from './withGrep';
import { withHashlineRead } from './withRead';

type NamedTool = { name: string; execute: (...args: never[]) => unknown };

/** 宽松对象：hashline `{input}` 与 replace `{path,edits}` 都能过 schema，分流放运行时 */
export const HASHLINE_EDIT_PARAMETERS = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      description:
        'Hashline patch: first line [path#TAG] from a prior read/grep, then PUT operations',
    },
    path: { type: 'string', description: 'File path for replace edits' },
    edits: {
      type: 'array',
      description: 'Replace edits as {oldText, newText} objects',
      items: {
        type: 'object',
        properties: {
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
      },
    },
    oldText: { type: 'string', description: 'Legacy single-replace old text' },
    newText: { type: 'string', description: 'Legacy single-replace new text' },
  },
} as unknown as ToolDefinition['parameters'];

export function selectHashlineTools<T extends NamedTool>(options: {
  enabled: boolean;
  store: InMemorySnapshotStore;
  read: T;
  grep: T;
  edit: T;
  readFileText?: (path: string) => Promise<string | undefined>;
  readText?: (path: string) => Promise<string>;
  writeText?: (path: string, text: string) => Promise<void>;
}): { read: T; grep: T; edit: T } {
  if (!options.enabled) {
    return { read: options.read, grep: options.grep, edit: options.edit };
  }
  const dual = createHashlineEditTool({
    applyReplace: (params) =>
      (options.edit.execute as (id: string, params: unknown) => unknown)('replace', params),
    applyHashline: async (params) => {
      const input = String((params as { input?: string } | undefined)?.input ?? '');
      return applyHashlineToFile({
        store: options.store,
        readText:
          options.readText ??
          (async () => {
            throw new Error('hashline readText not configured');
          }),
        writeText:
          options.writeText ??
          (async () => {
            throw new Error('hashline writeText not configured');
          }),
        input,
      });
    },
  });
  return {
    read: withHashlineRead(options.read, options.store),
    grep: options.readFileText
      ? withHashlineGrep(options.grep, options.store, options.readFileText)
      : options.grep,
    edit: { ...options.edit, execute: dual.execute as T['execute'] },
  };
}

export function wrapHashlineEditDefinition<T extends { execute: (...args: never[]) => unknown }>(
  stock: T,
  options: {
    store: InMemorySnapshotStore;
    readText: (path: string) => Promise<string>;
    writeText: (path: string, text: string) => Promise<void>;
  }
): T {
  const execute = stock.execute as (
    toolCallId: string,
    params: unknown,
    ...rest: unknown[]
  ) => unknown;
  const prepareStock = (stock as { prepareArguments?: (args: unknown) => unknown })
    .prepareArguments;
  return {
    ...stock,
    parameters: HASHLINE_EDIT_PARAMETERS,
    prepareArguments: (args: unknown) => {
      if (classifyEditArgs(args).kind === 'hashline') return args;
      return prepareStock ? prepareStock(args) : args;
    },
    execute: (async (toolCallId: string, params: unknown, ...rest: unknown[]) => {
      const kind = classifyEditArgs(params).kind;
      if (kind === 'replace') return execute(toolCallId, params, ...rest);
      if (kind === 'hashline') {
        const input = String((params as { input?: string } | undefined)?.input ?? '');
        const applied = await applyHashlineToFile({
          store: options.store,
          readText: options.readText,
          writeText: options.writeText,
          input,
        });
        return {
          content: [
            {
              type: 'text',
              text: `${formatHashlineHeader(applied.path, applied.tag)}\n${formatNumberedLines(applied.text)}`,
            },
          ],
          details: {
            oldText: applied.previous,
            diff: applied.text,
            patch: input,
          },
        };
      }
      if (kind === 'mixed') {
        throw new Error('edit accepts either hashline input or replace edits, not both');
      }
      throw new Error('edit requires hashline input or replace edits');
    }) as T['execute'],
  };
}
