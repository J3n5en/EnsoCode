import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionPluginInstallPreview,
  ExtensionPluginSummary,
} from '@shared/extensionPlugins/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatInstallPreview, formatPluginList, runPluginCommand } from './pluginCli';

const preview: ExtensionPluginInstallPreview = {
  token: 't1',
  id: 'demo.hello',
  name: 'Hello',
  version: '1.0.0',
  description: 'say hi',
  permissions: ['agent.tool', 'net.fetch'],
  fsRead: [],
  fsWrite: [],
  netDomains: ['api.example.com'],
  mcpServers: [],
  mcpTools: [],
  env: ['GITHUB_TOKEN'],
  interop: ['enso.example.github'],
  resident: true,
  events: [{ event: 'session_start', mode: 'observe', failClosed: false }],
  schedules: [{ id: 'sweep', intervalSeconds: 3600 }],
  tools: [{ name: 'greet', description: 'greet someone' }],
  hasRenderer: false,
  warnings: ['w1'],
  expands: true,
};

function deps(answer = true) {
  const out: string[] = [];
  const call = vi.fn(async (command: Record<string, unknown>) => {
    if (command.action === 'stage' || command.action === 'restage') return { ok: true, preview };
    if (command.action === 'list')
      return { ok: true, plugins: [], notice: { discarded: ['old.one'], unreadable: true } };
    if (command.action === 'check')
      return {
        ok: true,
        checked: 2,
        available: 1,
        failed: 0,
        plugins: [{ id: 'demo.hello', name: 'Hello', version: '1.0.0', availableVersion: '1.2.0' }],
      };
    if (command.action === 'logs') return { ok: true, text: 'line-a\nline-b\n' };
    if (command.action === 'config-get')
      return {
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
          { key: 'token', title: 'Token', description: '', secret: true, set: false },
        ],
      };
    return { ok: true };
  });
  return {
    out,
    call,
    deps: {
      call,
      confirm: vi.fn(async () => answer),
      ask: vi.fn(async () => 'typed-secret'),
      log: (line: string) => out.push(line),
      cwd: '/home/u',
      interactive: true,
    },
  };
}

