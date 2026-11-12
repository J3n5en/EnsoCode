import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ExtensionPluginNotice } from '@shared/extensionPlugins/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPluginHost } from '../../../pluginHost/host';
import { setNativeAgentTypeSource, withPluginAgentTypes } from '../pluginRuntime';
import { readRegistry } from './registry';
import { ExtensionPluginService, uiCallTimeout } from './service';

/** 用进程内的插件宿主替代真实子进程，测试完整往返 */
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
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
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

const mainJs = `export function activate(enso) { enso.tools.register('lookup', async (args, ctx) => 'got ' + args.q + ' in ' + ctx.sessionId); }`;

let root: string;
let service: ExtensionPluginService;

beforeEach(() => {
  root = temp('plugins-root-');
  service = new ExtensionPluginService({
    root,
    hostVersion: '0.2.12',
    hostPath: '/unused',
    env: {},
    fork: () => new InProcessChild() as never,
    gate: {
      fetch: vi.fn(),
      notify: () => true,
      composer: async () => null,
      mcpTools: async () => [],
      mcpCall: async () => ({ content: '', isError: false }),
      now: () => Date.now(),
    },
  });
});

async function install(files: Record<string, string>) {
  const preview = await service.stage({ kind: 'dir', path: writePlugin(files) });
  if (!preview.ok) throw new Error(preview.error);
  const committed = await service.commit(preview.preview.token);
  if (!committed.ok) throw new Error(committed.error);
  return preview.preview;
}

