import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPluginHost } from '../../../pluginHost/host';
import type { WorkerForkOptions } from '../../platform/types';
import { pluginDataPath } from './install';
import { ExtensionPluginService } from './service';

class InProcessChild extends EventEmitter {
  pid = 1;
  private handler: (m: unknown) => void = () => {};
  constructor() {
    super();
    runPluginHost({
      send: (m) => queueMicrotask(() => this.emit('message', m)),
      onMessage: (h) => (this.handler = h),
    });
    queueMicrotask(() => this.emit('spawn'));
  }
  postMessage(m: unknown) {
    queueMicrotask(() => {
      this.handler(m);
      if (typeof m === 'object' && m !== null && (m as { t?: string }).t === 'shutdown')
        this.emit('exit', 0);
    });
  }
  kill() {
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  vi.useRealTimers();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writePlugin(files: Record<string, string>) {
  const dir = temp('plugin-src-');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const manifest = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    id: 'example.demo',
    name: 'Demo',
    version: '1.0.0',
    main: 'main.mjs',
    permissions: ['agent.tool'],
    contributes: {
      agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
    },
    ...patch,
  });

function createService(
  fork: (modulePath: string, args: string[], options: WorkerForkOptions) => EventEmitter = () =>
    new InProcessChild(),
  extra: { env?: NodeJS.ProcessEnv; sourceEnv?: NodeJS.ProcessEnv } = {}
) {
  const root = temp('plugins-root-');
  const bridge = vi.fn(() => ({ ok: true as const }));
  const service = new ExtensionPluginService({
    root,
    hostVersion: '0.2.12',
    hostPath: '/unused',
    env: extra.env ?? { PATH: '/bin' },
    sourceEnv: extra.sourceEnv,
    sessionBridge: () => ({ inject: bridge }),
    fork: fork as never,
    gate: {
      fetch: vi.fn(),
      notify: () => true,
      composer: async () => null,
      mcpTools: async () => [],
      mcpCall: async () => ({ content: '', isError: false }),
      now: () => Date.now(),
      clipboard: vi.fn(),
      openExternal: vi.fn(async () => undefined),
    },
  });
  return { root, service, bridge };
}

async function install(service: ExtensionPluginService, files: Record<string, string>) {
  const preview = await service.stage({ kind: 'dir', path: writePlugin(files) });
  if (!preview.ok) throw new Error(preview.error);
  const committed = await service.commit(preview.preview.token);
  if (!committed.ok) throw new Error(committed.error);
  return preview.preview;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('插件能力', () => {
  it('未声明的事件收不到，停用后也不再收到', async () => {
    let forks = 0;
    const { service } = createService(() => {
      forks += 1;
      return new InProcessChild();
    });
    await install(service, {
      'enso-plugin.json': manifest({
        permissions: ['agent.tool', 'agent.observe'],
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          events: [{ event: 'session_start', mode: 'observe' }],
        },
      }),
      'main.mjs': `let n = 0;
        export function activate(enso) {
          enso.events.on('session_start', () => { n += 1; });
          enso.tools.register('lookup', async () => String(n));
        }`,
    });
    service.setEnabled('example.demo', true);
    await service.dispatchEvent({
      sessionId: 's',
      projectRoot: null,
      event: 'session_end',
      data: {},
    });
    await service.dispatchEvent({
      sessionId: 's',
      projectRoot: null,
      event: 'session_start',
      data: { reason: 'startup' },
    });
    await flush();
    const read = () =>
      service.callTool({
        toolName: 'plugin_example-demo__lookup',
        args: {},
        sessionId: 's',
        projectRoot: null,
      });
    expect((await read()).content).toBe('1');
    const forksAfter = forks;
    service.setEnabled('example.demo', false);
    await service.dispatchEvent({
      sessionId: 's',
      projectRoot: null,
      event: 'session_start',
      data: {},
    });
    await flush();
    expect(forks).toBe(forksAfter);
    expect(service.list()[0]?.running).toBe(false);
    await expect(
      service.dispatchEvent({
        sessionId: 's',
        projectRoot: null,
        event: 'before_compact',
        data: { reason: 'overflow' },
      })
    ).resolves.toBeUndefined();
  });

  it('拦截按 id 合并，失败按 failClosed 决定拒绝或放行', async () => {
    const { service } = createService();
    const files = (id: string, fail: boolean, body: string) => ({
      'enso-plugin.json': manifest({
        id,
        name: id,
        permissions: ['agent.intercept'],
        contributes: {
          events: [{ event: 'tool_call', mode: 'intercept', failClosed: fail }],
        },
      }),
      'main.mjs': body,
    });
    await install(
      service,
      files(
        'a.a',
        false,
        `export function activate(enso) { enso.events.on('tool_call', (data) => ({ input: { ...data.input, a: 1 } })); }`
      )
    );
    await install(
      service,
      files(
        'a.b',
        true,
        `export function activate(enso) { enso.events.on('tool_call', (data) => ({ input: { ...data.input, b: 1 } })); }`
      )
    );
    service.setEnabled('a.b', true);
    service.setEnabled('a.a', true);
    await expect(
      service.intercept({
        sessionId: 's',
        projectRoot: null,
        event: 'tool_call',
        payload: { toolCallId: '1', toolName: 'bash', input: {} },
      })
    ).resolves.toEqual({ input: { a: 1, b: 1 } });
    service.setEnabled('a.a', false);
    await install(service, {
      'enso-plugin.json': manifest({
        id: 'a.c',
        permissions: ['agent.intercept'],
        contributes: {
          events: [{ event: 'tool_call', mode: 'intercept', failClosed: true }],
        },
      }),
      'main.mjs': `export function activate(enso) { enso.events.on('tool_call', () => { throw new Error('down'); }); }`,
    });
    service.setEnabled('a.c', true);
    const blocked = await service.intercept({
      sessionId: 's',
      projectRoot: null,
      event: 'tool_call',
      payload: { toolCallId: '1', toolName: 'bash', input: {} },
    });
    expect(blocked).toMatchObject({ block: true });
    service.setEnabled('a.c', false);
    await install(service, {
      'enso-plugin.json': manifest({
        id: 'a.d',
        permissions: ['agent.intercept'],
        contributes: {
          events: [{ event: 'tool_call', mode: 'intercept', failClosed: false }],
        },
      }),
      'main.mjs': `export function activate(enso) { enso.events.on('tool_call', () => { throw new Error('skip'); }); }`,
    });
    service.setEnabled('a.d', true);
    await expect(
      service.intercept({
        sessionId: 's',
        projectRoot: null,
        event: 'tool_call',
        payload: { toolCallId: '1', toolName: 'bash', input: { n: 1 } },
      })
    ).resolves.toEqual({ input: { n: 1, b: 1 } });
  });

  it('拦截总时长有上限：超时的按失败处理，来不及询问的 failClosed 插件拒绝', async () => {
    const { service } = createService();
    const slow = (id: string, failClosed: boolean) => ({
      'enso-plugin.json': manifest({
        id,
        name: id,
        permissions: ['agent.intercept'],
        contributes: { events: [{ event: 'tool_call', mode: 'intercept', failClosed }] },
      }),
      'main.mjs': `export function activate(enso) {
        enso.events.on('tool_call', async (data) => {
          await new Promise((r) => setTimeout(r, 60));
          return { input: { ...data.input, ${JSON.stringify(id)}: 1 } };
        });
      }`,
    });
    const ask = () =>
      service.intercept({
        sessionId: 's',
        projectRoot: null,
        event: 'tool_call',
        payload: { toolCallId: '1', toolName: 'bash', input: {} },
        deadlineMs: 100,
      });
    for (const id of ['t.a', 't.b']) {
      await install(service, slow(id, false));
      service.setEnabled(id, true);
    }
    await ask();
    expect(await ask()).toEqual({ input: { 't.a': 1 } });
    await install(service, slow('t.c', true));
    service.setEnabled('t.c', true);
    await ask();
    expect(await ask()).toMatchObject({ block: true });
  });

  it('failClosed 拦截连续失败 3 次熔断：30 秒内放行且不再询问，到期后试探成功即恢复', async () => {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { service, root } = createService();
      const flag = join(root, 'healthy');
      await install(service, {
        'enso-plugin.json': manifest({
          id: 'c.guard',
          name: 'Guard',
          permissions: ['agent.intercept'],
          contributes: { events: [{ event: 'tool_call', mode: 'intercept', failClosed: true }] },
        }),
        'main.mjs': `import { existsSync, appendFileSync } from 'node:fs';
          export function activate(enso) {
            enso.events.on('tool_call', () => {
              appendFileSync(${JSON.stringify(join(root, 'calls'))}, 'x');
              if (!existsSync(${JSON.stringify(flag)})) throw new Error('down');
              return {};
            });
          }`,
      });
      service.setEnabled('c.guard', true);
      const calls = () => {
        try {
          return readFileSync(join(root, 'calls'), 'utf8').length;
        } catch {
          return 0;
        }
      };
      const ask = () =>
        service.intercept({
          sessionId: 's',
          projectRoot: null,
          event: 'tool_call',
          payload: { toolCallId: '1', toolName: 'bash', input: { n: 1 } },
        });
      for (let i = 0; i < 3; i++) expect(await ask()).toMatchObject({ block: true });
      expect(calls()).toBe(3);
      expect(service.list()[0]?.interceptBreakers).toEqual([
        { event: 'tool_call', until: now + 30_000 },
      ]);
      expect(await ask()).toEqual({});
      expect(calls()).toBe(3);
      expect(service.logs('c.guard')).toContain('已临时放行');
      now += 30_001;
      writeFileSync(flag, '');
      expect(await ask()).toEqual({});
      expect(calls()).toBe(4);
      expect(service.list()[0]?.interceptBreakers).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('停用再启用或更新版本后熔断立即解除，不必等到期', async () => {
    const { service } = createService();
    const guard = (version: string, body: string) => ({
      'enso-plugin.json': manifest({
        id: 'c.guard',
        name: 'Guard',
        version,
        permissions: ['agent.intercept'],
        contributes: { events: [{ event: 'tool_call', mode: 'intercept', failClosed: true }] },
      }),
      'main.mjs': `export function activate(enso) { enso.events.on('tool_call', ${body}); }`,
    });
    await install(service, guard('1.0.0', `() => { throw new Error('down'); }`));
    service.setEnabled('c.guard', true);
    const ask = () =>
      service.intercept({
        sessionId: 's',
        projectRoot: null,
        event: 'tool_call',
        payload: { toolCallId: '1', toolName: 'bash', input: {} },
      });
    const trip = async () => {
      for (let i = 0; i < 3; i++) await ask();
      expect(service.list()[0]?.interceptBreakers).toHaveLength(1);
    };
    await trip();
    service.setEnabled('c.guard', false);
    service.setEnabled('c.guard', true);
    expect(service.list()[0]?.interceptBreakers).toBeUndefined();
    expect(await ask()).toMatchObject({ block: true });
    await trip();
    await install(service, guard('1.0.1', `() => ({ block: true, reason: 'fixed' })`));
    expect(service.list()[0]?.interceptBreakers).toBeUndefined();
    expect(await ask()).toEqual({ block: true, reason: 'fixed' });
  });

  it('熔断到期后试探仍失败则立即重新熔断', async () => {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { service } = createService();
      await install(service, {
        'enso-plugin.json': manifest({
          id: 'c.guard',
          name: 'Guard',
          permissions: ['agent.intercept'],
          contributes: { events: [{ event: 'input', mode: 'intercept', failClosed: true }] },
        }),
        'main.mjs': `export function activate(enso) { enso.events.on('input', () => { throw new Error('down'); }); }`,
      });
      service.setEnabled('c.guard', true);
      const ask = () =>
        service.intercept({
          sessionId: 's',
          projectRoot: null,
          event: 'input',
          payload: { text: 'hi', source: 'interactive' },
        });
      for (let i = 0; i < 3; i++) await ask();
      now += 30_001;
      expect(await ask()).toEqual({ action: 'handled' });
      expect(service.list()[0]?.interceptBreakers).toEqual([
        { event: 'input', until: now + 30_000 },
      ]);
      expect(await ask()).toEqual({ action: 'continue' });
    } finally {
      spy.mockRestore();
    }
  });

  it('工具超时取声明值，进度节流，产出可列出、拒绝路径并随卸载删除', async () => {
    const { service, root } = createService();
    await install(service, {
      'enso-plugin.json': manifest({
        contributes: {
          agentTools: [
            {
              name: 'lookup',
              description: '查询',
              parameters: { type: 'object' },
              timeoutMs: 1000,
            },
          ],
        },
      }),
      'main.mjs': `export function activate(enso) {
        enso.tools.register('lookup', async (args, ctx) => {
          if (args.hang) return new Promise(() => {});
          await ctx.progress('a');
          await ctx.progress('b'.repeat(20_000));
          if (args.bad) {
            try { await enso.artifacts.write({ name: '../x', text: 'no' }); return 'wrote'; }
            catch (e) { return e.message; }
          }
          const file = await enso.artifacts.write({ name: 'note.txt', text: 'hi' });
          return file.name;
        });
      }`,
    });
    service.setEnabled('example.demo', true);
    const progress: string[] = [];
    const result = await service.callTool({
      toolName: 'plugin_example-demo__lookup',
      args: {},
      sessionId: 's',
      projectRoot: null,
      onProgress: (text) => progress.push(text),
    });
    expect(progress).toEqual(['a']);
    expect(result.artifacts[0]).toMatchObject({
      name: 'note.txt',
      mime: 'text/plain; charset=utf-8',
    });
    expect(service.listArtifacts('example.demo')).toHaveLength(1);
    const path = service.artifactPath(result.artifacts[0]?.id ?? '');
    expect(path && readFileSync(path, 'utf8')).toBe('hi');
    expect(
      (
        await service.callTool({
          toolName: 'plugin_example-demo__lookup',
          args: { bad: true },
          sessionId: 's',
          projectRoot: null,
        })
      ).content
    ).toContain('路径');
    const hanging = service.callTool({
      toolName: 'plugin_example-demo__lookup',
      args: { hang: true },
      sessionId: 's',
      projectRoot: null,
    });
    await expect(hanging).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(service.deleteArtifact(result.artifacts[0]?.id ?? '')).toBe(true);
    await service.uninstall('example.demo');
    expect(existsSync(join(root, 'artifacts', 'example.demo'))).toBe(false);
  }, 8_000);

  it('配置按类型校验并补默认值；动态工具在拉起后进入下发列表', async () => {
    const { service } = createService();
    await install(service, {
      'enso-plugin.json': manifest({
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          dynamic: { tools: 1, commands: 1 },
          configuration: [
            { key: 'limit', title: '上限', type: 'number', default: 3, min: 1, max: 9 },
          ],
        },
      }),
      'main.mjs': `export async function activate(enso) {
        await enso.tools.register('extra', async () => 'dyn', {
          description: 'extra',
          parameters: { type: 'object' },
          timeoutMs: 1500,
        });
        await enso.commands.register('ping', async () => {}, { title: 'Ping' });
        enso.tools.register('lookup', async () => JSON.stringify(await enso.config.get()));
      }`,
    });
    expect(service.setConfig('example.demo', { limit: 'nope' }).ok).toBe(false);
    expect(service.setConfig('example.demo', { limit: 4 }).ok).toBe(true);
    service.setEnabled('example.demo', true);
    expect(service.toolsForSpawn().map((tool) => tool.name)).toEqual([
      'plugin_example-demo__lookup',
    ]);
    await service.prepareForSpawn();
    expect(service.toolsForSpawn()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'plugin_example-demo__extra', timeoutMs: 1500 }),
      ])
    );
    expect(
      JSON.parse(
        (
          await service.callTool({
            toolName: 'plugin_example-demo__lookup',
            args: {},
            sessionId: 's',
            projectRoot: null,
          })
        ).content
      )
    ).toEqual({ limit: 4 });
    service.setConfig('example.demo', { limit: null });
    expect(
      JSON.parse(
        (
          await service.callTool({
            toolName: 'plugin_example-demo__extra',
            args: {},
            sessionId: 's',
            projectRoot: null,
          })
        ).content === 'dyn'
          ? '{"ok":true}'
          : '{}'
      ).ok
    ).toBe(true);
    const again = JSON.parse(
      (
        await service.callTool({
          toolName: 'plugin_example-demo__lookup',
          args: {},
          sessionId: 's',
          projectRoot: null,
        })
      ).content
    );
    expect(again.limit).toBe(3);
    await expect(
      service.callUi({
        pluginId: 'example.demo',
        method: 'command.run',
        payload: { id: 'ping' },
        sessionId: null,
        projectRoot: null,
      })
    ).resolves.toBeNull();
    service.setEnabled('example.demo', false);
    service.setEnabled('example.demo', true);
    expect(service.toolsForSpawn().some((tool) => tool.name.endsWith('extra'))).toBe(false);
    expect(service.viewStateSet('example.demo', { a: '1' })).toEqual({ ok: true });
    expect(service.viewStateGet('example.demo')).toEqual({ a: '1' });
    expect(service.viewStateSet('example.demo', { b: 'x'.repeat(1_100_000) }).ok).toBe(false);
    expect(service.viewStateGet('example.demo')).toEqual({ a: '1' });
  });

  it('插件间调用受清单和深度限制，环境变量只透传声明项', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const { service } = createService(
      (_m, _a, options) => {
        envs.push({ ...options.env });
        return new InProcessChild();
      },
      { sourceEnv: { MY_TOKEN: 's3', OTHER: 'no' } }
    );
    const hop = (id: string, next: string | null, permissions: string[], interop: string[]) => ({
      'enso-plugin.json': manifest({
        id,
        name: id,
        permissions,
        env: id === 'a.a' ? ['MY_TOKEN'] : [],
        interop: { call: interop },
        contributes: {
          ...(id === 'a.a'
            ? {
                agentTools: [
                  { name: 'lookup', description: '查询', parameters: { type: 'object' } },
                ],
              }
            : {}),
          exports: [{ name: 'hop' }],
        },
      }),
      'main.mjs': `export function activate(enso) {
        ${id === 'a.a' ? `enso.tools.register('lookup', async () => enso.plugins.call('a.b', 'hop', {}));` : ''}
        enso.exports.handle('hop', async () => {
          ${next ? `return enso.plugins.call('${next}', 'hop', {});` : `try { await enso.plugins.call('a.e', 'hop', {}); return 'called'; } catch (e) { return e.message; }`}
        });
      }`,
    });
    await install(service, hop('a.a', 'a.b', ['agent.tool', 'plugin.call'], ['a.b']));
    await install(service, hop('a.b', 'a.c', ['plugin.call'], ['a.c']));
    await install(service, hop('a.c', 'a.d', ['plugin.call'], ['a.d']));
    await install(service, hop('a.d', null, ['plugin.call'], ['a.e']));
    for (const id of ['a.a', 'a.b', 'a.c', 'a.d']) service.setEnabled(id, true);
    expect(
      (
        await service.callTool({
          toolName: 'plugin_a-a__lookup',
          args: {},
          sessionId: 's',
          projectRoot: null,
        })
      ).content
    ).toContain('嵌套');
    expect(envs.some((item) => item.MY_TOKEN === 's3' && item.PATH === '/bin')).toBe(true);
    expect(envs.every((item) => item.OTHER === undefined)).toBe(true);
  });

  it('被调方从 ctx.caller 知道谁在调用', async () => {
    const { service } = createService();
    await install(service, {
      'enso-plugin.json': manifest({
        id: 'b.callee',
        name: 'callee',
        permissions: [],
        contributes: { exports: [{ name: 'who' }] },
      }),
      'main.mjs': `export function activate(enso) { enso.exports.handle('who', async (_a, ctx) => ctx.caller); }`,
    });
    await install(service, {
      'enso-plugin.json': manifest({
        id: 'b.caller',
        name: 'caller',
        permissions: ['agent.tool', 'plugin.call'],
        interop: { call: ['b.callee'] },
      }),
      'main.mjs': `export function activate(enso) { enso.tools.register('lookup', () => enso.plugins.call('b.callee', 'who')); }`,
    });
    service.setEnabled('b.callee', true);
    service.setEnabled('b.caller', true);
    const result = await service.callTool({
      toolName: 'plugin_b-caller__lookup',
      args: {},
      sessionId: 's',
      projectRoot: null,
    });
    expect(result.content).toBe('b.caller');
  });

  it('注入默认只到当前会话，跨会话要单独开关，且有频率上限', async () => {
    const { service, bridge, root } = createService();
    await install(service, {
      'enso-plugin.json': manifest({ permissions: ['agent.tool', 'agent.inject'] }),
      'main.mjs': `export function activate(enso) {
        enso.tools.register('lookup', async (args) => {
          try {
            await enso.session.inject({ text: 'hi', ...(args.to ? { sessionId: args.to } : {}) });
            return 'ok';
          } catch (e) { return e.code; }
        });
      }`,
    });
    service.setEnabled('example.demo', true);
    const send = async (to?: string, sessionId = 's1') =>
      (
        await service.callTool({
          toolName: 'plugin_example-demo__lookup',
          args: to ? { to } : {},
          sessionId,
          projectRoot: null,
        })
      ).content;
    expect(await send()).toBe('ok');
    expect(await send('s1')).toBe('ok');
    expect(await send('s2')).toBe('PERMISSION_DENIED');
    expect(bridge.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['s1', 's1']);
    expect(service.list()[0]?.crossSessionInject).toBe(false);
    expect(service.setCrossSessionInject('example.demo', true)).toEqual({ ok: true });
    expect(await send('s2')).toBe('ok');
    expect(
      JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')).plugins[0].crossSessionInject
    ).toBe(true);
    const results: string[] = [];
    for (let i = 0; i < 12; i++) results.push(await send());
    expect(results.filter((r) => r === 'RATE_LIMITED').length).toBeGreaterThan(0);
  });

  it('没有 agent.inject 的插件不能打开跨会话注入', async () => {
    const { service } = createService();
    await install(service, {
      'enso-plugin.json': manifest(),
      'main.mjs': `export function activate(enso) { enso.tools.register('lookup', () => 'x'); }`,
    });
    expect(service.setCrossSessionInject('example.demo', true).ok).toBe(false);
    expect(service.list()[0]?.crossSessionInject).toBeUndefined();
  });

  it('定时任务按间隔执行且不重叠，停用后不再跑', async () => {
    const { service, root } = createService();
    await install(service, {
      'enso-plugin.json': manifest({
        permissions: ['agent.tool', 'process.background'],
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          schedules: [{ id: 'tick', intervalSeconds: 60, timeoutMs: 600_000 }],
        },
      }),
      'main.mjs': `import { appendFileSync } from 'node:fs';
        export function activate(enso) {
          enso.schedules.register('tick', () => {
            appendFileSync(enso.dataDir + '/ticks.txt', 'x');
            return new Promise(() => {});
          });
          enso.tools.register('lookup', async () => 'ok');
        }`,
    });
    service.setEnabled('example.demo', true);
    await service.callTool({
      toolName: 'plugin_example-demo__lookup',
      args: {},
      sessionId: 's',
      projectRoot: null,
    });
    vi.useFakeTimers();
    service.startBackground();
    await vi.advanceTimersByTimeAsync(60_000);
    const ticks = join(pluginDataPath(root, 'example.demo'), 'ticks.txt');
    expect(readFileSync(ticks, 'utf8')).toBe('x');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readFileSync(ticks, 'utf8')).toBe('x');
    service.setEnabled('example.demo', false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(readFileSync(ticks, 'utf8')).toBe('x');
    expect(service.list()[0]?.schedules?.[0]?.lastRunAt).toBeUndefined();
  });

  it('常驻不超过 5 个，意外退出 5 秒后重拉', async () => {
    vi.useFakeTimers();
    const children: EventEmitter[] = [];
    const { service } = createService(() => {
      const child = new EventEmitter() as EventEmitter & {
        postMessage(message: unknown): void;
        kill(): boolean;
      };
      child.postMessage = (message: unknown) => {
        const kind = (message as { t?: string }).t;
        if (kind === 'init')
          queueMicrotask(() =>
            child.emit('message', {
              t: 'ready',
              registered: {
                tools: [],
                commands: [],
                triggers: [],
                rendererMethods: [],
                events: [],
                schedules: [],
                exports: [],
              },
            })
          );
        if (kind === 'shutdown') queueMicrotask(() => child.emit('exit', 0));
      };
      child.kill = () => {
        queueMicrotask(() => child.emit('exit', 0));
        return true;
      };
      children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    for (const id of ['a.a', 'a.b', 'a.c', 'a.d', 'a.e', 'a.f']) {
      await install(service, {
        'enso-plugin.json': manifest({
          id,
          name: id,
          permissions: ['process.background'],
          resident: true,
          contributes: {},
        }),
        'main.mjs': 'export function activate() {}',
      });
      service.setEnabled(id, true);
    }
    const offset = children.length;
    service.startBackground();
    await vi.advanceTimersByTimeAsync(0);
    const running = () =>
      service
        .list()
        .filter((item) => item.running)
        .map((item) => item.id);
    expect(running()).toEqual(['a.a', 'a.b', 'a.c', 'a.d', 'a.e']);
    expect(service.list().find((item) => item.id === 'a.f')?.lastError?.message).toContain('上限');
    children[offset]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(children.length).toBe(offset + 6);
    expect(running()).toContain('a.a');
  });

  describe('子会话来源', () => {
    const agent = {
      kind: 'subagent' as const,
      sessionId: 's::cw-scout',
      name: 'Scout-1',
      agentType: 'Scout',
    };

    it('子会话发起的工具调用经 ctx.agent 标明来源；主会话 ctx.agent 为 null', async () => {
      const { service } = createService();
      await install(service, {
        'enso-plugin.json': manifest(),
        'main.mjs': `export function activate(enso) {
          enso.tools.register('lookup', async (_args, ctx) =>
            JSON.stringify({ sessionId: ctx.sessionId, agent: ctx.agent }));
        }`,
      });
      service.setEnabled('example.demo', true);
      const call = (extra: Record<string, unknown>) =>
        service.callTool({
          toolName: 'plugin_example-demo__lookup',
          args: {},
          sessionId: 's',
          projectRoot: null,
          ...extra,
        });
      expect(JSON.parse((await call({})).content)).toEqual({ sessionId: 's', agent: null });
      expect(JSON.parse((await call({ agent })).content)).toEqual({ sessionId: 's', agent });
    });

    it('子会话事件只投给通知型订阅者，before_compact 不等插件处理', async () => {
      const { service } = createService();
      const recorder = (id: string, mode: 'observe' | 'intercept') => ({
        'enso-plugin.json': manifest({
          id,
          name: id,
          permissions: ['agent.tool', mode === 'observe' ? 'agent.observe' : 'agent.intercept'],
          contributes: {
            agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
            events: [
              { event: 'tool_call', mode },
              ...(mode === 'observe' ? [{ event: 'before_compact', mode }] : []),
            ],
          },
        }),
        'main.mjs': `const seen = [];
          export function activate(enso) {
            enso.events.on('tool_call', (data, ctx) => { seen.push(['tool_call', ctx.agent]); });
            ${
              mode === 'observe'
                ? `enso.events.on('before_compact', (data, ctx) => {
                    seen.push(['before_compact', ctx.agent]);
                    return new Promise(() => {});
                  });`
                : ''
            }
            enso.tools.register('lookup', async () => JSON.stringify(seen));
          }`,
      });
      await install(service, recorder('o.o', 'observe'));
      await install(service, recorder('i.i', 'intercept'));
      service.setEnabled('o.o', true);
      service.setEnabled('i.i', true);
      const read = async (id: string) =>
        JSON.parse(
          (
            await service.callTool({
              toolName: `plugin_${id.replace('.', '-')}__lookup`,
              args: {},
              sessionId: 's',
              projectRoot: null,
            })
          ).content
        );
      // 先拉起两个进程，避免把启动耗时算进 before_compact 的等待
      await read('o.o');
      await read('i.i');
      await service.dispatchEvent({
        sessionId: 's',
        projectRoot: null,
        event: 'tool_call',
        data: { toolCallId: 'c', toolName: 'bash', input: {} },
        agent,
      });
      const started = Date.now();
      await service.dispatchEvent({
        sessionId: 's',
        projectRoot: null,
        event: 'before_compact',
        data: { reason: 'threshold' },
        agent,
      });
      expect(Date.now() - started).toBeLessThan(1_000);
      await flush();
      expect(await read('o.o')).toEqual([
        ['tool_call', agent],
        ['before_compact', agent],
      ]);
      expect(await read('i.i')).toEqual([]);
    });

    const guard = (id: string, failClosed: boolean, body: string, events = ['tool_call']) => ({
      'enso-plugin.json': manifest({
        id,
        name: id,
        permissions: ['agent.intercept'],
        contributes: {
          events: events.map((event) => ({ event, mode: 'intercept', failClosed })),
        },
      }),
      'main.mjs': body,
    });
    const toolCall = { toolCallId: '1', toolName: 'bash', input: { command: 'rm' } };

    it('子会话的 tool_call 拦截生效且带来源；input / tool_result 不询问插件', async () => {
      const { service, root } = createService();
      const log = join(root, 'asked');
      await install(
        service,
        guard(
          'g.g',
          false,
          `import { appendFileSync } from 'node:fs';
          export function activate(enso) {
            for (const name of ['tool_call', 'tool_result', 'input'])
              enso.events.on(name, (data, ctx) => {
                appendFileSync(${JSON.stringify(log)}, name + '\\n');
                if (name !== 'tool_call') return { action: 'handled', content: 'x' };
                return ctx.agent
                  ? { block: true, reason: 'from ' + ctx.agent.name }
                  : { input: { ...data.input, checked: true } };
              });
          }`,
          ['tool_call', 'tool_result', 'input']
        )
      );
      service.setEnabled('g.g', true);
      const asked = () => {
        try {
          return readFileSync(log, 'utf8').trim().split('\n');
        } catch {
          return [];
        }
      };
      await expect(
        service.intercept({
          sessionId: 's',
          projectRoot: null,
          event: 'tool_call',
          payload: toolCall,
          agent,
        })
      ).resolves.toEqual({ block: true, reason: 'from Scout-1' });
      await expect(
        service.intercept({
          sessionId: 's',
          projectRoot: null,
          event: 'input',
          payload: { text: 'hi', source: 'interactive' },
          agent,
        })
      ).resolves.toEqual({ action: 'continue' });
      await expect(
        service.intercept({
          sessionId: 's',
          projectRoot: null,
          event: 'tool_result',
          payload: { ...toolCall, content: 'ok', isError: false },
          agent,
        })
      ).resolves.toEqual({});
      expect(asked()).toEqual(['tool_call']);
      await expect(
        service.intercept({
          sessionId: 's',
          projectRoot: null,
          event: 'tool_call',
          payload: toolCall,
        })
      ).resolves.toEqual({ input: { command: 'rm', checked: true } });
    });

    it('子会话单插件限时 2 秒并按 failClosed 拒绝；主会话仍按 5 秒等到答复', async () => {
      const { service } = createService();
      await install(
        service,
        guard(
          's.s',
          true,
          `export function activate(enso) {
            enso.events.on('tool_call', async (data) => {
              await new Promise((r) => setTimeout(r, 2_500));
              return { input: { ...data.input, slow: true } };
            });
          }`
        )
      );
      service.setEnabled('s.s', true);
      let started = Date.now();
      await expect(
        service.intercept({
          sessionId: 's',
          projectRoot: null,
          event: 'tool_call',
          payload: toolCall,
          agent,
        })
      ).resolves.toMatchObject({ block: true });
      expect(Date.now() - started).toBeLessThan(2_400);
      started = Date.now();
      await expect(
        service.intercept({
          sessionId: 's',
          projectRoot: null,
          event: 'tool_call',
          payload: toolCall,
        })
      ).resolves.toEqual({ input: { command: 'rm', slow: true } });
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_400);
    }, 15_000);

    it('子会话一次拦截合计不超过 5 秒，来不及询问的按各自 failClosed 处理', async () => {
      const { service } = createService();
      for (const [id, failClosed] of [
        ['t.a', false],
        ['t.b', false],
        ['t.c', false],
        ['t.d', true],
      ] as const) {
        await install(
          service,
          guard(
            id,
            failClosed,
            `export function activate(enso) {
              enso.events.on('tool_call', async (data) => {
                await new Promise((r) => setTimeout(r, 1_800));
                return { input: { ...data.input, ${JSON.stringify(id)}: 1 } };
              });
            }`
          )
        );
        service.setEnabled(id, true);
      }
      const started = Date.now();
      const result = await service.intercept({
        sessionId: 's',
        projectRoot: null,
        event: 'tool_call',
        payload: toolCall,
        agent,
      });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(5_500);
      expect(elapsed).toBeGreaterThanOrEqual(4_900);
      expect(result).toMatchObject({ block: true });
    }, 20_000);

    it('子会话的失败单独熔断：子会话放行时主会话仍询问并按 failClosed 拒绝', async () => {
      const now = 1_000_000;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const { service } = createService();
        await install(
          service,
          guard(
            'c.guard',
            true,
            `export function activate(enso) { enso.events.on('tool_call', () => { throw new Error('down'); }); }`
          )
        );
        service.setEnabled('c.guard', true);
        const ask = (child: boolean) =>
          service.intercept({
            sessionId: 's',
            projectRoot: null,
            event: 'tool_call',
            payload: toolCall,
            ...(child ? { agent } : {}),
          });
        for (let i = 0; i < 3; i++) expect(await ask(true)).toMatchObject({ block: true });
        expect(service.list()[0]?.interceptBreakers).toEqual([
          { event: 'tool_call（子代理与 coworker）', until: now + 30_000 },
        ]);
        expect(await ask(true)).toEqual({});
        expect(await ask(false)).toMatchObject({ block: true });
        expect(await ask(false)).toMatchObject({ block: true });
        expect(service.list()[0]?.interceptBreakers).toHaveLength(1);
        expect(await ask(false)).toMatchObject({ block: true });
        expect(service.list()[0]?.interceptBreakers).toEqual([
          { event: 'tool_call（子代理与 coworker）', until: now + 30_000 },
          { event: 'tool_call', until: now + 30_000 },
        ]);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
