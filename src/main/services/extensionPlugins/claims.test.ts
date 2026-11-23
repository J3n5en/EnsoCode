import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPluginHost } from '../../../pluginHost/host';
import { EventClaimStore, setEventClaimStore } from '../eventClaims';
import { ExtensionPluginService, type ExtensionPluginServiceOptions } from './service';

class InProcessChild extends EventEmitter {
  pid = 1;
  private handler: (message: unknown) => void = () => {};
  constructor() {
    super();
    runPluginHost({
      send: (message) => queueMicrotask(() => this.emit('message', message)),
      onMessage: (handler) => {
        this.handler = handler;
      },
    });
    queueMicrotask(() => this.emit('spawn'));
  }
  postMessage(message: unknown) {
    queueMicrotask(() => this.handler(message));
  }
  kill() {
    return true;
  }
}

const temps: string[] = [];
const services: ExtensionPluginService[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writePlugin(files: Record<string, string>): string {
  const dir = temp('claim-plugin-');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const manifest = () =>
  JSON.stringify({
    schemaVersion: 1,
    id: 'example.demo',
    name: 'Demo',
    version: '1.0.0',
    main: 'main.mjs',
    permissions: ['agent.inject'],
  });

afterEach(async () => {
  setEventClaimStore(null);
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createService(inject: ReturnType<typeof vi.fn>) {
  const store = new EventClaimStore({ now: () => 1_000, idleLeaseMs: 1_000 });
  setEventClaimStore(store);
  const root = temp('claim-root-');
  const options: ExtensionPluginServiceOptions = {
    root,
    hostVersion: '0.0.0',
    hostPath: '/unused',
    env: {},
    fork: () => new InProcessChild() as never,
    sessionBridge: () => ({
      inject: inject as never,
      abort: vi.fn(() => ({ ok: true as const })),
    }),
    gate: {
      fetch: vi.fn(),
      notify: () => true,
      composer: async () => null,
      mcpTools: async () => [],
      mcpCall: async () => ({ content: '', isError: false }),
      now: () => 1_000,
    },
  };
  const service = new ExtensionPluginService(options);
  services.push(service);
  return { service, store, root };
}

async function installed(inject: ReturnType<typeof vi.fn>) {
  const created = createService(inject);
  const preview = await created.service.stage({
    kind: 'dir',
    path: writePlugin({
      'enso-plugin.json': manifest(),
      'main.mjs': 'export function activate() {}',
    }),
  });
  if (!preview.ok) throw new Error(preview.error);
  const committed = await created.service.commit(preview.preview.token);
  if (!committed.ok) throw new Error(committed.error);
  await created.service.setEnabled('example.demo', true);
  created.service.setCrossSessionInject('example.demo', true);
  const invocation = (sessionId: string) =>
    created.service.gate.invocations.create({
      pluginId: 'example.demo',
      sessionId,
      projectRoot: created.root,
      gesture: false,
    });
  return { ...created, invocation };
}

describe('对象认领', () => {
  it('带 claimKey 的注入只投给认领者，失败新建会让出，旧插件仍返回 null', async () => {
    const inject = vi.fn((): { ok: true } | { ok: false; error: string } => ({ ok: true }));
    const { service, store, invocation } = await installed(inject);
    const key = 'github:acme/app#1:review';
    await expect(
      service.gate.handle(
        'example.demo',
        'session.inject',
        { text: 'hi', sessionId: 's1', claimKey: key, claimLabel: 'PR 审查' },
        invocation('s1')
      )
    ).resolves.toEqual({ delivered: true, ownerSessionId: 's1', status: 'claimed' });
    const skipped: unknown = await service.gate.handle(
      'example.demo',
      'session.inject',
      { text: 'hi', sessionId: 's2', claimKey: key },
      invocation('s2')
    );
    expect(JSON.stringify(skipped)).toBe(
      JSON.stringify({ delivered: false, ownerSessionId: 's1', status: 'held-by-other' })
    );
    expect(inject).toHaveBeenCalledTimes(1);

    await expect(
      service.gate.handle(
        'example.demo',
        'session.inject',
        { text: 'again', sessionId: 's1', claimKey: key },
        invocation('s1')
      )
    ).resolves.toMatchObject({ delivered: true, ownerSessionId: 's1', status: 'renewed' });

    inject.mockImplementationOnce(() => ({ ok: false, error: '会话不在运行' }));
    service.forgetSession('s1');
    await expect(
      service.gate.handle(
        'example.demo',
        'session.inject',
        { text: 'boom', sessionId: 's2', claimKey: key },
        invocation('s2')
      )
    ).rejects.toMatchObject({ code: 'INJECT_FAILED' });
    expect(store.ownerOf(key)).toBeNull();

    await expect(
      service.gate.handle('example.demo', 'session.inject', { text: 'plain' }, invocation('s1'))
    ).resolves.toBeNull();
    expect(inject).toHaveBeenCalledTimes(4);
  });

  it('claims.claim / renew / release / list 按持有者转移', async () => {
    const { service, invocation } = await installed(vi.fn(() => ({ ok: true as const })));
    const first = await service.gate.handle(
      'example.demo',
      'claims.claim',
      { key: 'tg:-100:1', label: '群' },
      invocation('s1')
    );
    expect(first).toMatchObject({ acquired: true, status: 'claimed', ownerSessionId: 's1' });
    const blocked = await service.gate.handle(
      'example.demo',
      'claims.claim',
      { key: 'tg:-100:1' },
      invocation('s2')
    );
    expect(blocked).toMatchObject({
      acquired: false,
      status: 'held-by-other',
      ownerSessionId: 's1',
    });
    expect(
      await service.gate.handle(
        'example.demo',
        'claims.renew',
        { key: 'tg:-100:1' },
        invocation('s2')
      )
    ).toBeNull();
    expect(
      await service.gate.handle(
        'example.demo',
        'claims.release',
        { key: 'tg:-100:1' },
        invocation('s2')
      )
    ).toBe(false);
    expect(
      await service.gate.handle(
        'example.demo',
        'claims.release',
        { key: 'tg:-100:1' },
        invocation('s1')
      )
    ).toBe(true);
    const taken = await service.gate.handle(
      'example.demo',
      'claims.claim',
      { key: 'tg:-100:1' },
      invocation('s2')
    );
    expect(taken).toMatchObject({ acquired: true, ownerSessionId: 's2' });
    const listed = await service.gate.handle(
      'example.demo',
      'claims.list',
      { prefix: 'tg:' },
      invocation('s1')
    );
    expect(listed).toEqual([expect.objectContaining({ key: 'tg:-100:1', sessionId: 's2' })]);
    await expect(
      service.gate.handle('example.demo', 'claims.claim', { key: '' }, invocation('s1'))
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('插件侧 enso.claims 会转发到宿主', async () => {
    const sent: { t?: string; api?: string; args?: unknown }[] = [];
    let handler: (message: unknown) => void = () => {};
    const dir = temp('claim-host-');
    writeFileSync(
      join(dir, 'main.mjs'),
      `export function activate(enso) {
        enso.claims.list({ prefix: 'github:' });
        enso.claims.claim({ key: 'github:a#1:review' });
        enso.claims.renew('github:a#1:review', 's1');
        enso.claims.release('github:a#1:review', 's1');
      }`
    );
    runPluginHost({
      send: (message) => sent.push(message as { t?: string; api?: string }),
      onMessage: (next) => {
        handler = next;
      },
    });
    handler({ t: 'init', pluginId: 'a.b', pluginRoot: dir, main: 'main.mjs', dataDir: dir });
    await vi.waitFor(() => {
      const calls = sent.filter((message) => message.t === 'call');
      expect(calls.map((message) => message.api)).toEqual([
        'claims.list',
        'claims.claim',
        'claims.renew',
        'claims.release',
      ]);
      expect(calls[2]?.args).toEqual({ key: 'github:a#1:review', sessionId: 's1' });
      expect(calls[3]?.args).toEqual({ key: 'github:a#1:review', sessionId: 's1' });
    });
  });
});
