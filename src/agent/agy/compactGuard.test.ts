import { describe, expect, it } from 'vitest';
import { recordCompactCancel, takeCompactCancel } from '../ensoCompact/cancel';
import { agyCompactGuardExtension, withAgyCompactGuard } from './compactGuard';

type Hook = (event: unknown, ctx: unknown) => Promise<unknown>;

function hook(extension = agyCompactGuardExtension, seen: string[] = []): Hook {
  let handler: Hook | undefined;
  extension.factory({
    on(name: string, fn: Hook) {
      seen.push(name);
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
const sessionManager = { getBranch: () => [] };
const ctx = (model: unknown) => ({
  model,
  sessionManager,
  modelRegistry: {
    find: () => undefined,
    complete: async () => {
      throw new Error('must not call a model');
    },
  },
});
const agy = { provider: 'agy-cli', api: 'agy-acp', id: 'default' };
const openai = { provider: 'openai', api: 'openai-responses', id: 'x' };

/** 一个 Enso 压缩扩展的替身：session_before_compact 给 `result`，另外注册一个别的事件 */
function enso(result: () => unknown) {
  return withAgyCompactGuard({
    name: 'enso-compact',
    hidden: true,
    factory: (pi) => {
      pi.on('agent_start', () => {});
      pi.on('session_before_compact', async () => result() as never);
    },
  });
}

describe('agy compact guard', () => {
  it('leaves other models to pi native compaction', async () => {
    expect(await hook()(event, ctx(openai))).toBe(undefined);
  });

  it('cancels for agy when no local summary can be made, so native never runs', async () => {
    expect(await hook()(event, ctx(agy))).toEqual({ cancel: true });
  });

  it('keeps what the wrapped Enso handler returns, and passes its other events through', async () => {
    const compaction = { compaction: { summary: 's', firstKeptEntryId: 'keep', tokensBefore: 1 } };
    const seen: string[] = [];
    expect(
      await hook(
        enso(() => compaction),
        seen
      )(event, ctx(agy))
    ).toBe(compaction);
    expect(seen).toEqual(['agent_start', 'session_before_compact']);
    expect(await hook(enso(() => ({ cancel: true })))(event, ctx(agy))).toEqual({ cancel: true });
  });

  it('falls back for agy when the Enso handler gives nothing or throws, never for other models', async () => {
    expect(await hook(enso(() => undefined))(event, ctx(agy))).toEqual({ cancel: true });
    const thrown = enso(() => {
      throw new Error('boom');
    });
    expect(await hook(thrown)(event, ctx(agy))).toEqual({ cancel: true });
    expect(await hook(enso(() => undefined))(event, ctx(openai))).toBe(undefined);
    await expect(hook(thrown)(event, ctx(openai))).rejects.toThrow('boom');
  });

  it('drops the cancel reason of an automatic compaction so it shows no error, keeps a manual one', async () => {
    const reason = {
      reason: 'uncompressible' as const,
      budget: 1,
      estimatedAfter: 2,
      tokensBefore: 3,
    };
    const cancelWithReason = enso(() => {
      recordCompactCancel(sessionManager, reason);
      return { cancel: true };
    });
    await hook(cancelWithReason)({ ...event, reason: 'overflow' }, ctx(agy));
    expect(takeCompactCancel(sessionManager)).toBeUndefined();
    await hook(cancelWithReason)(event, ctx(agy));
    expect(takeCompactCancel(sessionManager)).toEqual(reason);
  });
});
