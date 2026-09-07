import { applyHashlineToFile } from './applyToFile';
import { classifyEditArgs } from './classify';
import { createHashlineEditTool } from './editTool';
import { formatHashlineHeader, formatNumberedLines } from './format';
import type { InMemorySnapshotStore } from './snapshots';
import { withHashlineGrep } from './withGrep';
import { withHashlineRead } from './withRead';

type NamedTool = { name: string; execute: (...args: never[]) => unknown };

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
  return {
    ...stock,
    prepareArguments: (args: unknown) => args,
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