describe('enso-server plugin', () => {
  it('check：列出有新版本的插件和更新命令', async () => {
    const { call, out, deps: d } = deps();
    await runPluginCommand(['check'], d);
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'check' });
    const text = out.join('\n');
    expect(text).toContain('demo.hello 1.0.0 → 1.2.0');
    expect(text).toContain('enso-server plugin reload demo.hello');
  });

  it('列表里带上可更新版本', () => {
    const summary = {
      id: 'demo.hello',
      name: 'Hello',
      version: '1.0.0',
      state: 'enabled',
      availableVersion: '1.2.0',
    } as ExtensionPluginSummary;
    expect(formatPluginList([summary])).toContain('有新版本 1.2.0');
  });

  it('reload：从记录的来源重新暂存，确认后提交', async () => {
    const { call, deps: d } = deps(true);
    await runPluginCommand(['reload', 'demo.hello'], d);
    expect(call).toHaveBeenNthCalledWith(1, { cmd: 'plugin', action: 'restage', id: 'demo.hello' });
    expect(call).toHaveBeenNthCalledWith(2, { cmd: 'plugin', action: 'commit', token: 't1' });
  });

  it('logs：打印插件日志末尾', async () => {
    const { call, out, deps: d } = deps();
    await runPluginCommand(['logs', 'demo.hello'], d);
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'logs', id: 'demo.hello' });
    expect(out.join('\n')).toContain('line-b');
  });

  it('列表里带上最近错误', () => {
    const summary = {
      id: 'demo.hello',
      name: 'Hello',
      version: '1.0.0',
      state: 'crashed',
      lastError: { at: 1, message: 'Error: kaput\n    at x' },
    } as ExtensionPluginSummary;
    expect(formatPluginList([summary])).toContain('Error: kaput');
    expect(formatPluginList([summary])).not.toContain('at x');
  });

  it('安装预览列出权限、网络域名、工具与警告', () => {
    const text = formatInstallPreview(preview);
    for (const part of ['demo.hello', '1.0.0', 'agent.tool', 'api.example.com', 'greet', 'w1'])
      expect(text).toContain(part);
    expect(text).toContain('GITHUB_TOKEN');
    expect(text).toContain('常驻：是');
    expect(text).toContain('session_start');
    expect(text).toContain('sweep');
  });

  it('list 提示登记表问题，notice-dismiss 确认后不再提示', async () => {
    const { out, call, deps: d } = deps();
    await runPluginCommand(['list'], d);
    const text = out.join('\n');
    expect(text).toContain('old.one');
    expect(text).toContain('registry.json.unreadable');
    expect(text).toContain('notice-dismiss');
    await runPluginCommand(['notice-dismiss'], d);
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'notice-dismiss' });
  });

  it('列表为空时给出提示', () => {
    expect(formatPluginList([])).toContain('无');
    const summary = {
      id: 'demo.hello',
      name: 'Hello',
      version: '1.0.0',
      state: 'enabled',
      pendingVersion: '1.1.0',
    } as ExtensionPluginSummary;
    const text = formatPluginList([summary]);
    expect(text).toContain('demo.hello');
    expect(text).toContain('1.1.0');
  });

  it('install：相对路径按 cwd 解析，确认后提交', async () => {
    const { call, deps: d } = deps(true);
    await runPluginCommand(['install', 'plugins/hello.zip'], d);
    expect(call).toHaveBeenNthCalledWith(1, {
      cmd: 'plugin',
      action: 'stage',
      path: '/home/u/plugins/hello.zip',
    });
    expect(call).toHaveBeenNthCalledWith(2, { cmd: 'plugin', action: 'commit', token: 't1' });
  });

  it('install：http(s) 链接原样暂存，不拼到 cwd 上', async () => {
    const { call, deps: d } = deps(true);
    await runPluginCommand(['install', 'https://example.com/hello.zip', '--yes'], d);
    expect(call).toHaveBeenNthCalledWith(1, {
      cmd: 'plugin',
      action: 'stage',
      url: 'https://example.com/hello.zip',
    });
  });

  it('install：拒绝确认则丢弃暂存', async () => {
    const { call, deps: d } = deps(false);
    await runPluginCommand(['install', '/srv/hello'], d);
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'discard', token: 't1' });
  });

  it('install：非交互终端必须带 --yes', async () => {
    const { call, deps: d } = deps(true);
    await expect(
      runPluginCommand(['install', '/srv/hello'], { ...d, interactive: false })
    ).rejects.toThrow('--yes');
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'discard', token: 't1' });
    await runPluginCommand(['install', '/srv/hello', '--yes'], { ...d, interactive: false });
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'commit', token: 't1' });
  });

  it('按 id 的动作', async () => {
    const { call, deps: d } = deps();
    await runPluginCommand(['disable', 'demo.hello'], d);
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'disable', id: 'demo.hello' });
    await expect(runPluginCommand(['enable'], d)).rejects.toThrow('用法');
    await runPluginCommand(['inject-anywhere', 'a.b'], d);
    expect(call).toHaveBeenLastCalledWith({ cmd: 'plugin', action: 'inject-anywhere', id: 'a.b' });
    await expect(runPluginCommand(['bogus'], d)).rejects.toThrow('用法');
  });

  it('config：不带赋值时列出配置，密钥只显示是否已设置', async () => {
    const { out, deps: d } = deps();
    await runPluginCommand(['config', 'demo.hello'], d);
    const text = out.join('\n');
    expect(text).toContain('baseUrl');
    expect(text).toContain('https://x');
    expect(text).toMatch(/token.*未设置/);
  });

  it('config：key=value 设置，--unset 清除，空值在交互终端里提示输入', async () => {
    const { call, deps: d } = deps();
    await runPluginCommand(['config', 'demo.hello', 'baseUrl=https://y', '--unset', 'token'], d);
    expect(call).toHaveBeenLastCalledWith({
      cmd: 'plugin',
      action: 'config-set',
      id: 'demo.hello',
      values: { baseUrl: 'https://y', token: null },
    });
    await runPluginCommand(['config', 'demo.hello', 'token='], d);
    expect(d.ask).toHaveBeenCalledWith('token');
    expect(call).toHaveBeenLastCalledWith({
      cmd: 'plugin',
      action: 'config-set',
      id: 'demo.hello',
      values: { token: 'typed-secret' },
    });
    await expect(
      runPluginCommand(['config', 'demo.hello', 'token='], { ...d, interactive: false })
    ).rejects.toThrow('交互');
    await expect(runPluginCommand(['config', 'demo.hello', 'oops'], d)).rejects.toThrow('用法');
  });
});

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'enso-plugin-cli-'));
  scratch.push(dir);
  return dir;
}

