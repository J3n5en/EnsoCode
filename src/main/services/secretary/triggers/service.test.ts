import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { SecureCodec } from '../../secureFile';
import { formatSessionUpdates } from '../results';
import { SecretaryStore } from '../store';
import { TriggerManager } from './service';

const plainCodec: SecureCodec = {
  available: async () => false,
  encrypt: async (text) => Buffer.from(text, 'utf-8'),
  decrypt: async (data) => ({ text: data.toString('utf-8'), reEncrypt: false }),
};

function wsOnceMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      resolve(JSON.parse(data.toString('utf-8')) as Record<string, unknown>);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`ws closed early: ${code}`));
    };
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

describe('TriggerManager + local HTTP/WS server', () => {
  const dirs: string[] = [];
  const managers: TriggerManager[] = [];

  function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), 'enso-triggers-'));
    dirs.push(root);
    const secADir = join(root, 'sec-a');
    const secBDir = join(root, 'sec-b');
    const refs = [
      { id: 'default', dir: secADir },
      { id: 'sec-b', dir: secBDir },
    ];
    let nowValue = 1_700_000_000_000;
    const enqueued: { secretaryId: string; deliverAt?: number }[] = [];
    const onChanged = vi.fn();
    const manager = new TriggerManager({
      rootDir: () => root,
      enabled: () => true,
      secretaries: () => refs,
      secretary: (id) => refs.find((r) => r.id === id) ?? null,
      onEnqueued: (secretaryId, deliverAt) => enqueued.push({ secretaryId, deliverAt }),
      onChanged,
      now: () => nowValue,
      codec: plainCodec,
    });
    managers.push(manager);
    return {
      root,
      secADir,
      secBDir,
      manager,
      enqueued,
      onChanged,
      advance: (ms: number) => {
        nowValue += ms;
      },
    };
  }

  afterEach(async () => {
    while (managers.length > 0) {
      await managers.pop()?.stop();
    }
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts lazily only when an enabled trigger exists and stops when all disabled/removed', async () => {
    const { root, manager } = makeEnv();
    await manager.setPort(0);
    await manager.start();
    expect(manager.serverState().status).toBe('stopped');
    expect(existsSync(join(root, 'trigger-server.runtime.json'))).toBe(false);

    const created = await manager.create('default', { name: '微信售后群', enabled: true });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const state = manager.serverState();
    expect(state.status).toBe('listening');
    expect(state.port).toBeGreaterThan(0);
    expect(state.activeCount).toBe(1);
    const runtime = JSON.parse(
      readFileSync(join(root, 'trigger-server.runtime.json'), 'utf-8')
    ) as { port: number; host: string };
    expect(runtime.host).toBe('127.0.0.1');
    expect(runtime.port).toBe(state.port);

    // Disabling the only trigger stops the server
    const updated = await manager.update('default', created.trigger.id, { enabled: false });
    expect(updated.ok).toBe(true);
    expect(manager.serverState().status).toBe('stopped');
    expect(existsSync(join(root, 'trigger-server.runtime.json'))).toBe(false);
  });

  it('handles HTTP POST auth, Origin rejection, legacy JSON, dedup, coalescing, and formatting', async () => {
    const { secADir, manager, enqueued } = makeEnv();
    await manager.setPort(0);
    const created = await manager.create('default', {
      name: '微信售后群',
      instruction: '汇总客户问题并检查工单',
      coalesceMs: 3000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { trigger, token } = created;
    const base = `http://127.0.0.1:${manager.serverState().port}`;

    // Health check works without auth, rejects browser Origin
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(
      (await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.test' } })).status
    ).toBe(403);

    // Unauthorized & wrong Origin rejected
    expect((await fetch(trigger.httpUrl, { method: 'POST', body: 'hi' })).status).toBe(401);
    expect(
      (
        await fetch(trigger.httpUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.test' },
          body: 'hi',
        })
      ).status
    ).toBe(403);

    // Valid JSON event with eventId
    const res1 = await fetch(trigger.httpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventId: 'wx-1001',
        source: '参半群',
        text: '客户反馈快递破损，附 sk-1234567890abcdefghijklmnop',
      }),
    });
    expect(res1.status).toBe(202);
    expect(await res1.json()).toMatchObject({ ok: true, deduplicated: false });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.secretaryId).toBe('default');
    expect(enqueued[0]?.deliverAt).toBe(1_700_000_003_000);

    // Replaying same eventId is idempotently deduplicated
    const resDup = await fetch(trigger.httpUrl, {
      method: 'POST',
      headers: { 'X-Enso-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: 'wx-1001', text: 'duplicate' }),
    });
    expect(resDup.status).toBe(202);
    expect(await resDup.json()).toMatchObject({ ok: true, deduplicated: true });

    // Legacy arbitrary JSON without text field works too, aligned to same deliverAt
    const res2 = await fetch(trigger.httpUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: '亳州群', unread: 2 }),
    });
    expect(res2.status).toBe(202);
    expect(enqueued[1]?.deliverAt).toBe(1_700_000_003_000);

    // Inspect persisted outbox & formatted <secretary-trigger> block
    const dispatch = new SecretaryStore(secADir).dispatch();
    expect(dispatch.outbox).toHaveLength(2);
    const formatted = formatSessionUpdates(dispatch.outbox);
    expect(formatted).toContain('<secretary-trigger>');
    expect(formatted).toContain('name="微信售后群"');
    expect(formatted).toContain('Instruction: 汇总客户问题并检查工单');
    expect(formatted).toContain('<untrusted-content source="trigger:');
    expect(formatted).not.toContain('sk-1234567890abcdefghijklmnop');
  });

  it('supports WebSocket header auth, first-frame auth, ack, dedup, rotation, and multi-secretary routing', async () => {
    const { secADir, secBDir, manager, enqueued } = makeEnv();
    await manager.setPort(0);
    const createdA = await manager.create('default', { name: '瑞花入口', coalesceMs: 0 });
    const createdB = await manager.create('sec-b', { name: '祥子入口', coalesceMs: 0 });
    expect(createdA.ok && createdB.ok).toBe(true);
    if (!createdA.ok || !createdB.ok) return;

    // 1. WS with header auth on secretary A
    const wsA = new WebSocket(createdA.trigger.wsUrl, {
      headers: { Authorization: `Bearer ${createdA.token}` },
    });
    const readyA = await wsOnceMessage(wsA);
    expect(readyA).toEqual({ type: 'ready', triggerId: createdA.trigger.id });

    wsA.send(
      JSON.stringify({
        type: 'event',
        id: 'm1',
        eventId: 'ev-1',
        source: '参半群',
        text: '新售后工单',
      })
    );
    const ack1 = await wsOnceMessage(wsA);
    expect(ack1).toMatchObject({ type: 'ack', id: 'm1', ok: true, deduplicated: false });

    // Replaying same eventId returns deduplicated: true
    wsA.send(JSON.stringify({ type: 'event', id: 'm2', eventId: 'ev-1', text: '重发' }));
    const ack2 = await wsOnceMessage(wsA);
    expect(ack2).toMatchObject({ type: 'ack', id: 'm2', ok: true, deduplicated: true });
    wsA.close();

    // 2. WS with first-frame auth on secretary B
    const wsB = new WebSocket(createdB.trigger.wsUrl);
    await new Promise<void>((resolve, reject) => {
      wsB.once('open', () => resolve());
      wsB.once('error', reject);
    });
    wsB.send(JSON.stringify({ type: 'auth', token: createdB.token }));
    expect(await wsOnceMessage(wsB)).toEqual({ type: 'ready', triggerId: createdB.trigger.id });

    wsB.send(JSON.stringify({ type: 'ping', id: 7 }));
    expect(await wsOnceMessage(wsB)).toEqual({ type: 'pong', id: 7 });

    wsB.send(JSON.stringify({ type: 'event', id: 'b1', text: 'CI 失败了' }));
    expect(await wsOnceMessage(wsB)).toMatchObject({ type: 'ack', id: 'b1', ok: true });
    wsB.close();

    // Multi-secretary routing isolation
    expect(new SecretaryStore(secADir).dispatch().outbox).toHaveLength(1);
    expect(new SecretaryStore(secBDir).dispatch().outbox).toHaveLength(1);
    expect(enqueued.map((e) => e.secretaryId)).toEqual(['default', 'sec-b']);

    // Token rotation invalidates old token
    const rotated = await manager.rotateToken('default', createdA.trigger.id);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(
      (
        await fetch(createdA.trigger.httpUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${createdA.token}` },
          body: 'old',
        })
      ).status
    ).toBe(401);
    expect(
      (
        await fetch(createdA.trigger.httpUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${rotated.token}` },
          body: 'new',
        })
      ).status
    ).toBe(202);
  });

  it('enforces per-trigger sliding window rate limiting', async () => {
    const { manager } = makeEnv();
    await manager.setPort(0);
    const created = await manager.create('default', { name: '高频测试', coalesceMs: 0 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(created.trigger.httpUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.token}` },
        body: `msg-${i}`,
      });
      expect(res.status).toBe(202);
    }
    const blocked = await fetch(created.trigger.httpUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.token}` },
      body: 'msg-20',
    });
    expect(blocked.status).toBe(429);
  });
});
