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
import { dirname, join } from 'node:path';
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
  it('安装后默认停用，启用后工具进入会话下发列表', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    expect(service.list()[0]).toMatchObject({ id: 'example.demo', state: 'disabled' });
    expect(service.toolsForSpawn()).toEqual([]);
    service.setEnabled('example.demo', true);
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

  it('调用插件工具：会话 id 由 Main 传入', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    service.setEnabled('example.demo', true);
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
    service.setEnabled('example.demo', true);
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
    service.approvePending('example.demo');
    expect(service.list()[0]).toMatchObject({ version: '2.0.0', state: 'enabled' });
    expect(service.list()[0]?.pendingVersion).toBeUndefined();
  });

  it('卸载删除安装目录与数据目录', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    mkdirSync(join(root, 'data', 'example.demo'), { recursive: true });
    await service.uninstall('example.demo');
    expect(service.list()).toEqual([]);
    expect(existsSync(join(root, 'packages', 'example.demo'))).toBe(false);
    expect(existsSync(join(root, 'data', 'example.demo'))).toBe(false);
  });

  it('10 分钟内非预期退出 3 次即标记崩溃停用', async () => {
    await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
    service.setEnabled('example.demo', true);
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
      expect(await svc.checkUpdates()).toEqual({ checked: 1, available: 1, failed: 0 });
      expect(fetch).toHaveBeenCalledWith(probe, expect.anything());
      expect(svc.list()[0]).toMatchObject({ availableVersion: '1.2.0' });
      expect(svc.list()[0]?.updateCheckError).toBeUndefined();
      expect(changed).toHaveBeenCalled();
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
      svc.setEnabled('example.demo', true);
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
      service.setEnabled('example.demo', true);
      const call = { pluginId: 'example.demo', sessionId: null, projectRoot: null } as const;
      await expect(
        service.callUi({ ...call, method: 'command.run', payload: { id: 'bad' } })
      ).rejects.toThrow('kaput');
      await vi.waitFor(() => expect(service.logs('example.demo')).toContain('kaput'));
      expect(service.list()[0]?.lastError?.message).toContain('kaput');
    });

    it('崩溃停用时把原因写进登记，重启后仍可见；重新启用清掉', async () => {
      await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      service.setEnabled('example.demo', true);
      service.recordError('example.demo', 'segfault');
      for (let i = 0; i < 3; i++) service.recordCrash('example.demo');
      expect(readRegistry(root).plugins[0]?.lastError?.message).toBe('segfault');
      service.setEnabled('example.demo', true);
      expect(service.list()[0]?.lastError).toBeUndefined();
      expect(readRegistry(root).plugins[0]?.lastError).toBeUndefined();
    });

    it('日志只返回末尾，卸载时删除', async () => {
      await install({ 'enso-plugin.json': manifest(), 'main.mjs': mainJs });
      for (let i = 0; i < 2000; i++)
        service.appendLog('example.demo', 'info', `line-${i}-${'x'.repeat(40)}`);
      const tail = service.logs('example.demo', 4096);
      expect(tail.length).toBeLessThanOrEqual(4096);
      expect(tail).toContain('line-1999');
      expect(tail).not.toContain('line-0-');
      await service.uninstall('example.demo');
      expect(service.logs('example.demo')).toBe('');
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
    service.setEnabled('example.demo', true);
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

  it('预设点名的 skill 和 MCP 只在选中该预设时下发，并读出角色与指令', async () => {
    await install({
      'enso-plugin.json': manifest({
        permissions: ['agent.tool', 'mcp.server'],
        contributes: {
          agentTools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
          skills: ['skills/always', 'skills/review'],
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
      'a.js': '',
      'b.js': '',
      'prompts/instruction.md': 'do this',
      'prompts/role.md': 'you are a reviewer',
      'prompts/tail.md': 'tail',
      'prompts/boost.md': 'boost',
      'prompts/retry.md': 'retry',
    });
    service.setEnabled('example.demo', true);
    const ends = (paths: string[], name: string) => paths.some((path) => path.endsWith(name));
    expect(ends(service.skillPathsForSpawn(), 'skills/always')).toBe(true);
    expect(ends(service.skillPathsForSpawn(), 'skills/review')).toBe(false);
    expect(service.mcpServersForSpawn().map((server) => server.name)).toEqual([
      'plugin-example-demo-always',
    ]);
    const id = 'plugin:example.demo:review';
    expect(ends(service.skillPathsForSpawn(id), 'skills/always')).toBe(true);
    expect(ends(service.skillPathsForSpawn(id), 'skills/review')).toBe(true);
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

      service.setEnabled('example.demo', true);
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

      service.setEnabled('example.demo', false);
      expect(names()).toEqual([]);

      service.setEnabled('example.demo', true);
      expect(names()).toEqual(['demo:reviewer', 'worker-x']);
      await service.uninstall('example.demo');
      expect(names()).toEqual([]);
    });

    it('正文读不出的类型跳过并记日志；被重名丢弃的类型记一次日志', async () => {
      await install(files());
      service.setEnabled('example.demo', true);
      const pkg = service.agentTypesForSpawn()[0]?.skillPaths[0]?.replace(/skills\/review$/, '');
      rmSync(join(pkg as string, 'agents', 'worker.md'));
      expect(service.agentTypesForSpawn().map((t) => t.name)).toEqual(['demo:reviewer']);
      expect(service.logs('example.demo')).toContain('worker-x');

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
      const hits = service
        .logs('example.demo')
        .split('\n')
        .filter((l) => l.includes('同名'));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('demo:reviewer');
    });
  });

  it('处理器上下文带上 Main 推导的项目根', async () => {
    await install({
      'enso-plugin.json': manifest(),
      'main.mjs': `export function activate(enso) { enso.tools.register('lookup', async (args, ctx) => String(ctx.projectRoot)); }`,
    });
    service.setEnabled('example.demo', true);
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
      expect(service.setConfig('example.demo', { baseUrl: 'https://x', token: 'sk-1' })).toEqual({
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
      service.setConfig('example.demo', { baseUrl: 'https://x', token: 'sk-1' });
      service.setEnabled('example.demo', true);
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
      service.setConfig('example.demo', { baseUrl: 'https://x', token: 'sk-1' });
      service.setConfig('example.demo', { baseUrl: 'https://y' });
      expect(service.configValues('example.demo')).toEqual({ baseUrl: 'https://y', token: 'sk-1' });
      service.setConfig('example.demo', { token: null });
      expect(service.configValues('example.demo')).toEqual({ baseUrl: 'https://y' });
      expect(service.setConfig('example.demo', { other: 'x' }).ok).toBe(false);
      expect(service.setConfig('example.demo', { baseUrl: 'x'.repeat(5000) }).ok).toBe(false);
      expect(service.setConfig('missing.plugin', { baseUrl: 'x' }).ok).toBe(false);
    });

    it('卸载时删除配置文件', async () => {
      await install({ 'enso-plugin.json': configManifest(), 'main.mjs': readsConfig });
      service.setConfig('example.demo', { token: 'sk-1' });
      await service.uninstall('example.demo');
      expect(existsSync(join(root, 'config', 'example.demo.json'))).toBe(false);
    });
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

  it('只清理读到并决定丢弃的 id（含日志），没登记的目录只记日志不删', () => {
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
    expect(service.logs('extension-plugins')).toContain('stray.dir');
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
  ])('登记表读不出（%s）时不删任何文件、不覆盖原文件，另存原文并提示', (_label, raw) => {
    const root = temp('plugins-root-');
    seed(root, ['a.demo']);
    writeFileSync(join(root, 'registry.json'), raw);
    const service = boot(root);
    expect(has(root, 'a.demo')).toEqual(all);
    expect(readFileSync(join(root, 'registry.json'), 'utf8')).toBe(raw);
    expect(readFileSync(join(root, 'registry.json.unreadable'), 'utf8')).toBe(raw);
    expect(service.registryNotice()).toEqual({ discarded: [], unreadable: true });
    expect(service.logs('extension-plugins')).toContain('登记表读取失败');
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
    service.setEnabled('example.demo', true);
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
  function fakeMarket(state: { latest: string; zipId?: string }) {
    let mirror = false;
    return {
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
        writeFileSync(
          dest,
          storedZip({
            'enso-plugin.json': manifest({
              id: state.zipId ?? 'example.demo',
              version: state.latest,
            }),
            'main.mjs': mainJs,
          })
        );
        return { ok: true as const, version: state.latest };
      },
    };
  }

  const open = (market: unknown) =>
    new ExtensionPluginService({
      root,
      hostVersion: '0.2.12',
      hostPath: '/unused',
      env: {},
      fork: () => new InProcessChild() as never,
      market: market as never,
      gate: {
        fetch: vi.fn(),
        notify: () => true,
        composer: async () => null,
        mcpTools: async () => [],
        mcpCall: async () => ({ content: '', isError: false }),
        now: () => Date.now(),
      },
    });

  it('从市场安装记录 market 来源；列表带安装状态；新版本出现时检查更新提示', async () => {
    const state = { latest: '1.0.0' };
    const svc = open(fakeMarket(state));
    const staged = await svc.stage({ kind: 'market', id: 'example.demo' });
    if (!staged.ok) throw new Error(staged.error);
    await svc.commit(staged.preview.token);
    expect(svc.list()[0]?.source).toEqual({ kind: 'market' });
    expect(readRegistry(root).plugins[0]?.source).toEqual({ kind: 'market', id: 'example.demo' });
    const list = await svc.marketList(false);
    expect(list.ok && list.plugins[0]).toMatchObject({
      installedVersion: '1.0.0',
      updateAvailable: false,
    });

    state.latest = '1.1.0';
    expect(await svc.checkUpdates()).toEqual({ checked: 1, available: 1, failed: 0 });
    expect(svc.list()[0]?.availableVersion).toBe('1.1.0');
    const again = await svc.restage('example.demo');
    if (!again.ok) throw new Error(again.error);
    await svc.commit(again.preview.token);
    expect(svc.list()[0]?.version).toBe('1.1.0');
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
