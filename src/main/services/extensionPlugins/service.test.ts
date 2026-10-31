import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPluginHost } from '../../../pluginHost/host';
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
    queueMicrotask(() => this.handler(m));
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
      sessionMessages: async () => [],
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
    expect(result).toEqual({ content: 'got x in s1' });
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
    ).resolves.toEqual({ content: '/work/repo' });
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
            set: true,
            value: 'https://x',
          },
          { key: 'token', title: 'Token', description: '', secret: true, set: true },
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
