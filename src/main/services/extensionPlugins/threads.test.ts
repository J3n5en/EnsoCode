import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { demandPrClaimKey } from '@shared/types/demandThreads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPluginHost } from '../../../pluginHost/host';
import { DemandThreadRouter, setDemandThreadRouter } from '../demandThreadRouter';
import { DemandThreadStore, setDemandThreadStore } from '../demandThreads';
import {
  EventClaimStore,
  setEventClaimStore,
  setPreferredClaimOwnerResolver,
} from '../eventClaims';
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
  const dir = temp('thread-plugin-');
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
  setDemandThreadStore(null);
  setDemandThreadRouter(null);
  setEventClaimStore(null);
  setPreferredClaimOwnerResolver(null);
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function installed(inject: ReturnType<typeof vi.fn>) {
  const root = temp('thread-root-');
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
  const preview = await service.stage({
    kind: 'dir',
    path: writePlugin({
      'enso-plugin.json': manifest(),
      'main.mjs': 'export function activate() {}',
    }),
  });
  if (!preview.ok) throw new Error(preview.error);
  const committed = await service.commit(preview.preview.token);
  if (!committed.ok) throw new Error(committed.error);
  await service.setEnabled('example.demo', true);
  service.setCrossSessionInject('example.demo', true);
  const invocation = (sessionId: string) =>
    service.gate.invocations.create({
      pluginId: 'example.demo',
      sessionId,
      projectRoot: root,
      gesture: false,
    });
  return { service, invocation, root };
}

async function enablePlugin(service: ExtensionPluginService, id: string): Promise<void> {
  const preview = await service.stage({
    kind: 'dir',
    path: writePlugin({
      'enso-plugin.json': JSON.stringify({
        schemaVersion: 1,
        id,
        name: id,
        version: '1.0.0',
        main: 'main.mjs',
        permissions: ['agent.inject'],
      }),
      'main.mjs': 'export function activate() {}',
    }),
  });
  if (!preview.ok) throw new Error(preview.error);
  const committed = await service.commit(preview.preview.token);
  if (!committed.ok) throw new Error(committed.error);
  await service.setEnabled(id, true);
}

