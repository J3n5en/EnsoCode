import { describe, expect, it } from 'vitest';
import { agyCompactGuardExtension } from './compactGuard';

type Hook = (event: unknown, ctx: unknown) => Promise<unknown>;

function hook(): Hook {
  let handler: Hook | undefined;
  agyCompactGuardExtension.factory({
    on(name: string, fn: Hook) {
      if (name === 'session_before_compact') handler = fn;
    },
  } as never);
  if (!handler) throw new Error('no session_before_compact handler');
  return handler;
}

const event = {
  reason: 'manual',
  branchEntries: [{ type: 'message', message: { role: 'user', content: 'hi' } }],
  preparation: { tokensBefore: 100, firstKeptEntryId: 'keep' },
  signal: new AbortController().signal,
};
const ctx = (model: unknown) => ({
  model,
  sessionManager: { getBranch: () => [] },
  modelRegistry: {
    find: () => undefined,
    complete: async () => {
      throw new Error('must not call a model');
    },
  },
});

describe('agy compact guard', () => {
  it('leaves other models to pi native compaction', async () => {
    expect(await hook()(event, ctx({ provider: 'openai', api: 'openai-responses', id: 'x' }))).toBe(
      undefined
    );
  });

  it('cancels for agy when no local summary can be made, so native never runs', async () => {
    expect(
      await hook()(event, ctx({ provider: 'agy-cli', api: 'agy-acp', id: 'default' }))
    ).toEqual({ cancel: true });
  });
});
