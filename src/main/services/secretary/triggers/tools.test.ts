import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SecureCodec } from '../../secureFile';
import { TriggerManager } from './service';
import { createSecretaryTriggerHandlers } from './tools';

const plainCodec: SecureCodec = {
  available: async () => false,
  encrypt: async (text) => Buffer.from(text, 'utf-8'),
  decrypt: async (data) => ({ text: data.toString('utf-8'), reEncrypt: false }),
};

describe('secretary trigger_* tool handlers', () => {
  const dirs: string[] = [];
  const managers: TriggerManager[] = [];

  function setup(restricted = false) {
    const root = mkdtempSync(join(tmpdir(), 'enso-sec-trg-tools-'));
    dirs.push(root);
    const dir = join(root, 'sec');
    const ctx = { id: 'default', dir, projectId: 'proj-sec' };
    const manager = new TriggerManager({
      rootDir: () => root,
      enabled: () => true,
      secretaries: () => [{ id: 'default', dir }],
      secretary: (id) => (id === 'default' ? { id: 'default', dir } : null),
      onEnqueued: () => {},
      onChanged: () => {},
      codec: plainCodec,
    });
    managers.push(manager);
    const handlers = createSecretaryTriggerHandlers(ctx, {
      restricted,
      manager: () => manager,
    });
    return {
      manager,
      handlers,
      opCtx: { secretaryConversationId: 'conv-1', secretaryId: 'default' },
    };
  }

  afterEach(async () => {
    while (managers.length > 0) await managers.pop()?.stop();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates, lists without leaking token, updates, rotates, tests, and removes triggers', async () => {
    const { manager, handlers, opCtx } = setup(false);
    await manager.setPort(0);

    const created = await handlers.trigger_create(
      { name: '微信售后群', instruction: '汇总异常', coalesceMs: 2000 },
      opCtx
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const payload = created.result as {
      trigger: { id: string; httpUrl: string; wsUrl: string };
      token: string;
      usage: { httpPost: string; wsUrl: string };
    };
    expect(payload.token).toHaveLength(64);
    expect(payload.usage.httpPost).toContain(payload.trigger.httpUrl);
    expect(payload.usage.wsUrl).toBe(payload.trigger.wsUrl);

    const listed = await handlers.trigger_list({}, opCtx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(JSON.stringify(listed.result)).not.toContain(payload.token);

    const updated = await handlers.trigger_update(
      { triggerId: payload.trigger.id, instruction: '', coalesceMs: 0 },
      opCtx
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(
        (updated.result as { trigger: { instruction?: string; coalesceMs: number } }).trigger
      ).toMatchObject({
        coalesceMs: 0,
      });
      expect(
        (updated.result as { trigger: { instruction?: string } }).trigger.instruction
      ).toBeUndefined();
    }

    const rotated = await handlers.trigger_rotate_token({ triggerId: payload.trigger.id }, opCtx);
    expect(rotated.ok).toBe(true);
    if (rotated.ok) {
      expect((rotated.result as { token: string }).token).not.toBe(payload.token);
    }

    const tested = await handlers.trigger_test(
      { triggerId: payload.trigger.id, text: 'ping' },
      opCtx
    );
    expect(tested.ok).toBe(true);

    const removed = await handlers.trigger_remove({ triggerId: payload.trigger.id }, opCtx);
    expect(removed.ok).toBe(true);
  });

  it('blocks all trigger write operations in downgraded colleague turns while keeping trigger_list', async () => {
    const { handlers, opCtx } = setup(true);
    expect((await handlers.trigger_list({}, opCtx)).ok).toBe(true);
    expect((await handlers.trigger_create({ name: 'hack' }, opCtx)).ok).toBe(false);
    expect(
      (await handlers.trigger_update({ triggerId: 'trg-123456', enabled: false }, opCtx)).ok
    ).toBe(false);
    expect((await handlers.trigger_remove({ triggerId: 'trg-123456' }, opCtx)).ok).toBe(false);
    expect((await handlers.trigger_rotate_token({ triggerId: 'trg-123456' }, opCtx)).ok).toBe(
      false
    );
    expect((await handlers.trigger_test({ triggerId: 'trg-123456' }, opCtx)).ok).toBe(false);
  });
});