const validManifest = {
  schemaVersion: 1,
  id: 'enso.example.hello',
  name: 'Hello',
  version: '0.1.0',
  description: 'hi',
  permissions: [] as string[],
};

describe('enso-server plugin validate / init', () => {
  it('validate：清单不合法、入口缺失或不是文件时抛出错误，且不连接服务', async () => {
    const root = tempDir();
    const { call, deps: d } = deps();
    await expect(runPluginCommand(['validate', join(root, 'missing')], d)).rejects.toThrow(
      '找不到插件目录'
    );
    const bad = join(root, 'bad');
    mkdirSync(bad);
    writeFileSync(join(bad, 'enso-plugin.json'), '{');
    await expect(runPluginCommand(['validate', bad], d)).rejects.toThrow('不是合法 JSON');
    writeFileSync(join(bad, 'enso-plugin.json'), JSON.stringify({ ...validManifest, id: 'Hello' }));
    await expect(runPluginCommand(['validate', bad], d)).rejects.toThrow('id 不合法');
    writeFileSync(
      join(bad, 'enso-plugin.json'),
      JSON.stringify({ ...validManifest, engines: { enso: '>=99.0.0' } })
    );
    await expect(runPluginCommand(['validate', bad], d)).rejects.toThrow('需要 Enso >=99.0.0');

    const plugin = join(root, 'plugin');
    mkdirSync(plugin);
    writeFileSync(
      join(plugin, 'enso-plugin.json'),
      JSON.stringify({
        ...validManifest,
        permissions: ['ui.slot'],
        main: 'main.mjs',
        renderer: 'ui.js',
      })
    );
    await expect(runPluginCommand(['validate', plugin], d)).rejects.toThrow('入口不存在：main');
    writeFileSync(join(plugin, 'main.mjs'), 'export {}\n');
    mkdirSync(join(plugin, 'ui.js'));
    await expect(runPluginCommand(['validate', plugin], d)).rejects.toThrow(
      '入口不是文件：renderer'
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('validate：未知字段只警告，入口存在则通过', async () => {
    const plugin = join(tempDir(), 'ok');
    mkdirSync(plugin);
    writeFileSync(join(plugin, 'main.mjs'), 'export {}\n');
    writeFileSync(
      join(plugin, 'enso-plugin.json'),
      JSON.stringify({ ...validManifest, main: 'main.mjs', marketplace: true })
    );
    const { out, call, deps: d } = deps();
    await runPluginCommand(['validate', plugin], d);
    const text = out.join('\n');
    expect(text).toContain('忽略未知字段 marketplace');
    expect(text).toContain('通过');
    expect(call).not.toHaveBeenCalled();
  });

  it('init：生成最小插件并通过 validate；拒绝覆盖和非法 id', async () => {
    const root = tempDir();
    const { out, call, deps: d } = deps();
    await runPluginCommand(['init', 'hello', '--id', 'enso.example.hello'], { ...d, cwd: root });
    expect(call).not.toHaveBeenCalled();
    const dir = join(root, 'hello');
    const manifest = JSON.parse(readFileSync(join(dir, 'enso-plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      id: 'enso.example.hello',
      main: 'main.mjs',
      renderer: 'ui.js',
    });
    expect(manifest.contributes.agentTools[0].name).toBe('hello');
    expect(readFileSync(join(dir, 'main.mjs'), 'utf8')).toContain("import('enso-plugin').EnsoMain");
    expect(readFileSync(join(dir, 'ui.js'), 'utf8')).toContain("import('enso-plugin').EnsoUi");
    expect(readFileSync(join(dir, 'jsconfig.json'), 'utf8')).toContain('enso-plugin.d.ts');
    await runPluginCommand(['validate', dir], d);
    expect(out.join('\n')).toContain('通过');
    execFileSync(
      'pnpm',
      ['exec', 'tsc', '-p', join(dir, 'jsconfig.json'), '--pretty', 'false', '--noEmit'],
      { encoding: 'utf8' }
    );
    await expect(runPluginCommand(['init', dir], d)).rejects.toThrow('已经有');
    await expect(
      runPluginCommand(['init', join(root, 'nope'), '--id', 'Hello'], d)
    ).rejects.toThrow('id 不合法');
  });
});
