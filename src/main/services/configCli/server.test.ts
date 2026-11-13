import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConfigCliHandle } from './server';

const userData = mkdtempSync(path.join(tmpdir(), 'enso-cli-'));
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  applyProxy: vi.fn(async () => ({ ok: true })),
}));

vi.mock('electron', () => ({
  app: { getPath: () => userData, on: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../modelDirectory', () => ({ notifyModelDirectorySettingsChanged: () => {} }));
vi.mock('../uiHost', async () =>
  (await import('../../../../test/helpers/localUi')).mockUiHost(() => [
    {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send: mocks.send },
    },
  ])
);

const SECRET = 'sk-live-very-secret';
writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({
    'enso-settings': {
      state: {
        theme: 'dark',
        terminalFontSize: 13,
        autoUpdate: true,
        proxyMode: 'system',
        customProxyUrl: '',
        voiceGeminiApiKey: 'gemini-secret',
        worktreeRoot: '',
        projects: [{ id: 'proj', path: '/tmp/x' }],
        plugins: [{ id: 'pl', key: 'k', name: 'p', enabled: true }],
        providers: [
          {
            id: 'p1',
            apiKey: SECRET,
            baseUrl: 'https://api.example.com',
            headers: { Authorization: 'Bearer hdr-secret', 'X-Trace': '1' },
            models: [{ id: 'm1' }],
          },
        ],
        mcpServers: [
          {
            id: 'mcp1',
            name: 'gh',
            transport: 'stdio',
            command: 'npx',
            args: ['server'],
            env: { GITHUB_TOKEN: 'ghp-secret' },
            callTimeoutSec: 30,
          },
        ],
      },
    },
  })
);

let handle: ConfigCliHandle;
let token: string;

function request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(handle.endpoint);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
    });
    socket.on('end', () => resolve(JSON.parse(buffer)));
    socket.on('error', reject);
  });
}

const config = (body: Record<string, unknown>) => request({ token, cmd: 'config', ...body });

async function state(): Promise<Record<string, unknown>> {
  return (await import('../../ipc/settings')).readSettingsState();
}

function runCli(
  args: string[],
  dataDir = userData
): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = path.resolve(__dirname, '../../../../scripts/enso-cli.mjs');
  return new Promise((resolve) => {
    execFile(process.execPath, [script, '--data-dir', dataDir, ...args], (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })
    );
  });
}

beforeAll(async () => {
  const settings = await import('../../ipc/settings');
  const { startConfigCli } = await import('./server');
  handle = await startConfigCli(userData, {
    fields: settings.SETTINGS_STATE_FIELDS,
    readState: settings.readSettingsState,
    patch: (field, value) => settings.patchSettingsState(field, value, undefined, 'all-renderers'),
    reload: settings.reloadSettingsFromDisk,
    applyProxy: mocks.applyProxy,
  });
  token = readFileSync(handle.tokenPath, 'utf8');
});

afterAll(async () => {
  (await import('../../ipc/settings')).flushSettings();
  handle.close();
  rmSync(userData, { recursive: true, force: true });
});