describe('ExtensionPluginService', () => {
  it('开发模式：目录来源的插件改动后自动重装，授权扩大时停下并报错', async () => {
    const watchers = new Map<string, () => void>();
    const closed: string[] = [];
    const dev = new ExtensionPluginService({
      root: temp('plugins-dev-'),
      hostVersion: '0.2.12',
      hostPath: '/unused',
      env: {},
      fork: () => new InProcessChild() as never,
      devWatch: (dir, onChange) => {
        watchers.set(dir, onChange);
        return { close: () => closed.push(dir) };
      },
      devReloadDelayMs: 0,
      gate: {
        fetch: vi.fn(),
        notify: () => true,
        composer: async () => null,
        mcpTools: async () => [],
        mcpCall: async () => ({ content: '', isError: false }),
        now: () => Date.now(),
      },
    });
    const dir = writePlugin({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    const staged = await dev.stage({ kind: 'dir', path: dir });
    if (!staged.ok) throw new Error(staged.error);
    await dev.commit(staged.preview.token);
    expect(dev.list()[0]?.devWatch).toBe(false);
    expect(dev.setDevWatch('example.demo', true)).toEqual({ ok: true });
    expect(dev.list()[0]?.devWatch).toBe(true);
    expect(watchers.has(dir)).toBe(true);

    writeFileSync(join(dir, 'enso-plugin.json'), manifest({ version: '1.0.1' }));
    await dev.devReloadNow('example.demo');
    expect(dev.list()[0]?.version).toBe('1.0.1');

    writeFileSync(
      join(dir, 'enso-plugin.json'),
      manifest({ version: '1.0.2', permissions: ['agent.tool', 'ui.notify'] })
    );
    await dev.devReloadNow('example.demo');
    expect(dev.list()[0]?.version).toBe('1.0.1');
    expect(dev.list()[0]?.lastError?.message).toContain('授权扩大');

    expect(dev.setDevWatch('example.demo', false)).toEqual({ ok: true });
    expect(closed).toEqual([dir]);
    await dev.dispose();
  });

  it('开发模式只对目录来源开放', async () => {
    await service.stage({ kind: 'dir', path: writePlugin({ 'enso-plugin.json': manifest() }) });
    expect(service.setDevWatch('missing.plugin', true)).toMatchObject({ ok: false });
  });

  it('只含主题的插件：预览带样式能力，启用后摘要列出主题、资源可读', async () => {
    const themeManifest = JSON.stringify({
      schemaVersion: 1,
      id: 'example.theme',
      name: 'Theme',
      version: '1.0.0',
      permissions: [],
      contributes: {
        themes: [
          { id: 'night', name: 'Night', path: 'themes/night.json', css: 'themes/night.css' },
        ],
      },
    });
    const preview = await install({
      'enso-plugin.json': themeManifest,
      'themes/night.json': '{}',
      'themes/night.css': 'a{}',
    });
    expect(preview).toMatchObject({ styles: true, permissions: [] });
    expect(service.assetPath('example.theme', 'themes/night.css')).toBeNull();
    await service.setEnabled('example.theme', true);
    expect(service.list()[0]?.themes).toEqual([
      { id: 'night', name: 'Night', path: 'themes/night.json', css: 'themes/night.css' },
    ]);
    expect(service.assetPath('example.theme', 'themes/night.css')).toMatch(/night\.css$/);
    expect(service.assetPath('example.theme', '../registry.json')).toBeNull();
  });

  it('主题引用的文件缺失时拒绝暂存', async () => {
    const result = await service.stage({
      kind: 'dir',
      path: writePlugin({
        'enso-plugin.json': JSON.stringify({
          schemaVersion: 1,
          id: 'example.theme',
          name: 'Theme',
          version: '1.0.0',
          contributes: { themes: [{ id: 'night', name: 'Night', path: 'night.json' }] },
        }),
      }),
    });
    expect(result.ok).toBe(false);
  });

  it('安装后默认停用，启用后工具进入会话下发列表', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    expect(service.list()[0]).toMatchObject({ id: 'example.demo', state: 'disabled' });
    expect(service.toolsForSpawn()).toEqual([]);
    await service.setEnabled('example.demo', true);
    expect(service.toolsForSpawn()).toEqual([
      {
        name: 'plugin_example-demo__lookup',
        description: '查询',
        parameters: { type: 'object' },
        pluginId: 'example.demo',
      },
    ]);
    expect(readRegistry(root).plugins[0]?.state).toBe('enabled');
  });

  it('Main 派发的 session_status 不进 worker 事件计划', async () => {
    await install({
      'enso-plugin.json': manifest({
        permissions: ['agent.observe'],
        contributes: { events: [{ event: 'session_status' }] },
      }),
      'main.mjs': 'export function activate() {}',
    });
    await service.setEnabled('example.demo', true);
    expect(service.eventPlanForSpawn()).toBeNull();
  });

  it('调用插件工具：会话 id 由 Main 传入', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    await service.setEnabled('example.demo', true);
    const result = await service.callTool({
      toolName: 'plugin_example-demo__lookup',
      args: { q: 'x' },
      sessionId: 's1',
      projectRoot: null,
    });
    expect(result).toEqual({ content: 'got x in s1', artifacts: [] });
  });

  it('停用的插件调用直接失败，不拉起进程', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    await expect(
      service.callTool({
        toolName: 'plugin_example-demo__lookup',
        args: {},
        sessionId: 's1',
        projectRoot: null,
      })
    ).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' });
  });

  it('试加载失败时安装失败且不留文件', async () => {
    const preview = await service.stage({
      kind: 'dir',
      path: writePlugin({
        'enso-plugin.json': manifest(),
        'main.mjs': 'export function activate(){ throw new Error("x") }',
      }),
    });
    if (!preview.ok) throw new Error(preview.error);
    const committed = await service.commit(preview.preview.token);
    expect(committed.ok).toBe(false);
    expect(service.list()).toEqual([]);
    expect(existsSync(join(root, 'packages', 'example.demo'))).toBe(false);
  });

  it('更新扩大授权时挂起，旧版本继续可用；同意后切换', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    await service.setEnabled('example.demo', true);
    const preview = await service.stage({
      kind: 'dir',
      path: writePlugin({
        'enso-plugin.json': manifest({
          version: '2.0.0',
          permissions: ['agent.tool', 'net.fetch'],
          net: { domains: ['api.example.com'] },
        }),
        'main.mjs': mainJs,
      }),
    });
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.preview).toMatchObject({ existingVersion: '1.0.0', expands: true });
    await service.commit(preview.preview.token);
    expect(service.list()[0]).toMatchObject({
      version: '1.0.0',
      pendingVersion: '2.0.0',
      state: 'enabled',
    });
    await service.approvePending('example.demo');
    expect(service.list()[0]).toMatchObject({ version: '2.0.0', state: 'enabled' });
    expect(service.list()[0]?.pendingVersion).toBeUndefined();
  });

  it('跨会话注入被拒只通知一次，切换开关后可以再通知', async () => {
    await install({
      'enso-plugin.json': manifest({
        permissions: ['agent.tool', 'agent.inject'],
      }),
      'main.mjs': mainJs,
    });
    await service.setEnabled('example.demo', true);
    const notices: ExtensionPluginNotice[] = [];
    service.onNotice((notice) => notices.push(notice));
    const deny = () =>
      service.gate.handle(
        'example.demo',
        'session.inject',
        { text: 'hi', sessionId: 'other' },
        undefined
      );
    await expect(deny()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(deny()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(notices).toEqual([{ kind: 'inject-denied', pluginId: 'example.demo', name: 'Demo' }]);
    expect(service.setCrossSessionInject('example.demo', false).ok).toBe(true);
    await expect(deny()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(notices).toHaveLength(2);
    expect(notices[1]).toEqual({ kind: 'inject-denied', pluginId: 'example.demo', name: 'Demo' });
  });

  it('权限没变的更新不通知，扩大授权时通知待授权', async () => {
    const src = writePlugin({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    const first = await service.stage({ kind: 'dir', path: src });
    if (!first.ok) throw new Error(first.error);
    await service.commit(first.preview.token);
    const notices: ExtensionPluginNotice[] = [];
    service.onNotice((notice) => notices.push(notice));
    writeFileSync(join(src, 'enso-plugin.json'), manifest({ version: '1.1.0' }));
    const same = await service.restage('example.demo');
    if (!same.ok) throw new Error(same.error);
    expect((await service.commit(same.preview.token)).ok).toBe(true);
    expect(notices).toEqual([]);
    writeFileSync(
      join(src, 'enso-plugin.json'),
      manifest({
        version: '2.0.0',
        permissions: ['agent.tool', 'net.fetch'],
        net: { domains: ['api.example.com'] },
      })
    );
    const wider = await service.restage('example.demo');
    if (!wider.ok) throw new Error(wider.error);
    expect((await service.commit(wider.preview.token)).ok).toBe(true);
    expect(service.list()[0]?.pendingVersion).toBe('2.0.0');
    expect(notices).toEqual([
      {
        kind: 'update-needs-approval',
        pluginId: 'example.demo',
        name: 'Demo',
        version: '2.0.0',
      },
    ]);
  });

  it('卸载删除安装目录与数据目录', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    mkdirSync(join(root, 'data', 'example.demo'), { recursive: true });
    await service.uninstall('example.demo');
    expect(service.list()).toEqual([]);
    expect(existsSync(join(root, 'packages', 'example.demo'))).toBe(false);
    expect(existsSync(join(root, 'data', 'example.demo'))).toBe(false);
  });

  it('使用说明只读安装目录里的 README.md', async () => {
    await install({
      'enso-plugin.json': manifest(),
      'main.mjs': mainJs,
      'README.md': '# Demo\n',
    });
    expect(await service.readme('example.demo', 'installed')).toEqual({
      ok: true,
      markdown: '# Demo\n',
    });
    expect(await service.readme('example.other', 'installed')).toMatchObject({ ok: false });
    expect(await service.readme('example.demo', 'market')).toMatchObject({ ok: false });
  });

  it('10 分钟内非预期退出 3 次即标记崩溃停用', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    await service.setEnabled('example.demo', true);
    for (let i = 0; i < 3; i++) service.recordCrash('example.demo');
    expect(service.list()[0]?.state).toBe('crashed');
    expect(service.toolsForSpawn()).toEqual([]);
  });

  describe('从来源重新安装', () => {
    it('记住安装来源；源目录改动后重新暂存得到新版本，确认后替换', async () => {
      const src = writePlugin({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      const first = await service.stage({ kind: 'dir', path: src });
      if (!first.ok) throw new Error(first.error);
      await service.commit(first.preview.token);
      expect(service.list()[0]?.source).toEqual({ kind: 'dir' });
      expect(readRegistry(root).plugins[0]?.source).toEqual({ kind: 'dir', path: src });
      writeFileSync(join(src, 'enso-plugin.json'), manifest({ version: '1.1.0' }));
      const again = await service.restage('example.demo');
      if (!again.ok) throw new Error(again.error);
      expect(again.preview).toMatchObject({
        version: '1.1.0',
        existingVersion: '1.0.0',
        expands: false,
      });
      await service.commit(again.preview.token);
      expect(service.list()[0]?.version).toBe('1.1.0');
      expect(readRegistry(root).plugins[0]?.source).toEqual({ kind: 'dir', path: src });
    });

    it('链接安装的来源在列表里带链接；没有记录来源时拒绝', async () => {
      expect((await service.restage('example.demo')).ok).toBe(false);
      await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      const registry = readRegistry(root);
      const record = registry.plugins[0];
      if (!record) throw new Error('no record');
      const { source: _source, ...legacy } = record;
      writeFileSync(join(root, 'registry.json'), JSON.stringify({ version: 1, plugins: [legacy] }));
      const reloaded = new ExtensionPluginService({
        root,
        hostVersion: '0.2.12',
        hostPath: '/unused',
        env: {},
        fork: () => new InProcessChild() as never,
        gate: {
          fetch: vi.fn(),
          notify: () => true,
          composer: async () => null,
          mcpTools: async () => [],
          mcpCall: async () => ({ content: '', isError: false }),
          now: () => Date.now(),
        },
      });
      expect(reloaded.list()[0]?.source).toBeUndefined();
      expect(await reloaded.restage('example.demo')).toMatchObject({ ok: false });
    });
  });

  describe('检查更新', () => {
    const repo = 'https://github.com/acme/demo/tree/main/hello';
    const probe = 'https://raw.githubusercontent.com/acme/demo/main/hello/enso-plugin.json';

    /** 把已装插件的来源改成 GitHub 链接，用给定的 fetch 重开服务 */
    function reopenWithRepo(fetch: (url: string) => Promise<Response>) {
      const registry = readRegistry(root);
      registry.plugins = registry.plugins.map((p) => ({
        ...p,
        source: { kind: 'url', url: repo },
      }));
      writeFileSync(join(root, 'registry.json'), JSON.stringify(registry));
      return new ExtensionPluginService({
        root,
        hostVersion: '0.2.12',
        hostPath: '/unused',
        env: {},
        fork: () => new InProcessChild() as never,
        gate: {
          fetch: vi.fn(fetch),
          notify: () => true,
          composer: async () => null,
          mcpTools: async () => [],
          mcpCall: async () => ({ content: '', isError: false }),
          now: () => Date.now(),
        },
      });
    }

    it('GitHub 来源只拉清单；远端版本更高才提示可更新，并通知界面刷新', async () => {
      await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      const fetch = vi.fn(async () => new Response(manifest({ version: '1.2.0' })));
      const svc = reopenWithRepo(fetch);
      const changed = vi.fn();
      svc.onChange(changed);
      const notices: ExtensionPluginNotice[] = [];
      svc.onNotice((notice) => notices.push(notice));
      expect(await svc.checkUpdates()).toEqual({ checked: 1, available: 1, failed: 0 });
      expect(fetch).toHaveBeenCalledWith(probe, expect.anything());
      expect(svc.list()[0]).toMatchObject({ availableVersion: '1.2.0' });
      expect(svc.list()[0]?.updateCheckError).toBeUndefined();
      expect(svc.list()[0]?.version).toBe('1.0.0');
      expect(notices).toEqual([]);
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    });

    it('远端版本不更高、本地目录来源都不提示', async () => {
      await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      expect(await service.checkUpdates()).toEqual({ checked: 0, available: 0, failed: 0 });
      const svc = reopenWithRepo(async () => new Response(manifest({ version: '1.0.0' })));
      expect(await svc.checkUpdates()).toEqual({ checked: 1, available: 0, failed: 0 });
      expect(svc.list()[0]?.availableVersion).toBeUndefined();
    });

    it('请求失败、清单不合法或 id 不符时记下原因，不提示更新', async () => {
      await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      for (const reply of [
        new Response('nope', { status: 404 }),
        new Response('{bad json'),
        new Response(manifest({ id: 'other.plugin', version: '9.0.0' })),
      ]) {
        const svc = reopenWithRepo(async () => reply);
        expect(await svc.checkUpdates()).toEqual({ checked: 1, available: 0, failed: 1 });
        expect(svc.list()[0]?.availableVersion).toBeUndefined();
        expect(svc.list()[0]?.updateCheckError).toEqual(expect.any(String));
      }
    });

    it('自动检查只查已启用的插件', async () => {
      await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      const fetch = vi.fn(async () => new Response(manifest({ version: '1.2.0' })));
      const svc = reopenWithRepo(fetch);
      expect(await svc.checkUpdates({ enabledOnly: true })).toEqual({
        checked: 0,
        available: 0,
        failed: 0,
      });
      await svc.setEnabled('example.demo', true);
      expect(await svc.checkUpdates({ enabledOnly: true })).toMatchObject({ available: 1 });
      svc.dispose();
    });

    it('装上新版后提示消失', async () => {
      const src = writePlugin({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      const first = await service.stage({ kind: 'dir', path: src });
      if (!first.ok) throw new Error(first.error);
      await service.commit(first.preview.token);
      const svc = reopenWithRepo(async () => new Response(manifest({ version: '1.2.0' })));
      await svc.checkUpdates();
      writeFileSync(join(src, 'enso-plugin.json'), manifest({ version: '1.2.0' }));
      const staged = await svc.stage({ kind: 'dir', path: src });
      if (!staged.ok) throw new Error(staged.error);
      await svc.commit(staged.preview.token);
      expect(svc.list()[0]?.version).toBe('1.2.0');
      expect(svc.list()[0]?.availableVersion).toBeUndefined();
    });

    it('重新安装时版本没变或更低，预览里给出提示', async () => {
      const src = writePlugin({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      const first = await service.stage({ kind: 'dir', path: src });
      if (!first.ok) throw new Error(first.error);
      expect(first.preview.warnings).toEqual([]);
      await service.commit(first.preview.token);
      const same = await service.restage('example.demo');
      if (!same.ok) throw new Error(same.error);
      expect(same.preview.warnings.join()).toContain('版本号没有变化');
      service.discard(same.preview.token);
      writeFileSync(join(src, 'enso-plugin.json'), manifest({ version: '0.9.0' }));
      const lower = await service.restage('example.demo');
      if (!lower.ok) throw new Error(lower.error);
      expect(lower.preview.warnings.join()).toContain('低于已安装的 1.0.0');
    });
  });

  describe('日志与最近错误', () => {
    const noisy = `export function activate(enso) {
      enso.commands.register('bad', async () => { throw new Error('kaput'); });
    }`;
    const withCommand = () =>
      manifest({ permissions: [], contributes: { commands: [{ id: 'bad', title: 'Bad' }] } });

    it('处理器异常进日志，最近错误出现在列表里', async () => {
      await install({ 'enso-plugin.json': withCommand(), 'main.mjs': noisy });
      await service.setEnabled('example.demo', true);
      const call = { pluginId: 'example.demo', sessionId: null, projectRoot: null } as const;
      await expect(
        service.callUi({ ...call, method: 'command.run', payload: { id: 'bad' } })
      ).rejects.toThrow('kaput');
      await vi.waitFor(async () => {
        expect(await service.logs('example.demo')).toContain('kaput');
      });
      expect(service.list()[0]?.lastError?.message).toContain('kaput');
    });

    it('崩溃停用时把原因写进登记，重启后仍可见；重新启用清掉', async () => {
      await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      await service.setEnabled('example.demo', true);
      service.recordError('example.demo', 'segfault');
      for (let i = 0; i < 3; i++) service.recordCrash('example.demo');
      expect(readRegistry(root).plugins[0]?.lastError?.message).toBe('segfault');
      await service.setEnabled('example.demo', true);
      expect(service.list()[0]?.lastError).toBeUndefined();
      expect(readRegistry(root).plugins[0]?.lastError).toBeUndefined();
    });

    it('日志只返回末尾，卸载时删除', async () => {
      await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      for (let i = 0; i < 80; i++)
        service.appendLog('example.demo', 'info', `line-${i}-${'x'.repeat(80)}`);
      const tail = await service.logs('example.demo', 4096);
      expect(tail.length).toBeLessThanOrEqual(4096);
      expect(tail).toContain('line-79');
      expect(tail).not.toContain('line-0-');
      await service.uninstall('example.demo');
      expect(await service.logs('example.demo')).toBe('');
    });
  });

  it('暂存令牌只能提交一次', async () => {
    const preview = await service.stage({
      kind: 'dir',
      path: writePlugin({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs }),
    });
    if (!preview.ok) throw new Error(preview.error);
    expect((await service.commit(preview.preview.token)).ok).toBe(true);
    expect((await service.commit(preview.preview.token)).ok).toBe(false);
  });

  it('启用后下发 skills 与 MCP：服务名加前缀，插件根占位符展开为安装目录', async () => {
    await install({
      'enso-plugin.json': manifest({
        permissions: ['agent.tool', 'mcp.server'],
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          skills: ['skills/demo'],
          mcpServers: [
            {
              name: 'srv',
              command: 'node',
              // biome-ignore lint/suspicious/noTemplateCurlyInString: 清单占位符
              args: ['${ENSO_PLUGIN_ROOT}/server.js'],
              env: { MODE: 'x' },
            },
          ],
        },
      }),
      'main.mjs': mainJs,
      'skills/demo/SKILL.md': '# demo',
      'server.js': '',
    });
    expect(service.skillPathsForSpawn()).toEqual([]);
    expect(service.mcpServersForSpawn()).toEqual([]);
    await service.setEnabled('example.demo', true);
    const [skill] = service.skillPathsForSpawn();
    expect(skill?.endsWith('skills/demo')).toBe(true);
    const [server] = service.mcpServersForSpawn();
    expect(server).toMatchObject({
      name: 'plugin-example-demo-srv',
      transport: 'stdio',
      command: 'node',
      env: {
        MODE: 'x',
        ENSO_PLUGIN_ROOT: expect.stringContaining(join(root, 'packages', 'example.demo')),
      },
    });
    expect(server?.args?.[0]).toMatch(/packages\/example\.demo\/[^/]+\/server\.js$/);
  });

  it('预设点名的 skill、MCP 和 workflow 只在选中该预设时下发，并读出角色与指令', async () => {
    await install({
      'enso-plugin.json': manifest({
        permissions: ['agent.tool', 'mcp.server'],
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          skills: ['skills/always', 'skills/review'],
          workflows: ['workflows/always.js', 'workflows/review.js'],
          mcpServers: [
            { name: 'always', command: 'node', args: ['a.js'] },
            { name: 'review', command: 'node', args: ['b.js'] },
          ],
          presets: [
            {
              id: 'review',
              name: 'Review',
              skills: ['skills/review'],
              mcpServers: ['review'],
              workflows: ['workflows/review.js'],
              instruction: 'prompts/instruction.md',
              systemPrompt: 'prompts/role.md',
              systemPromptTail: 'prompts/tail.md',
              boostPrompt: 'prompts/boost.md',
              refusalRetry: true,
              refusalRetryPrompt: 'prompts/retry.md',
            },
          ],
        },
      }),
      'main.mjs': mainJs,
      'skills/always/SKILL.md': '# always',
      'skills/review/SKILL.md': '# review',
      'workflows/always.js': '',
      'workflows/review.js': '',
      'a.js': '',
      'b.js': '',
      'prompts/instruction.md': 'do this',
      'prompts/role.md': 'you are a reviewer',
      'prompts/tail.md': 'tail',
      'prompts/boost.md': 'boost',
      'prompts/retry.md': 'retry',
    });
    await service.setEnabled('example.demo', true);
    const ends = (paths: string[], name: string) => paths.some((path) => path.endsWith(name));
    expect(ends(service.skillPathsForSpawn(), 'skills/always')).toBe(true);
    expect(ends(service.skillPathsForSpawn(), 'skills/review')).toBe(false);
    expect(service.workflowPathsForSpawn().map((path) => basename(path))).toEqual(['always.js']);
    expect(service.mcpServersForSpawn().map((server) => server.name)).toEqual([
      'plugin-example-demo-always',
    ]);
    const id = 'plugin:example.demo:review';
    expect(ends(service.skillPathsForSpawn(id), 'skills/always')).toBe(true);
    expect(ends(service.skillPathsForSpawn(id), 'skills/review')).toBe(true);
    expect(service.workflowPathsForSpawn(id).map((path) => basename(path))).toEqual([
      'always.js',
      'review.js',
    ]);
    expect(service.mcpServersForSpawn(id).map((server) => server.name)).toEqual([
      'plugin-example-demo-always',
      'plugin-example-demo-review',
    ]);
    expect(service.presetForSpawn(id)).toMatchObject({
      ok: true,
      instruction: { content: 'do this' },
      systemPrompt: 'you are a reviewer',
      systemPromptAppend: 'tail',
      systemPromptBoost: 'boost',
      refusalRetryPrompt: 'retry',
    });
    expect(service.presetForSpawn('plugin:example.demo:missing')?.ok).toBe(false);
    expect(service.presetForSpawn('user-preset')).toBeUndefined();
    expect(service.list()[0]?.presets).toEqual([
      { id, name: 'Review', skills: 1, mcpServers: 1, instruction: true },
    ]);
  });

  describe('子代理类型', () => {
    const noClaude = { skillPaths: [], commands: [], agents: [], mcpServers: [], hooks: [] };
    const files = () => ({
      'enso-plugin.json': manifest({
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          skills: ['skills/review'],
          agentTypes: [
            {
              name: 'demo:reviewer',
              description: '只读审查',
              systemPrompt: 'agents/reviewer.md',
              tools: 'readonly',
              skills: ['skills/review'],
            },
            { name: 'worker-x', description: '全权', systemPrompt: 'agents/worker.md' },
          ],
        },
      }),
      'main.mjs': mainJs,
      'skills/review/SKILL.md': '# review',
      'agents/reviewer.md': 'you review',
      'agents/worker.md': 'you work',
    });
    afterEach(() => setNativeAgentTypeSource(null));

    it('启用后读出正文与技能目录，停用或卸载后立刻从 agentTypes 消失', async () => {
      await install(files());
      setNativeAgentTypeSource(service.agentTypeSource());
      const names = () => withPluginAgentTypes([], undefined, noClaude).map((t) => t.name);
      expect(service.agentTypesForSpawn()).toEqual([]);
      expect(names()).toEqual([]);

      await service.setEnabled('example.demo', true);
      const [reviewer, worker] = service.agentTypesForSpawn();
      expect(reviewer).toMatchObject({
        pluginId: 'example.demo',
        name: 'demo:reviewer',
        description: '只读审查',
        systemPrompt: 'you review',
        tools: 'readonly',
      });
      expect(reviewer?.skillPaths).toHaveLength(1);
      expect(reviewer?.skillPaths[0]).toMatch(/packages\/example\.demo\/[^/]+\/skills\/review$/);
      expect(worker).toMatchObject({ name: 'worker-x', tools: 'all', skillPaths: [] });
      const merged = withPluginAgentTypes([], undefined, noClaude);
      expect(merged.map((t) => t.name)).toEqual(['demo:reviewer', 'worker-x']);
      expect(merged[0]?.pluginSkillPaths).toEqual(reviewer?.skillPaths);

      await service.setEnabled('example.demo', false);
      expect(names()).toEqual([]);

      await service.setEnabled('example.demo', true);
      expect(names()).toEqual(['demo:reviewer', 'worker-x']);
      await service.uninstall('example.demo');
      expect(names()).toEqual([]);
    });

    it('正文读不出的类型跳过并记日志；被重名丢弃的类型记一次日志', async () => {
      await install(files());
      await service.setEnabled('example.demo', true);
      const pkg = service.agentTypesForSpawn()[0]?.skillPaths[0]?.replace(/skills\/review$/, '');
      rmSync(join(pkg as string, 'agents', 'worker.md'));
      expect(service.agentTypesForSpawn().map((t) => t.name)).toEqual([
        'demo:reviewer',
        'worker-x',
      ]);
      const refreshed = await service.restage('example.demo');
      if (!refreshed.ok) throw new Error(refreshed.error);
      expect(service.agentTypesForSpawn().map((t) => t.name)).toEqual(['demo:reviewer']);
      expect(await service.logs('example.demo')).toContain('worker-x');

      setNativeAgentTypeSource(service.agentTypeSource());
      const user = {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'demo:reviewer',
        description: 'mine',
        systemPrompt: 'mine',
        tools: 'all' as const,
      };
      withPluginAgentTypes([user], undefined, noClaude);
      withPluginAgentTypes([user], undefined, noClaude);
      const hits = (await service.logs('example.demo'))
        .split('\n')
        .filter((l) => l.includes('同名'));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('demo:reviewer');
    });

    it('被插件预设圈定的类型只在该预设生效时下发给会话，全局列表照常列出', async () => {
      const scoped = JSON.parse(files()['enso-plugin.json']);
      scoped.contributes.presets = [{ id: 'mode', name: 'Mode', agentTypes: ['demo:reviewer'] }];
      await install({ ...files(), 'enso-plugin.json': JSON.stringify(scoped) });
      await service.setEnabled('example.demo', true);
      const names = (activePresetId?: string) =>
        service.agentTypesForSpawn({ activePresetId }).map((t) => t.name);
      expect(names()).toEqual(['worker-x']);
      expect(names('user-preset')).toEqual(['worker-x']);
      expect(names('plugin:example.demo:mode')).toEqual(['demo:reviewer', 'worker-x']);
      expect(service.agentTypesForSpawn().map((t) => t.name)).toEqual([
        'demo:reviewer',
        'worker-x',
      ]);
    });
  });

  it('处理器上下文带上 Main 推导的项目根', async () => {
    await install({
      'enso-plugin.json': manifest(),
      'main.mjs': `export function activate(enso) { enso.tools.register('lookup', async (args, ctx) => String(ctx.projectRoot)); }`,
    });
    await service.setEnabled('example.demo', true);
    await expect(
      service.callTool({
        toolName: 'plugin_example-demo__lookup',
        args: {},
        sessionId: 's1',
        projectRoot: '/work/repo',
      })
    ).resolves.toEqual({ content: '/work/repo', artifacts: [] });
  });

  describe('配置项', () => {
    const configManifest = () =>
      manifest({
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          configuration: [
            { key: 'baseUrl', title: '地址' },
            { key: 'token', title: 'Token', secret: true },
          ],
        },
      });
    const readsConfig = `export function activate(enso) { enso.tools.register('lookup', async () => JSON.stringify(await enso.config.get())); }`;

    it('停用状态也能配置；密钥不回显，只告诉界面是否已设置', async () => {
      await install({ 'enso-plugin.json': configManifest(), 'main.mjs': readsConfig });
      expect(
        await service.setConfig('example.demo', { baseUrl: 'https://x', token: 'sk-1' })
      ).toEqual({
        ok: true,
      });
      expect(service.configView('example.demo')).toEqual({
        ok: true,
        fields: [
          {
            key: 'baseUrl',
            title: '地址',
            description: '',
            secret: false,
            type: 'string',
            set: true,
            value: 'https://x',
          },
          {
            key: 'token',
            title: 'Token',
            description: '',
            secret: true,
            type: 'string',
            set: true,
          },
        ],
      });
      const file = join(root, 'config', 'example.demo.json');
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('插件进程经 config.get 读到完整配置', async () => {
      await install({ 'enso-plugin.json': configManifest(), 'main.mjs': readsConfig });
      await service.setConfig('example.demo', { baseUrl: 'https://x', token: 'sk-1' });
      await service.setEnabled('example.demo', true);
      const result = await service.callTool({
        toolName: 'plugin_example-demo__lookup',
        args: {},
        sessionId: 's1',
        projectRoot: null,
      });
      expect(JSON.parse(result.content)).toEqual({ baseUrl: 'https://x', token: 'sk-1' });
    });

    it('省略的键保持不变，null 清除；未知键与过长值拒绝', async () => {
      await install({ 'enso-plugin.json': configManifest(), 'main.mjs': readsConfig });
      await service.setConfig('example.demo', { baseUrl: 'https://x', token: 'sk-1' });
      await service.setConfig('example.demo', { baseUrl: 'https://y' });
      expect(service.configValues('example.demo')).toEqual({ baseUrl: 'https://y', token: 'sk-1' });
      await service.setConfig('example.demo', { token: null });
      expect(service.configValues('example.demo')).toEqual({ baseUrl: 'https://y' });
      expect((await service.setConfig('example.demo', { other: 'x' })).ok).toBe(false);
      expect((await service.setConfig('example.demo', { baseUrl: 'x'.repeat(5000) })).ok).toBe(
        false
      );
      expect((await service.setConfig('missing.plugin', { baseUrl: 'x' })).ok).toBe(false);
    });

    it('卸载时删除配置文件', async () => {
      await install({ 'enso-plugin.json': configManifest(), 'main.mjs': readsConfig });
      await service.setConfig('example.demo', { token: 'sk-1' });
      await service.uninstall('example.demo');
      expect(existsSync(join(root, 'config', 'example.demo.json'))).toBe(false);
    });
  });
});

class HoldChild extends EventEmitter {
  pid = 1;
  private handler: (m: unknown) => void = () => {};
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
  start() {
    runPluginHost({
      send: (m) => queueMicrotask(() => this.emit('message', m)),
      onMessage: (h) => {
        this.handler = h;
      },
    });
    queueMicrotask(() => this.emit('spawn'));
  }
}

class ExitOnSpawn extends EventEmitter {
  pid = 1;
  postMessage(): void {}
  kill(): boolean {
    return true;
  }
  constructor() {
    super();
    queueMicrotask(() => {
      this.emit('spawn');
      this.emit('exit', 1);
    });
  }
}

const gate = {
  fetch: vi.fn(),
  notify: () => true,
  composer: async () => null,
  mcpTools: async () => [],
  mcpCall: async () => ({ content: '', isError: false }),
  now: () => Date.now(),
};

function bootService(dir: string, fork: () => unknown) {
  return new ExtensionPluginService({
    root: dir,
    hostVersion: '0.2.12',
    hostPath: '/unused',
    env: {},
    fork: fork as never,
    gate,
  });
}

async function stageCommit(svc: ExtensionPluginService, files: Record<string, string>) {
  const preview = await svc.stage({ kind: 'dir', path: writePlugin(files) });
  if (!preview.ok) throw new Error(preview.error);
  const committed = await svc.commit(preview.preview.token);
  if (!committed.ok) throw new Error(committed.error);
  return preview.preview;
}

describe('插件运行期收敛', () => {
  const obs = () =>
    ((globalThis as { __ensoObs?: { hits: unknown[]; wait: Promise<void> | null } }).__ensoObs ??= {
      hits: [],
      wait: null,
    });

  afterEach(() => {
    delete (globalThis as { __ensoObs?: unknown }).__ensoObs;
  });

  it('变更通知合并为一次，安静约 150ms 后才推给界面', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    const changed = vi.fn();
    service.onChange(changed);
    await service.setEnabled('example.demo', true);
    await service.setEnabled('example.demo', false);
    await service.setEnabled('example.demo', true);
    expect(changed).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  });

  it('非常驻且进程没在跑时不投递通知；在跑或常驻则投递', async () => {
    const dir = temp('observe-');
    let forks = 0;
    const svc = bootService(dir, () => {
      forks += 1;
      return new InProcessChild();
    });
    const observeMain = `export function activate(enso) {
      enso.tools.register('lookup', async () => 'ok');
      enso.events.on('session_start', (data) => { globalThis.__ensoObs.hits.push(data.reason); });
    }`;
    await stageCommit(svc, {
      'enso-plugin.json': manifest({
        permissions: ['agent.tool', 'agent.observe'],
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          events: [{ event: 'session_start', mode: 'observe' }],
        },
      }),
      'main.mjs': observeMain,
    });
    await svc.setEnabled('example.demo', true);
    const parked = forks;
    await svc.dispatchEvent({
      sessionId: 's',
      projectRoot: null,
      event: 'session_start',
      data: { reason: 'startup' },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(forks).toBe(parked);
    expect(obs().hits).toEqual([]);
    await svc.callTool({
      toolName: 'plugin_example-demo__lookup',
      args: {},
      sessionId: 's',
      projectRoot: null,
    });
    await svc.dispatchEvent({
      sessionId: 's',
      projectRoot: null,
      event: 'session_start',
      data: { reason: 'startup' },
    });
    await vi.waitFor(() => expect(obs().hits).toEqual(['startup']));
    expect(forks).toBe(parked + 1);

    const residentDir = temp('resident-');
    let residentForks = 0;
    const resident = bootService(residentDir, () => {
      residentForks += 1;
      return new InProcessChild();
    });
    obs().hits = [];
    await stageCommit(resident, {
      'enso-plugin.json': manifest({
        id: 'example.resident',
        name: 'Resident',
        resident: true,
        permissions: ['agent.observe', 'process.background'],
        contributes: { events: [{ event: 'session_start', mode: 'observe' }] },
      }),
      'main.mjs': `export function activate(enso) {
        enso.events.on('session_start', (data) => { globalThis.__ensoObs.hits.push(data.reason); });
      }`,
    });
    await resident.setEnabled('example.resident', true);
    const before = residentForks;
    await resident.dispatchEvent({
      sessionId: 's',
      projectRoot: null,
      event: 'session_start',
      data: { reason: 'startup' },
    });
    await vi.waitFor(() => expect(obs().hits).toEqual(['startup']));
    expect(residentForks).toBe(before + 1);
  });

  it('更新常驻插件时等旧进程真正退出再拉起新进程', async () => {
    const dir = temp('resident-swap-');
    const events: string[] = [];
    let seq = 0;
    class SlowExitChild extends EventEmitter {
      pid = ++seq;
      private exited = false;
      constructor() {
        super();
        events.push(`fork:${this.pid}`);
        queueMicrotask(() => this.emit('spawn'));
      }
      postMessage(message: unknown) {
        const kind =
          typeof message === 'object' && message !== null && 't' in message
            ? String((message as { t?: unknown }).t)
            : '';
        queueMicrotask(() => {
          if (kind === 'init') {
            this.emit('message', {
              t: 'ready',
              registered: { tools: [], commands: [], triggers: [], rendererMethods: [] },
            });
          }
          if (kind === 'shutdown') {
            events.push(`shutdown:${this.pid}`);
            setTimeout(() => {
              if (this.exited) return;
              this.exited = true;
              events.push(`exit:${this.pid}`);
              this.emit('exit', 0);
            }, 40);
          }
        });
      }
      kill() {
        return true;
      }
    }
    const svc = bootService(dir, () => new SlowExitChild() as never);
    const resident = {
      id: 'example.resident',
      name: 'Resident',
      resident: true,
      permissions: ['process.background'],
      contributes: {},
    };
    try {
      await stageCommit(svc, {
        'enso-plugin.json': manifest(resident),
        'main.mjs': 'export function activate() {}',
      });
      await svc.setEnabled('example.resident', true);
      svc.startBackground();
      await vi.waitFor(() => expect(svc.hasRunningPlugins()).toBe(true));
      const live = seq;
      const mark = events.length;
      const updating = stageCommit(svc, {
        'enso-plugin.json': manifest({ ...resident, version: '1.1.0' }),
        'main.mjs': 'export function activate() {}',
      });
      const since = () => events.slice(mark);
      await vi.waitFor(() => expect(since()).toContain(`shutdown:${live}`));
      await vi.waitFor(() =>
        expect(
          since().some(
            (item, index) => index > since().indexOf(`shutdown:${live}`) && item.startsWith('fork:')
          )
        ).toBe(true)
      );
      const shutdownAt = since().indexOf(`shutdown:${live}`);
      const exitAt = since().indexOf(`exit:${live}`);
      const forkAfter = since().findIndex(
        (item, index) => index > shutdownAt && item.startsWith('fork:')
      );
      expect(exitAt).toBeGreaterThan(shutdownAt);
      expect(forkAfter).toBeGreaterThan(exitAt);
      await updating;
    } finally {
      await svc.dispose();
    }
  });

  it('同一插件同一通知事件同时只投递一次，后来的只保留最新一条', async () => {
    const dir = temp('coalesce-');
    const svc = bootService(dir, () => new InProcessChild());
    let release: (() => void) | undefined;
    obs().wait = new Promise((resolve) => {
      release = resolve;
    });
    await stageCommit(svc, {
      'enso-plugin.json': manifest({
        permissions: ['agent.tool', 'agent.observe'],
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          events: [{ event: 'tool_result', mode: 'observe' }],
        },
      }),
      'main.mjs': `export function activate(enso) {
        enso.tools.register('lookup', async () => 'ok');
        enso.events.on('tool_result', async (data) => {
          const gate = globalThis.__ensoObs.wait;
          globalThis.__ensoObs.hits.push(data.seq);
          if (gate) await gate;
        });
      }`,
    });
    await svc.setEnabled('example.demo', true);
    await svc.callTool({
      toolName: 'plugin_example-demo__lookup',
      args: {},
      sessionId: 's',
      projectRoot: null,
    });
    const send = (seq: number) =>
      svc.dispatchEvent({
        sessionId: 's',
        projectRoot: null,
        event: 'tool_result',
        data: { seq },
      });
    void send(1);
    await vi.waitFor(() => expect(obs().hits).toEqual([1]));
    void send(2);
    void send(3);
    obs().wait = null;
    release?.();
    await vi.waitFor(() => expect(obs().hits).toEqual([1, 3]));
  });

  it('生命周期通知按会话顺序进入有界队列，不同会话和子代理互不覆盖', async () => {
    const dir = temp('lane-');
    const svc = bootService(dir, () => new InProcessChild());
    let release: (() => void) | undefined;
    obs().wait = new Promise((resolve) => {
      release = resolve;
    });
    const agent = (name: string) => ({
      kind: 'subagent' as const,
      sessionId: `s::${name}`,
      name,
    });
    await stageCommit(svc, {
      'enso-plugin.json': manifest({
        permissions: ['agent.tool', 'agent.observe'],
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          events: [{ event: 'session_end', mode: 'observe' }],
        },
      }),
      'main.mjs': `export function activate(enso) {
        enso.tools.register('lookup', async () => 'ok');
        enso.events.on('session_end', async (data, ctx) => {
          globalThis.__ensoObs.hits.push('end:' + data.reason + ':' + (ctx.agent?.name ?? data.sessionId));
          const gate = globalThis.__ensoObs.wait;
          if (gate) await gate;
        });
      }`,
    });
    await svc.setEnabled('example.demo', true);
    await svc.callTool({
      toolName: 'plugin_example-demo__lookup',
      args: {},
      sessionId: 's',
      projectRoot: null,
    });
    const end = (sessionId: string, reason: string, child?: ReturnType<typeof agent>) =>
      svc.dispatchEvent({
        sessionId,
        projectRoot: null,
        event: 'session_end',
        data: { reason, sessionId },
        ...(child ? { agent: child } : {}),
      });
    void end('s', '1');
    await vi.waitFor(() => expect(obs().hits).toEqual(['end:1:s']));
    void end('s', '2');
    void end('s', '3');
    void end('other', '9');
    void end('s', 'child-a', agent('alpha'));
    void end('s', 'child-b', agent('beta'));
    for (let n = 4; n <= 36; n++) void end('s', String(n));
    obs().wait = null;
    release?.();
    await vi.waitFor(() => expect(obs().hits).toContain('end:36:s'));
    const ends = obs().hits.filter(
      (hit): hit is string => typeof hit === 'string' && hit.startsWith('end:')
    );
    expect(ends).toContain('end:1:s');
    expect(ends).toContain('end:10:s');
    expect(ends).toContain('end:9:other');
    expect(ends).toContain('end:child-a:alpha');
    expect(ends).toContain('end:child-b:beta');
    expect(ends).not.toContain('end:2:s');
    const sameSession = ends.filter((hit) => /^end:\d+:s$/.test(hit));
    expect(sameSession).toEqual(
      [...sameSession].sort((a, b) => Number(a.split(':')[1]) - Number(b.split(':')[1]))
    );
  });

  it('tool_result 只在同一会话内合并，别的会话仍会送达', async () => {
    const dir = temp('coalesce-session-');
    const svc = bootService(dir, () => new InProcessChild());
    let release: (() => void) | undefined;
    obs().wait = new Promise((resolve) => {
      release = resolve;
    });
    await stageCommit(svc, {
      'enso-plugin.json': manifest({
        permissions: ['agent.tool', 'agent.observe'],
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          events: [{ event: 'tool_result', mode: 'observe' }],
        },
      }),
      'main.mjs': `export function activate(enso) {
        enso.tools.register('lookup', async () => 'ok');
        enso.events.on('tool_result', async (data) => {
          globalThis.__ensoObs.hits.push(data.seq + ':' + data.sessionId);
          const gate = globalThis.__ensoObs.wait;
          if (gate) await gate;
        });
      }`,
    });
    await svc.setEnabled('example.demo', true);
    await svc.callTool({
      toolName: 'plugin_example-demo__lookup',
      args: {},
      sessionId: 's',
      projectRoot: null,
    });
    const send = (sessionId: string, seq: number) =>
      svc.dispatchEvent({
        sessionId,
        projectRoot: null,
        event: 'tool_result',
        data: { seq, sessionId },
      });
    void send('s', 1);
    await vi.waitFor(() => expect(obs().hits).toEqual(['1:s']));
    void send('s', 2);
    void send('s', 3);
    void send('other', 7);
    obs().wait = null;
    release?.();
    await vi.waitFor(() => expect(obs().hits).toContain('7:other'));
    expect(obs().hits).toContain('3:s');
    expect(obs().hits).not.toContain('2:s');
  });

  it('dispose 后不再通知监听方，常驻插件的排队通知也不会再拉起进程', async () => {
    const dir = temp('dispose-obs-');
    let forks = 0;
    const svc = bootService(dir, () => {
      forks += 1;
      return new InProcessChild();
    });
    let release: (() => void) | undefined;
    obs().wait = new Promise((resolve) => {
      release = resolve;
    });
    await stageCommit(svc, {
      'enso-plugin.json': manifest({
        id: 'example.resident',
        name: 'Resident',
        resident: true,
        permissions: ['agent.tool', 'agent.observe', 'process.background'],
        contributes: {
          dynamic: { tools: 1 },
          events: [{ event: 'session_end', mode: 'observe' }],
        },
      }),
      'main.mjs': `export async function activate(enso) {
        await enso.tools.register('extra', async () => 'x', {
          description: 'extra',
          parameters: { type: 'object' },
        });
        enso.events.on('session_end', async (data) => {
          globalThis.__ensoObs.hits.push(data.reason);
          const gate = globalThis.__ensoObs.wait;
          if (gate) await gate;
        });
      }`,
    });
    const changed = vi.fn();
    svc.onChange(changed);
    await svc.setEnabled('example.resident', true);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    changed.mockClear();
    const send = (reason: string) =>
      svc.dispatchEvent({
        sessionId: 's',
        projectRoot: null,
        event: 'session_end',
        data: { reason },
      });
    void send('first');
    await vi.waitFor(() => expect(obs().hits).toEqual(['first']));
    const forksAfterStart = forks;
    changed.mockClear();
    void send('second');
    await svc.dispose();
    obs().wait = null;
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changed).not.toHaveBeenCalled();
    expect(forks).toBe(forksAfterStart);
    expect(obs().hits).not.toContain('second');
  });

  it('进程退出后动态工具会重新拉起再查找，没注册才是 NOT_FOUND', async () => {
    const dir = temp('dyn-');
    const kids: InProcessChild[] = [];
    const svc = bootService(dir, () => {
      const child = new InProcessChild();
      kids.push(child);
      return child;
    });
    await stageCommit(svc, {
      'enso-plugin.json': manifest({
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          dynamic: { tools: 2 },
        },
      }),
      'main.mjs': `export async function activate(enso) {
        enso.tools.register('lookup', async () => 'static');
        await enso.tools.register('extra', async () => 'dyn', {
          description: 'extra',
          parameters: { type: 'object' },
        });
      }`,
    });
    await svc.setEnabled('example.demo', true);
    const call = (name: string) =>
      svc.callTool({
        toolName: name,
        args: {},
        sessionId: 's',
        projectRoot: null,
      });
    await expect(call('plugin_example-demo__extra')).resolves.toMatchObject({ content: 'dyn' });
    const forks = kids.length;
    kids.at(-1)?.emit('exit', 1);
    await expect(call('plugin_example-demo__extra')).resolves.toMatchObject({ content: 'dyn' });
    expect(kids.length).toBe(forks + 1);
    await expect(call('plugin_example-demo__missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const plainDir = temp('plain-');
    let plainForks = 0;
    const plain = bootService(plainDir, () => {
      plainForks += 1;
      return new InProcessChild();
    });
    await stageCommit(plain, { 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    await plain.setEnabled('example.demo', true);
    const afterInstall = plainForks;
    await expect(
      plain.callTool({
        toolName: 'plugin_example-demo__missing',
        args: {},
        sessionId: 's',
        projectRoot: null,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(plainForks).toBe(afterInstall);
  });

  it('同一次初始化失败只记一次崩溃，两次失败不会熔断', async () => {
    const dir = temp('crash-');
    let spawned = 0;
    const svc = bootService(dir, () => {
      spawned += 1;
      return (spawned === 1 ? new InProcessChild() : new ExitOnSpawn()) as never;
    });
    await stageCommit(svc, { 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    await svc.setEnabled('example.demo', true);
    const call = () =>
      svc.callTool({
        toolName: 'plugin_example-demo__lookup',
        args: {},
        sessionId: 's',
        projectRoot: null,
      });
    await expect(call()).rejects.toBeTruthy();
    await expect(call()).rejects.toBeTruthy();
    expect(svc.list()[0]?.state).toBe('enabled');
    await expect(call()).rejects.toBeTruthy();
    expect(svc.list()[0]?.state).toBe('crashed');
  });

  it('拉起动态工具失败会被记住并计入崩溃，重新启用或 restage 后才再试', async () => {
    const dir = temp('prepare-');
    const src = writePlugin({
      'enso-plugin.json': manifest({
        contributes: {
          dynamic: { tools: 1 },
        },
      }),
      'main.mjs': 'export function activate() {}',
    });
    let spawned = 0;
    const svc = bootService(dir, () => {
      spawned += 1;
      return (spawned === 1 ? new InProcessChild() : new ExitOnSpawn()) as never;
    });
    const staged = await svc.stage({ kind: 'dir', path: src });
    if (!staged.ok) throw new Error(staged.error);
    const committed = await svc.commit(staged.preview.token);
    if (!committed.ok) throw new Error(committed.error);
    await svc.setEnabled('example.demo', true);
    const afterInstall = spawned;
    await svc.prepareForSpawn();
    expect(spawned).toBe(afterInstall + 1);
    expect(svc.list()[0]?.state).toBe('enabled');
    await svc.prepareForSpawn();
    expect(spawned).toBe(afterInstall + 1);
    await svc.setEnabled('example.demo', false);
    await svc.setEnabled('example.demo', true);
    await svc.prepareForSpawn();
    expect(spawned).toBe(afterInstall + 2);
    await svc.restage('example.demo');
    await svc.prepareForSpawn();
    expect(spawned).toBe(afterInstall + 3);
    expect(svc.list()[0]?.state).toBe('crashed');
  });

  it('动态工具冷启动超时不计崩溃，就绪后清掉失败缓存', async () => {
    const dir = temp('prepare-slow-');
    const children: HoldChild[] = [];
    let spawned = 0;
    let fast = false;
    const svc = new ExtensionPluginService({
      root: dir,
      hostVersion: '0.2.12',
      hostPath: '/unused',
      env: {},
      prepareTimeoutMs: 30,
      fork: (() => {
        spawned += 1;
        if (spawned === 1 || fast) return new InProcessChild();
        const child = new HoldChild();
        children.push(child);
        return child;
      }) as never,
      gate,
    });
    await stageCommit(svc, {
      'enso-plugin.json': manifest({
        contributes: { dynamic: { tools: 1 } },
      }),
      'main.mjs': `export async function activate(enso) {
        await enso.tools.register('extra', async () => 'dyn', {
          description: 'extra',
          parameters: { type: 'object' },
        });
      }`,
    });
    await svc.setEnabled('example.demo', true);
    const hasExtra = () => svc.toolsForSpawn().some((tool) => tool.name.endsWith('extra'));
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        await svc.setEnabled('example.demo', false);
        await svc.setEnabled('example.demo', true);
      }
      await svc.prepareForSpawn();
      expect(svc.list()[0]?.state).toBe('enabled');
      children[i]?.start();
      await vi.waitFor(() => expect(hasExtra()).toBe(true));
    }
    const running = children[2];
    if (!running) throw new Error('no child');
    const before = spawned;
    running.emit('exit', 1);
    await vi.waitFor(() => expect(hasExtra()).toBe(false));
    fast = true;
    await svc.prepareForSpawn();
    expect(spawned).toBe(before + 1);
    await vi.waitFor(() => expect(hasExtra()).toBe(true));
    expect(svc.list()[0]?.state).toBe('enabled');
  });

  it('提交试加载未完成时卸载会等待，登记不会指向已删除的目录', async () => {
    const dir = temp('lock-');
    const src = writePlugin({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    let holdNext = false;
    let hold: HoldChild | null = null;
    const svc = bootService(dir, () => {
      if (!holdNext) return new InProcessChild();
      hold = new HoldChild();
      return hold;
    });
    const first = await svc.stage({ kind: 'dir', path: src });
    if (!first.ok) throw new Error(first.error);
    const committed = await svc.commit(first.preview.token);
    if (!committed.ok) throw new Error(committed.error);
    writeFileSync(join(src, 'enso-plugin.json'), manifest({ version: '1.1.0' }));
    const again = await svc.stage({ kind: 'dir', path: src });
    if (!again.ok) throw new Error(again.error);
    holdNext = true;
    const committing = svc.commit(again.preview.token);
    await vi.waitFor(() => expect(hold).not.toBeNull());
    let uninstallDone = false;
    const uninstalling = svc.uninstall('example.demo').then((result) => {
      uninstallDone = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(uninstallDone).toBe(false);
    expect(readRegistry(dir).plugins).toHaveLength(1);
    (hold as HoldChild | null)?.start();
    await expect(committing).resolves.toMatchObject({ ok: true });
    await expect(uninstalling).resolves.toMatchObject({ ok: true });
    expect(readRegistry(dir).plugins).toEqual([]);
    expect(existsSync(join(dir, 'packages', 'example.demo'))).toBe(false);
  });

  it('启用、改配置和拒绝更新会等到同一插件的提交结束', async () => {
    const dir = temp('lock-admin-');
    const withConfig = (patch: Record<string, unknown> = {}) =>
      manifest({
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          configuration: [{ key: 'baseUrl', title: '地址' }],
        },
        ...patch,
      });
    const src = writePlugin({ 'enso-plugin.json': withConfig(), 'main.mjs': mainJs });
    let holdNext = false;
    let hold: HoldChild | null = null;
    const svc = bootService(dir, () => {
      if (!holdNext) return new InProcessChild();
      hold = new HoldChild();
      return hold;
    });
    const first = await svc.stage({ kind: 'dir', path: src });
    if (!first.ok) throw new Error(first.error);
    const committed = await svc.commit(first.preview.token);
    if (!committed.ok) throw new Error(committed.error);
    await Promise.resolve(svc.setEnabled('example.demo', true));
    writeFileSync(
      join(src, 'enso-plugin.json'),
      withConfig({
        version: '2.0.0',
        permissions: ['agent.tool', 'net.fetch'],
        net: { domains: ['api.example.com'] },
      })
    );
    const again = await svc.stage({ kind: 'dir', path: src });
    if (!again.ok) throw new Error(again.error);
    holdNext = true;
    const committing = svc.commit(again.preview.token);
    await vi.waitFor(() => expect(hold).not.toBeNull());
    let enabledDone = false;
    const enabling = Promise.resolve(svc.setEnabled('example.demo', false)).then((result) => {
      enabledDone = true;
      return result;
    });
    let configDone = false;
    const configuring = svc
      .setConfig('example.demo', { baseUrl: 'https://locked.example' })
      .then((result) => {
        configDone = true;
        return result;
      });
    let rejectDone = false;
    const rejecting = Promise.resolve(svc.rejectPending('example.demo')).then((result) => {
      rejectDone = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(enabledDone).toBe(false);
    expect(configDone).toBe(false);
    expect(rejectDone).toBe(false);
    expect(readRegistry(dir).plugins[0]?.state).toBe('enabled');
    expect(existsSync(join(dir, 'config', 'example.demo.json'))).toBe(false);
    (hold as HoldChild | null)?.start();
    await expect(committing).resolves.toMatchObject({ ok: true });
    await expect(enabling).resolves.toMatchObject({ ok: true });
    await expect(configuring).resolves.toMatchObject({ ok: true });
    await expect(rejecting).resolves.toMatchObject({ ok: true });
    expect(readRegistry(dir).plugins[0]).toMatchObject({ version: '1.0.0', state: 'disabled' });
    expect(readRegistry(dir).plugins[0]?.pending).toBeUndefined();
    expect(svc.configValues('example.demo')).toEqual({ baseUrl: 'https://locked.example' });
  });

  it('同意待授权更新也会等到提交结束', async () => {
    const dir = temp('lock-approve-');
    const src = writePlugin({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    let holdNext = false;
    let hold: HoldChild | null = null;
    const svc = bootService(dir, () => {
      if (!holdNext) return new InProcessChild();
      hold = new HoldChild();
      return hold;
    });
    const first = await svc.stage({ kind: 'dir', path: src });
    if (!first.ok) throw new Error(first.error);
    if (!(await svc.commit(first.preview.token)).ok) throw new Error('commit');
    writeFileSync(
      join(src, 'enso-plugin.json'),
      manifest({
        version: '2.0.0',
        permissions: ['agent.tool', 'net.fetch'],
        net: { domains: ['api.example.com'] },
      })
    );
    const again = await svc.stage({ kind: 'dir', path: src });
    if (!again.ok) throw new Error(again.error);
    holdNext = true;
    const committing = svc.commit(again.preview.token);
    await vi.waitFor(() => expect(hold).not.toBeNull());
    let approved = false;
    const approving = Promise.resolve(svc.approvePending('example.demo')).then((result) => {
      approved = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(approved).toBe(false);
    expect(readRegistry(dir).plugins[0]?.version).toBe('1.0.0');
    (hold as HoldChild | null)?.start();
    await expect(committing).resolves.toMatchObject({ ok: true });
    await expect(approving).resolves.toMatchObject({ ok: true });
    expect(readRegistry(dir).plugins[0]?.version).toBe('2.0.0');
    expect(readRegistry(dir).plugins[0]?.pending).toBeUndefined();
  });

  it('拒绝待授权更新时清掉清单、正文和失败缓存', async () => {
    const dir = temp('reject-cache-');
    let failPrepare = false;
    let spawned = 0;
    const svc = bootService(dir, () => {
      spawned += 1;
      return (failPrepare ? new ExitOnSpawn() : new InProcessChild()) as never;
    });
    const body = (version: string, expands: boolean) =>
      manifest({
        version,
        ...(expands
          ? { permissions: ['agent.tool', 'net.fetch'], net: { domains: ['api.example.com'] } }
          : {}),
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          dynamic: { tools: 1 },
          agentTypes: [
            { name: 'demo:reviewer', description: '审查', systemPrompt: 'agents/reviewer.md' },
          ],
        },
      });
    const src = writePlugin({
      'enso-plugin.json': body('1.0.0', false),
      'main.mjs': `export async function activate(enso) {
        enso.tools.register('lookup', async () => 'ok');
        await enso.tools.register('extra', async () => 'dyn', {
          description: 'extra',
          parameters: { type: 'object' },
        });
      }`,
      'agents/reviewer.md': 'version-one',
    });
    const staged = await svc.stage({ kind: 'dir', path: src });
    if (!staged.ok) throw new Error(staged.error);
    if (!(await svc.commit(staged.preview.token)).ok) throw new Error('commit');
    await svc.setEnabled('example.demo', true);
    expect(svc.agentTypesForSpawn()[0]?.systemPrompt).toBe('version-one');
    writeFileSync(join(src, 'agents/reviewer.md'), 'version-pending');
    writeFileSync(join(src, 'enso-plugin.json'), body('2.0.0', true));
    const again = await svc.stage({ kind: 'dir', path: src });
    if (!again.ok) throw new Error(again.error);
    if (!(await svc.commit(again.preview.token)).ok) throw new Error('update');
    const record = readRegistry(dir).plugins[0];
    const pendingDir = record?.pending?.dir;
    if (!record || !pendingDir) throw new Error('no pending');
    expect(svc.agentTypesForSpawn()[0]?.systemPrompt).toBe('version-one');
    writeFileSync(
      join(dir, 'packages', 'example.demo', record.dir, 'agents', 'reviewer.md'),
      'version-two'
    );
    expect(svc.agentTypesForSpawn()[0]?.systemPrompt).toBe('version-one');
    failPrepare = true;
    const before = spawned;
    await svc.prepareForSpawn();
    expect(spawned).toBe(before + 1);
    await svc.prepareForSpawn();
    expect(spawned).toBe(before + 1);
    await svc.rejectPending('example.demo');
    expect(existsSync(join(dir, 'packages', 'example.demo', pendingDir))).toBe(false);
    expect(svc.list()[0]?.pendingVersion).toBeUndefined();
    expect(svc.agentTypesForSpawn()[0]?.systemPrompt).toBe('version-two');
    failPrepare = false;
    await svc.prepareForSpawn();
    expect(spawned).toBe(before + 2);
  });

  it('清单、正文和配置按 id 与目录缓存，写配置或 restage 后失效', async () => {
    await install({
      'enso-plugin.json': manifest({
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          agentTypes: [
            {
              name: 'demo:reviewer',
              description: '审查',
              systemPrompt: 'agents/reviewer.md',
            },
          ],
          configuration: [{ key: 'baseUrl', title: '地址' }],
        },
      }),
      'main.mjs': mainJs,
      'agents/reviewer.md': 'version-one',
    });
    await service.setEnabled('example.demo', true);
    expect(service.agentTypesForSpawn()[0]?.systemPrompt).toBe('version-one');
    const record = readRegistry(root).plugins[0];
    if (!record) throw new Error('no record');
    const prompt = join(root, 'packages', 'example.demo', record.dir, 'agents', 'reviewer.md');
    writeFileSync(prompt, 'version-two');
    expect(service.agentTypesForSpawn()[0]?.systemPrompt).toBe('version-one');
    expect((await service.setConfig('example.demo', { baseUrl: 'https://old' })).ok).toBe(true);
    expect(service.agentTypesForSpawn()[0]?.systemPrompt).toBe('version-two');
    expect(service.configValues('example.demo')).toEqual({ baseUrl: 'https://old' });
    writeFileSync(
      join(root, 'config', 'example.demo.json'),
      JSON.stringify({ baseUrl: 'https://new' })
    );
    expect(service.configValues('example.demo')).toEqual({ baseUrl: 'https://old' });
    const again = await service.restage('example.demo');
    if (!again.ok) throw new Error(again.error);
    expect(service.configValues('example.demo')).toEqual({ baseUrl: 'https://new' });
    expect(service.agentTypesForSpawn()[0]?.systemPrompt).toBe('version-two');

    const dropped = await service.restage('example.demo');
    if (!dropped.ok) throw new Error(dropped.error);
    const manifestPath = join(root, 'packages', 'example.demo', record.dir, 'enso-plugin.json');
    const raw = readFileSync(manifestPath, 'utf8');
    rmSync(manifestPath);
    expect(service.list().map((item) => item.id)).toEqual([]);
    writeFileSync(manifestPath, raw);
    expect(service.list().map((item) => item.id)).toEqual([]);
    const revived = await service.restage('example.demo');
    if (!revived.ok) throw new Error(revived.error);
    expect(service.list().map((item) => item.id)).toEqual(['example.demo']);
  });
});

describe('uiCallTimeout', () => {
  const parsed = {
    contributes: { methods: [{ name: 'enhance', timeoutMs: 90_000 }] },
  } as Parameters<typeof uiCallTimeout>[0];

  it('渲染方法按清单声明的超时，未声明的仍是 2 秒；命令 60 秒', () => {
    expect(uiCallTimeout(parsed, 'renderer.call', { method: 'enhance' })).toBe(90_000);
    expect(uiCallTimeout(parsed, 'renderer.call', { method: 'other' })).toBe(2_000);
    expect(uiCallTimeout(parsed, 'trigger.candidates', { name: 'enhance' })).toBe(2_000);
    expect(uiCallTimeout(parsed, 'command.run', { id: 'x' })).toBe(60_000);
  });
});

describe('丢弃的登记记录', () => {
  const boot = (root: string) =>
    new ExtensionPluginService({
      root,
      hostVersion: '0.2.12',
      hostPath: '/unused',
      env: {},
      fork: (() => new InProcessChild()) as never,
      gate: {
        fetch: vi.fn(),
        notify: () => true,
        composer: async () => null,
        mcpTools: async () => [],
        mcpCall: async () => ({ content: '', isError: false }),
        now: () => Date.now(),
      },
    });
  const seed = (root: string, ids: string[]) => {
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'logs'), { recursive: true });
    for (const id of ids) {
      mkdirSync(join(root, 'packages', id, 'd1'), { recursive: true });
      mkdirSync(join(root, 'data', id), { recursive: true });
      writeFileSync(join(root, 'config', `${id}.json`), '{}');
      writeFileSync(join(root, 'logs', `${id}.log`), 'old');
    }
  };
  const has = (root: string, id: string) => ({
    pkg: existsSync(join(root, 'packages', id)),
    data: existsSync(join(root, 'data', id)),
    config: existsSync(join(root, 'config', `${id}.json`)),
    log: existsSync(join(root, 'logs', `${id}.log`)),
  });
  const all = { pkg: true, data: true, config: true, log: true };
  const none = { pkg: false, data: false, config: false, log: false };

  it('只清理读到并决定丢弃的 id（含日志），没登记的目录只记日志不删', async () => {
    const root = temp('plugins-root-');
    seed(root, ['old.one', 'stray.dir']);
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({ version: 1, plugins: [{ id: 'old.one', dir: 'd1' }] })
    );
    const service = boot(root);
    expect(service.registryNotice()).toEqual({ discarded: ['old.one'] });
    expect(has(root, 'old.one')).toEqual(none);
    expect(has(root, 'stray.dir')).toEqual(all);
    expect(await service.logs('extension-plugins')).toContain('stray.dir');
    expect(readRegistry(root)).toMatchObject({ version: 2, plugins: [], discarded: [] });
  });

  it('丢弃提示落盘，重启后仍在，用户确认或重装后消失', async () => {
    const root = temp('plugins-root-');
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({ version: 1, plugins: [{ id: 'old.one' }, { id: 'old.two' }] })
    );
    boot(root);
    const again = boot(root);
    expect(again.registryNotice()).toEqual({ discarded: ['old.one', 'old.two'] });
    const src = temp('plugin-src-');
    writeFileSync(join(src, 'enso-plugin.json'), manifest({ id: 'old.one' }));
    writeFileSync(join(src, 'main.mjs'), 'export function activate() {}');
    const staged = await again.stage({ kind: 'dir', path: src });
    if (!staged.ok) throw new Error(staged.error);
    await again.commit(staged.preview.token);
    expect(boot(root).registryNotice()).toEqual({ discarded: ['old.two'] });
    again.dismissRegistryNotice();
    expect(boot(root).registryNotice()).toBeNull();
  });

  it.each([
    ['不是 JSON', '{ not json'],
    ['plugins 不是数组', JSON.stringify({ version: 2, plugins: null })],
    ['不是对象', '[]'],
  ])('登记表读不出（%s）时不删任何文件、不覆盖原文件，另存原文并提示', async (_label, raw) => {
    const root = temp('plugins-root-');
    seed(root, ['a.demo']);
    writeFileSync(join(root, 'registry.json'), raw);
    const service = boot(root);
    expect(has(root, 'a.demo')).toEqual(all);
    expect(readFileSync(join(root, 'registry.json'), 'utf8')).toBe(raw);
    expect(readFileSync(join(root, 'registry.json.unreadable'), 'utf8')).toBe(raw);
    expect(service.registryNotice()).toEqual({ discarded: [], unreadable: true });
    expect(await service.logs('extension-plugins')).toContain('登记表读取失败');
  });

  it('登记表读不出后又安装了插件，下次启动也不会把原来的包当成孤儿删掉', async () => {
    const root = temp('plugins-root-');
    seed(root, ['a.demo']);
    writeFileSync(join(root, 'registry.json'), '{ broken');
    const service = boot(root);
    const src = temp('plugin-src-');
    writeFileSync(join(src, 'enso-plugin.json'), manifest({ id: 'b.new' }));
    writeFileSync(join(src, 'main.mjs'), 'export function activate() {}');
    const staged = await service.stage({ kind: 'dir', path: src });
    if (!staged.ok) throw new Error(staged.error);
    await service.commit(staged.preview.token);
    expect(readFileSync(join(root, 'registry.json.unreadable'), 'utf8')).toBe('{ broken');
    boot(root);
    expect(has(root, 'a.demo')).toEqual(all);
  });

  it('丢弃提示未确认时登记表又读不出，两类提示都保留', () => {
    const root = temp('plugins-root-');
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({ version: 1, plugins: [{ id: 'old.one' }] })
    );
    boot(root);
    writeFileSync(join(root, 'registry.json'), '{ broken');
    expect(boot(root).registryNotice()).toEqual({ discarded: ['old.one'], unreadable: true });
  });

  it('覆盖登记表前保留上一份备份', async () => {
    const root = temp('plugins-root-');
    const service = boot(root);
    const src = temp('plugin-src-');
    writeFileSync(join(src, 'enso-plugin.json'), manifest());
    writeFileSync(join(src, 'main.mjs'), 'export function activate() {}');
    const staged = await service.stage({ kind: 'dir', path: src });
    if (!staged.ok) throw new Error(staged.error);
    await service.commit(staged.preview.token);
    const first = readFileSync(join(root, 'registry.json'), 'utf8');
    await service.setEnabled('example.demo', true);
    expect(readFileSync(join(root, 'registry.json.bak'), 'utf8')).toBe(first);
  });
});

describe('插件市场', () => {
  function storedZip(files: Record<string, string>): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, data] of Object.entries(files)) {
      const nameBuf = Buffer.from(name);
      const raw = Buffer.from(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt32LE(raw.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      const record = Buffer.concat([local, nameBuf, raw]);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt32LE(raw.length, 20);
      central.writeUInt32LE(raw.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(record);
      centrals.push(Buffer.concat([central, nameBuf]));
      offset += record.length;
    }
    const dir = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(locals.length, 8);
    eocd.writeUInt16LE(locals.length, 10);
    eocd.writeUInt32LE(dir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, eocd]);
  }

  /** 市场替身：latest 为当前可下载版本，download 写出对应 zip */
  function fakeMarket(state: {
    latest: string;
    zipId?: string;
    patch?: Record<string, unknown>;
    main?: string;
    files?: Record<string, string>;
  }) {
    let mirror = false;
    let downloads = 0;
    return {
      downloads: () => downloads,
      chinaMirror: () => mirror,
      setChinaMirror: (on: boolean) => {
        mirror = on;
      },
      index: async () => ({
        ok: true as const,
        stale: false,
        index: {
          sequence: 1,
          generatedAt: '',
          plugins: [
            {
              id: 'example.demo',
              name: 'Demo',
              description: '',
              tier: 'official' as const,
              tags: [],
              icon: 'https://cdn.example/a b.svg',
              latest: state.latest,
              versions: [
                {
                  version: state.latest,
                  permissions: ['agent.tool'],
                  path: 'p.zip',
                  sha256: '',
                  size: 1,
                },
              ],
            },
          ],
        },
      }),
      download: async (_id: string, _v: string | undefined, dest: string) => {
        downloads += 1;
        writeFileSync(
          dest,
          storedZip({
            'enso-plugin.json': manifest({
              id: state.zipId ?? 'example.demo',
              version: state.latest,
              ...state.patch,
            }),
            'main.mjs': state.main ?? mainJs,
            ...state.files,
          })
        );
        return { ok: true as const, version: state.latest };
      },
    };
  }

  const open = (
    market: unknown,
    options: { auto?: boolean; composer?: () => Promise<unknown> } = {}
  ) =>
    new ExtensionPluginService({
      root,
      hostVersion: '0.2.12',
      hostPath: '/unused',
      env: {},
      fork: () => new InProcessChild() as never,
      market: market as never,
      ...(options.auto === false ? { autoUpdatePlugins: () => false } : {}),
      gate: {
        fetch: vi.fn(),
        notify: () => true,
        composer: options.composer ?? (async () => null),
        mcpTools: async () => [],
        mcpCall: async () => ({ content: '', isError: false }),
        now: () => Date.now(),
      },
    });

  async function installMarket(svc: ExtensionPluginService) {
    const staged = await svc.stage({ kind: 'market', id: 'example.demo' });
    if (!staged.ok) throw new Error(staged.error);
    const committed = await svc.commit(staged.preview.token);
    if (!committed.ok) throw new Error(committed.error);
  }

  it('从市场安装记录 market 来源；列表带安装状态；新版本出现时检查更新提示', async () => {
    const state = { latest: '1.0.0' };
    const svc = open(fakeMarket(state), { auto: false });
    await installMarket(svc);
    expect(svc.list()[0]?.source).toEqual({ kind: 'market' });
    expect(readRegistry(root).plugins[0]?.source).toEqual({ kind: 'market', id: 'example.demo' });
    const list = await svc.marketList(false);
    expect(list.ok && list.plugins[0]).toMatchObject({
      installedVersion: '1.0.0',
      updateAvailable: false,
      icon: 'https://enso-plugins.j3.do/v1/icon?url=https%3A%2F%2Fcdn.example%2Fa%20b.svg',
    });

    state.latest = '1.1.0';
    expect(await svc.checkUpdates()).toEqual({ checked: 1, available: 1, failed: 0 });
    expect(svc.list()[0]?.availableVersion).toBe('1.1.0');
    const again = await svc.restage('example.demo');
    if (!again.ok) throw new Error(again.error);
    await svc.commit(again.preview.token);
    expect(svc.list()[0]?.version).toBe('1.1.0');
  });

  it('自动更新关闭时只提示，不安装', async () => {
    const state = { latest: '1.0.0' };
    const svc = open(fakeMarket(state), { auto: false });
    await installMarket(svc);
    const notices: ExtensionPluginNotice[] = [];
    svc.onNotice((notice) => notices.push(notice));
    state.latest = '1.2.0';
    await svc.checkUpdates();
    expect(svc.list()[0]).toMatchObject({ version: '1.0.0', availableVersion: '1.2.0' });
    expect(notices).toEqual([]);
  });

  it('权限不变时自动安装并通知', async () => {
    const state = { latest: '1.0.0' };
    const svc = open(fakeMarket(state));
    await installMarket(svc);
    const notices: ExtensionPluginNotice[] = [];
    svc.onNotice((notice) => notices.push(notice));
    state.latest = '1.1.0';
    expect(await svc.checkUpdates()).toMatchObject({ checked: 1, failed: 0, available: 0 });
    expect(svc.list()[0]?.version).toBe('1.1.0');
    expect(svc.list()[0]?.availableVersion).toBeUndefined();
    expect(notices).toEqual([
      { kind: 'auto-updated', pluginId: 'example.demo', name: 'Demo', version: '1.1.0' },
    ]);
  });

  it('扩大权限时进入待授权，同一版本不重复下载也不重复通知', async () => {
    const state: { latest: string; patch?: Record<string, unknown> } = { latest: '1.0.0' };
    const market = fakeMarket(state);
    const svc = open(market);
    await installMarket(svc);
    const notices: ExtensionPluginNotice[] = [];
    svc.onNotice((notice) => notices.push(notice));
    state.latest = '2.0.0';
    state.patch = {
      permissions: ['agent.tool', 'net.fetch'],
      net: { domains: ['api.example.com'] },
    };
    const before = market.downloads();
    await svc.checkUpdates();
    expect(svc.list()[0]).toMatchObject({ version: '1.0.0', pendingVersion: '2.0.0' });
    expect(notices).toEqual([
      {
        kind: 'update-needs-approval',
        pluginId: 'example.demo',
        name: 'Demo',
        version: '2.0.0',
      },
    ]);
    expect(market.downloads()).toBe(before + 1);
    await svc.checkUpdates();
    expect(market.downloads()).toBe(before + 1);
    expect(notices).toHaveLength(1);
  });

  it('更新新增界面模块时进入待授权，并标出新增的界面代码', async () => {
    const state: {
      latest: string;
      patch?: Record<string, unknown>;
      files?: Record<string, string>;
    } = { latest: '1.0.0' };
    const svc = open(fakeMarket(state));
    await installMarket(svc);
    expect(svc.list()[0]?.pendingRenderer).toBeUndefined();
    state.latest = '2.0.0';
    state.patch = { renderer: 'ui.js', permissions: ['agent.tool', 'ui.slot'] };
    state.files = { 'ui.js': 'export default () => {};' };
    await svc.checkUpdates();
    expect(svc.list()[0]).toMatchObject({
      version: '1.0.0',
      hasRenderer: false,
      pendingVersion: '2.0.0',
      pendingRenderer: true,
    });
  });

  it('有进行中的调用时跳过不扩权的替换', async () => {
    const state = {
      latest: '1.0.0',
      main: `export function activate(enso) { enso.tools.register('lookup', async (_args, ctx) => { await ctx.progress('busy'); await new Promise(() => {}); }); }`,
    };
    const svc = open(fakeMarket(state));
    await installMarket(svc);
    await svc.setEnabled('example.demo', true);
    const seen = vi.fn();
    const pending = svc.callTool({
      toolName: 'plugin_example-demo__lookup',
      args: {},
      sessionId: 's1',
      projectRoot: null,
      onProgress: seen,
    });
    await vi.waitFor(() => expect(seen).toHaveBeenCalled());
    const notices: ExtensionPluginNotice[] = [];
    svc.onNotice((notice) => notices.push(notice));
    state.latest = '1.1.0';
    await svc.checkUpdates();
    expect(svc.list()[0]).toMatchObject({ version: '1.0.0', availableVersion: '1.1.0' });
    expect(notices).toEqual([]);
    void svc.dispose();
    await pending.catch(() => undefined);
  });

  it('本地安装的插件已在市场里有更高版本时，浏览市场和检查更新都能提示更新，但不静默覆盖本地来源', async () => {
    const state = { latest: '1.2.0' };
    const svc = open(fakeMarket(state));
    const staged = await svc.stage({
      kind: 'dir',
      path: writePlugin({ 'enso-plugin.json': manifest({ version: '1.0.0' }), 'main.mjs': mainJs }),
    });
    if (!staged.ok) throw new Error(staged.error);
    await svc.commit(staged.preview.token);

    expect(await svc.checkUpdates()).toEqual({ checked: 1, available: 1, failed: 0 });
    expect(svc.list()[0]).toMatchObject({
      version: '1.0.0',
      availableVersion: '1.2.0',
      source: { kind: 'dir' },
    });

    state.latest = '1.3.0';
    await svc.marketList(true);
    expect(svc.list()[0]?.availableVersion).toBe('1.3.0');
  });

  it('市场包里的插件 id 与条目不符时拒绝', async () => {
    const svc = open(fakeMarket({ latest: '1.0.0', zipId: 'other.plugin' }));
    expect(await svc.stage({ kind: 'market', id: 'example.demo' })).toMatchObject({ ok: false });
  });

  it('没有市场时明确报错', async () => {
    expect(await service.stage({ kind: 'market', id: 'example.demo' })).toMatchObject({
      ok: false,
    });
    expect(await service.marketList(false)).toMatchObject({ ok: false });
  });
});
