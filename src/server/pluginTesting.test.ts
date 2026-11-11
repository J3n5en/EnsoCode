import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_TESTING_SOURCE } from './pluginTesting';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

interface TestCtx {
  sessionId: string;
  progress: () => Promise<void>;
}

interface TestEnso {
  ui: { status: { update: (text: string) => unknown } };
  config: { get: () => unknown };
  fs: { readText: (path: string) => unknown };
  tools: {
    register: (name: string, handler: (args: unknown, ctx: TestCtx) => unknown) => unknown;
  };
  commands: {
    register: (id: string, handler: (ctx: TestCtx) => unknown) => unknown;
  };
  events: {
    on: (event: string, handler: (data: unknown, ctx: TestCtx) => unknown) => unknown;
  };
  schedules: { register: (id: string, handler: (ctx: TestCtx) => unknown) => unknown };
  renderer: {
    handle: (name: string, handler: (args: unknown, ctx: TestCtx) => unknown) => unknown;
  };
}

interface Mounted {
  enso: TestEnso;
  calls: { api: string; args: unknown[] }[];
  tool: (name: string, args: unknown, ctx?: TestCtx) => Promise<unknown>;
  command: (id: string, ctx?: TestCtx) => Promise<unknown>;
  fire: (event: string, data: unknown, ctx?: TestCtx) => Promise<unknown>;
  schedule: (id: string) => Promise<unknown>;
  method: (name: string, args: unknown, ctx?: TestCtx) => Promise<unknown>;
}

type MountMain = (
  activate: (enso: TestEnso) => unknown,
  options?: {
    config?: Record<string, unknown>;
    host?: Record<string, (...args: any[]) => unknown>;
  }
) => Promise<Mounted>;

async function loadHarness(): Promise<MountMain> {
  const root = mkdtempSync(join(tmpdir(), 'enso-plugin-testing-'));
  roots.push(root);
  const file = join(root, 'enso-testing.mjs');
  writeFileSync(file, PLUGIN_TESTING_SOURCE);
  const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
    mountMain: MountMain;
  };
  return mod.mountMain;
}

describe('PLUGIN_TESTING_SOURCE', () => {
  it('是零依赖 ESM，能挂载 main 并回放工具、命令和事件', async () => {
    expect(PLUGIN_TESTING_SOURCE).toMatch(/export\s+async\s+function\s+mountMain/);
    expect(PLUGIN_TESTING_SOURCE).not.toMatch(/\bimport\b/);

    const mountMain = await loadHarness();
    const mounted = await mountMain(
      async (enso) => {
        enso.tools.register('echo', (args, ctx) => ({ args, sessionId: ctx.sessionId }));
        enso.commands.register('show', async (ctx) => {
          const status = await enso.ui.status.update('busy');
          return { sessionId: ctx.sessionId, status };
        });
        enso.events.on('session_start', (data, ctx) => ({ data, sessionId: ctx.sessionId }));
        enso.schedules.register('sweep', (ctx) => ctx.sessionId);
        enso.renderer.handle('ping', (args) => args);
      },
      {
        config: { token: 'x' },
        host: {
          'ui.status.update': (text: string) => ({ echoed: text }),
          'fs.readText': (path: string) => `read:${path}`,
        },
      }
    );

    expect(await mounted.tool('echo', { q: 1 })).toEqual({
      args: { q: 1 },
      sessionId: 'test-session',
    });
    expect(
      await mounted.tool('echo', { q: 2 }, { sessionId: 'other', progress: async () => {} })
    ).toEqual({ args: { q: 2 }, sessionId: 'other' });
    expect(await mounted.command('show')).toEqual({
      sessionId: 'test-session',
      status: { echoed: 'busy' },
    });
    expect(mounted.calls).toContainEqual({ api: 'ui.status.update', args: ['busy'] });
    expect(await mounted.fire('session_start', { ok: true })).toEqual({
      data: { ok: true },
      sessionId: 'test-session',
    });
    expect(await mounted.schedule('sweep')).toBe('test-session');
    expect(await mounted.method('ping', { n: 1 })).toEqual({ n: 1 });
    expect(await mounted.enso.config.get()).toEqual({ token: 'x' });
    expect(mounted.calls).toContainEqual({ api: 'config.get', args: [] });
    expect(await mounted.enso.fs.readText('a.txt')).toBe('read:a.txt');
    expect(mounted.calls).toContainEqual({ api: 'fs.readText', args: ['a.txt'] });
  });

  it('调用未注册的 handler 时报错', async () => {
    const mountMain = await loadHarness();
    const mounted = await mountMain(async () => {});
    await expect(mounted.tool('missing', {})).rejects.toThrow('未注册: tool missing');
    await expect(mounted.command('missing')).rejects.toThrow('未注册: command missing');
    await expect(mounted.fire('missing', null)).rejects.toThrow('未注册: event missing');
    await expect(mounted.schedule('missing')).rejects.toThrow('未注册: schedule missing');
    await expect(mounted.method('missing', {})).rejects.toThrow('未注册: method missing');
  });
});