describe('需求线程插件接口', () => {
  it('PR 事件只注入负责会话，里程碑回原消息，评论不回群', async () => {
    const inject = vi.fn((_sessionId: string) => ({ ok: true as const }));
    const { service, invocation } = await installed(inject);
    const threads = new DemandThreadStore({
      filePath: join(temp('threads-'), 'demand-threads.json'),
      now: () => 1_000,
      resolveIsOwner: (source) => source.senderId === 'owner-user',
    });
    setDemandThreadStore(threads);
    const replies: string[] = [];
    setDemandThreadRouter(
      new DemandThreadRouter({
        store: threads,
        injectToSession: async (input) => {
          const result = service.injectOwned(input);
          return {
            ok: result.ok,
            ...(result.ok && result.skipped ? { skipped: true } : {}),
            ...(!result.ok ? { error: result.error } : {}),
          };
        },
        replyToSource: async (input) => {
          replies.push(input.source.messageId);
          return { ok: true, messageId: '90' };
        },
      })
    );
    setEventClaimStore(
      new EventClaimStore({
        now: () => 1_000,
        resolvePreferredOwner: (key) => threads.resolveOwnerForClaimKey(key),
      })
    );

    const call = (
      api: 'threads.open' | 'threads.bindPr' | 'threads.routePrEvent' | 'threads.list',
      args: Record<string, unknown>
    ) => service.gate.handle('example.demo', api, args, invocation('plugin-session'));

    await expect(
      call('threads.open', {
        source: {
          channel: 'telegram',
          chatId: '-100',
          messageId: '42',
          senderId: 'owner-user',
        },
        sessionId: 'owner',
      })
    ).resolves.toMatchObject({
      sessionId: 'owner',
      requesterIsOwner: true,
      source: { messageId: '42' },
    });

    await call('threads.bindPr', { sessionId: 'owner', pr: { repo: 'Enso/App', number: 3 } });

    const hijack = await service.gate.handle(
      'example.demo',
      'session.inject',
      { text: '抢走', sessionId: 'other', claimKey: demandPrClaimKey('Enso/App', 3, 'comment') },
      invocation('other')
    );
    expect(hijack).toMatchObject({
      delivered: false,
      ownerSessionId: 'owner',
      status: 'held-by-other',
    });
    expect(inject).not.toHaveBeenCalled();

    const comment = await call('threads.routePrEvent', {
      repo: 'Enso/App',
      number: 3,
      kind: 'comment',
      text: '看看',
    });
    expect(comment).toMatchObject({
      routed: true,
      sessionId: 'owner',
      delivered: true,
      milestonePushed: false,
    });
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toBe('owner');
    expect(replies).toEqual([]);

    const opened = await call('threads.routePrEvent', {
      repo: 'Enso/App',
      number: 3,
      kind: 'pr_opened',
      text: '开了',
      url: 'https://example.test/3',
    });
    expect(opened).toMatchObject({
      milestonePushed: true,
      milestoneKind: 'pr_opened',
      replyMessageId: '90',
    });
    expect(replies).toEqual(['42']);

    await call('threads.routePrEvent', {
      repo: 'Enso/App',
      number: 3,
      kind: 'comment',
      text: '再看',
    });
    expect(replies).toEqual(['42']);
    expect(inject.mock.calls.every((call) => call[0] === 'owner')).toBe(true);

    const listed = await call('threads.list', { repo: 'Enso/App' });
    expect(listed).toEqual([expect.objectContaining({ sessionId: 'owner', status: 'pr_opened' })]);

    await expect(
      call('threads.routePrEvent', { repo: 'Enso/App', number: 3, kind: 'nope', text: 'x' })
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('未开启跨会话时不能把线程开到或绑到别的会话', async () => {
    const { service, invocation } = await installed(vi.fn(() => ({ ok: true as const })));
    const threads = new DemandThreadStore({
      filePath: join(temp('threads-'), 'demand-threads.json'),
      now: () => 1_000,
    });
    setDemandThreadStore(threads);
    service.setCrossSessionInject('example.demo', false);
    const source = {
      channel: 'telegram',
      chatId: '-100',
      messageId: '7',
      senderId: 'owner-user',
    };
    const call = (api: 'threads.open' | 'threads.bindPr', args: Record<string, unknown>) =>
      service.gate.handle('example.demo', api, args, invocation('plugin-session'));

    await expect(call('threads.open', { source, sessionId: 'other' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(
      call('threads.open', { source, sessionId: 'plugin-session' })
    ).resolves.toMatchObject({ sessionId: 'plugin-session', pluginId: 'example.demo' });
    const ownId = threads.findBySource('telegram', '-100', '7')?.id;
    await expect(
      call('threads.bindPr', { threadId: ownId, pr: { repo: 'Enso/App', number: 1 } })
    ).resolves.toMatchObject({ id: ownId, status: 'pr_opened' });

    service.setCrossSessionInject('example.demo', true);
    await call('threads.open', {
      source: { ...source, messageId: '8' },
      sessionId: 'other',
    });
    service.setCrossSessionInject('example.demo', false);
    const foreignId = threads.findBySource('telegram', '-100', '8')?.id;
    await expect(
      call('threads.bindPr', { threadId: foreignId, pr: { repo: 'Enso/App', number: 2 } })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(threads.findById(foreignId ?? '')?.pr).toBeUndefined();
  });

  it('别的插件不能用 threads.open 劫持已有线程', async () => {
    const { service, invocation, root } = await installed(vi.fn(() => ({ ok: true as const })));
    const threads = new DemandThreadStore({
      filePath: join(temp('threads-'), 'demand-threads.json'),
      now: () => 1_000,
    });
    setDemandThreadStore(threads);
    const source = {
      channel: 'telegram',
      chatId: '-100',
      messageId: '42',
      senderId: 'owner-user',
    };
    await service.gate.handle(
      'example.demo',
      'threads.open',
      { source, sessionId: 'plugin-session' },
      invocation('plugin-session')
    );
    await enablePlugin(service, 'example.other');
    service.setCrossSessionInject('example.other', true);
    const otherInvocation = service.gate.invocations.create({
      pluginId: 'example.other',
      sessionId: 'plugin-session',
      projectRoot: root,
      gesture: false,
    });
    await expect(
      service.gate.handle(
        'example.other',
        'threads.open',
        { source, sessionId: 'stolen' },
        otherInvocation
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(threads.findBySource('telegram', '-100', '42')).toMatchObject({
      sessionId: 'plugin-session',
      pluginId: 'example.demo',
    });
  });
});