describe('config CLI socket', () => {
  it.skipIf(process.platform === 'win32')('socket 与 token 文件只给本人读写', () => {
    expect(statSync(handle.endpoint).mode & 0o777).toBe(0o600);
    expect(statSync(handle.tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(handle.endpoint)).mode & 0o777).toBe(0o700);
  });

  it('token 错误或缺失一律拒绝', async () => {
    expect(await request({ token: 'wrong', cmd: 'config', action: 'get', key: 'theme' })).toEqual({
      ok: false,
      error: 'unauthorized',
    });
    expect(await request({ cmd: 'config', action: 'get', key: 'theme' })).toMatchObject({
      ok: false,
      error: 'unauthorized',
    });
    expect(await request({ token, cmd: 'plugin', action: 'list' })).toMatchObject({ ok: false });
  });

  it('黑名单密钥键不可读', async () => {
    for (const key of [
      'providers.p1.apiKey',
      'providers.p1.headers.Authorization',
      'voiceGeminiApiKey',
      'mcpServers.mcp1.env',
    ]) {
      expect(await config({ action: 'get', key })).toMatchObject({ ok: false, hidden: true });
    }
    const provider = await config({ action: 'get', key: 'providers.p1' });
    expect(provider).toMatchObject({
      ok: true,
      value: { apiKey: '***', headers: { Authorization: '***', 'X-Trace': '1' } },
    });
  });

  it('黑名单键（apiKey/token/secret/password/authorization）set 被拒且值不变', async () => {
    for (const key of [
      'providers.p1.apiKey',
      'providers.p1.api_key',
      'providers.p1.token',
      'mcpServers.mcp1.env.GITHUB_TOKEN',
      'providers.p1.clientSecret',
      'providers.p1.password',
      'providers.p1.credential',
      'providers.p1.headers.Authorization',
      'voiceGeminiApiKey',
    ]) {
      const reply = await config({ action: 'set', key, value: 'leaked' });
      expect(reply.ok).toBe(false);
      expect(String(reply.error)).toMatch(/Secret field/);
    }
    // 整体覆盖会冲掉密钥字段，同样拒绝
    expect(await config({ action: 'set', key: 'providers.p1', value: {} })).toMatchObject({
      ok: false,
    });
    const provider = ((await state()).providers as Record<string, unknown>[])[0];
    expect(provider.apiKey).toBe(SECRET);
  });

  it('非设置类操作（路径/命令/插件装卸/项目数据）被拒', async () => {
    for (const [key, value] of [
      ['mcpServers.mcp1.command', 'rm'],
      ['mcpServers.mcp1.args', ['-rf']],
      ['worktreeRoot', '/etc'],
      ['plugins', []],
      ['projects', []],
    ] as const) {
      expect(await config({ action: 'set', key, value })).toMatchObject({ ok: false });
    }
    expect(await config({ action: 'get', key: 'projects' })).toMatchObject({ ok: false });
    expect(await config({ action: 'set', key: 'notASetting', value: 1 })).toMatchObject({
      ok: false,
      error: 'Unknown settings field: notASetting',
    });
  });

  it('list 输出全部设置键，密钥显示为 ***', async () => {
    const reply = await config({ action: 'list' });
    const text = JSON.stringify(reply);
    expect(reply.ok).toBe(true);
    for (const secret of [SECRET, 'gemini-secret', 'hdr-secret', 'ghp-secret'])
      expect(text).not.toContain(secret);
    const entries = reply.entries as { key: string; value: unknown }[];
    expect(entries.find((e) => e.key === 'voiceGeminiApiKey')?.value).toBe('***');
    expect(entries.find((e) => e.key === 'terminalFontSize')).toBeDefined();
    expect(entries.some((e) => e.key === 'projects')).toBe(false);
  });

  it('普通设置键 set 成功并经同一 store 广播', async () => {
    mocks.send.mockClear();
    expect(await config({ action: 'set', key: 'terminalFontSize', value: 15 })).toEqual({
      ok: true,
    });
    expect(
      await config({ action: 'set', key: 'mcpServers.mcp1.callTimeoutSec', value: 60 })
    ).toEqual({ ok: true });
    const current = await state();
    expect(current.terminalFontSize).toBe(15);
    expect((current.mcpServers as Record<string, unknown>[])[0]).toMatchObject({
      callTimeoutSec: 60,
      command: 'npx',
      env: { GITHUB_TOKEN: 'ghp-secret' },
    });
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_CHANGED);
    expect(await config({ action: 'set', key: 'terminalFontSize', value: 'big' })).toMatchObject({
      ok: false,
    });
  });

  it('代理键写入后同步应用代理', async () => {
    mocks.applyProxy.mockClear();
    expect(
      await config({ action: 'set', key: 'customProxyUrl', value: 'http://127.0.0.1:7890' })
    ).toEqual({ ok: true });
    expect(await config({ action: 'set', key: 'proxyMode', value: 'custom' })).toEqual({
      ok: true,
    });
    expect(mocks.applyProxy).toHaveBeenLastCalledWith('custom', 'http://127.0.0.1:7890');
    expect(await config({ action: 'set', key: 'proxyMode', value: 'bogus' })).toMatchObject({
      ok: false,
    });
  });

  it('需要重启的键返回 requiresRestart 且不写入', async () => {
    const reply = await config({ action: 'set', key: 'autoUpdate', value: false });
    expect(reply).toMatchObject({ ok: false, requiresRestart: true });
    expect(typeof reply.reason).toBe('string');
    expect((await state()).autoUpdate).toBe(true);
  });

  it('reload 以磁盘为准重读', async () => {
    const settings = await import('../../ipc/settings');
    settings.flushSettings();
    const file = path.join(userData, 'settings.json');
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    disk['enso-settings'].state.theme = 'light';
    writeFileSync(file, JSON.stringify(disk));
    expect(await config({ action: 'reload' })).toEqual({ ok: true });
    expect((await state()).theme).toBe('light');
  });

  it('schema 从真实 state 生成键清单，标注密钥/需重启/可写且不含任何值', async () => {
    const reply = await config({ action: 'schema' });
    expect(reply.ok).toBe(true);
    const text = JSON.stringify(reply);
    for (const secret of [SECRET, 'gemini-secret', 'hdr-secret', 'ghp-secret'])
      expect(text).not.toContain(secret);
    const keys = new Map(
      (reply.keys as { path: string }[]).map((k) => [k.path, k as Record<string, unknown>])
    );
    expect(keys.get('terminalFontSize')).toEqual({
      path: 'terminalFontSize',
      type: 'number',
      writable: true,
      requiresRestart: false,
      secret: false,
    });
    expect(keys.get('theme')).toMatchObject({ type: 'string', writable: true });
    expect(keys.get('mcpServers.<id>.callTimeoutSec')).toMatchObject({ writable: true });
    for (const path of ['voiceGeminiApiKey', 'providers.<id>.apiKey', 'mcpServers.<id>.env']) {
      expect(keys.get(path)).toMatchObject({ secret: true, writable: false });
      const key = path.replace('<id>', path.startsWith('providers') ? 'p1' : 'mcp1');
      expect(await config({ action: 'get', key })).toMatchObject({ ok: false, hidden: true });
    }
    expect(keys.get('autoUpdate')).toMatchObject({ requiresRestart: true, writable: false });
    for (const path of ['worktreeRoot', 'mcpServers.<id>.command', 'plugins', 'providers.<id>'])
      expect(keys.get(path)).toMatchObject({ writable: false });
    expect(keys.get('plugins.<id>.enabled')).toMatchObject({ writable: true });
    expect(keys.has('projects')).toBe(false);
    // 未写入 state 的已登记字段同样出现
    expect(keys.get('autoRestartWhenIdle')).toMatchObject({
      type: 'unknown',
      requiresRestart: true,
    });
    expect(reply).toMatchObject({
      blacklist: { readDeniedFields: ['projects', 'projectGroups'] },
      notes: { requiresRestart: { autoUpdate: expect.any(String) } },
    });
  });

  it('enso CLI help：纯文本可离线打印，--json 需要应用在运行', async () => {
    const offline = mkdtempSync(path.join(tmpdir(), 'enso-cli-offline-'));
    for (const args of [['config', 'help'], ['--help'], ['config', '-h']]) {
      const help = await runCli(args, offline);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('enso config set <key> <value>');
    }
    const missing = await runCli(['config', 'help', '--json'], offline);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('EnsoCode');
    rmSync(offline, { recursive: true, force: true });

    const json = await runCli(['config', 'help', '--json']);
    expect(json.code).toBe(0);
    const schema = JSON.parse(json.stdout);
    expect(schema.commands.map((c: { name: string }) => c.name)).toEqual([
      'get',
      'set',
      'list',
      'reload',
      'help',
    ]);
    expect(schema.keys.some((k: { path: string }) => k.path === 'terminalFontSize')).toBe(true);
    expect(JSON.parse((await runCli(['config', 'schema'])).stdout)).toEqual(schema);
  });

  it('enso CLI 端到端：get/set/拒绝', async () => {
    const set = await runCli(['config', 'set', 'terminalFontSize', '16']);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout)).toEqual({ ok: true });
    const get = await runCli(['config', 'get', 'terminalFontSize']);
    expect(JSON.parse(get.stdout)).toMatchObject({ ok: true, value: 16 });
    const denied = await runCli(['config', 'set', 'providers.p1.apiKey', 'x']);
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.stdout)).toMatchObject({ ok: false });
  });

  it('关闭后清理 socket 与 token', async () => {
    const { startConfigCli } = await import('./server');
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-cli-close-'));
    const temp = await startConfigCli(dir, {
      fields: [],
      readState: () => ({}),
      patch: () => ({ ok: true }),
      reload: () => true,
      applyProxy: async () => ({ ok: true }),
    });
    temp.close();
    expect(existsSync(temp.tokenPath)).toBe(false);
    if (process.platform !== 'win32') expect(existsSync(temp.endpoint)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
