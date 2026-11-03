import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionPluginManifest } from '@shared/extensionPlugins/manifest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GateDeps, PluginHostGate } from './gate';

const manifest = (patch: Partial<ExtensionPluginManifest> = {}): ExtensionPluginManifest => ({
  schemaVersion: 1,
  id: 'a.b',
  name: 'A',
  version: '1',
  description: '',
  main: 'main.js',
  permissions: ['fs.read', 'fs.write', 'net.fetch', 'composer.draft', 'ui.notify'],
  fs: { read: ['docs'], write: ['out'] },
  net: { domains: ['api.example.com'] },
  mcp: { tools: [] },
  resident: false,
  env: [],
  interop: { call: [] },
  contributes: {
    agentTools: [],
    commands: [],
    views: [],
    triggers: [],
    skills: [],
    mcpServers: [],
    methods: [],
    configuration: [],
    presets: [],
    agentTypes: [],
    events: [],
    schedules: [],
    exports: [],
    dynamic: { tools: 0, commands: 0 },
  },
  ...patch,
});

let root: string;
let outside: string;
let now = 1000;
let deps: GateDeps;
let gate: PluginHostGate;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gate-root-'));
  outside = mkdtempSync(join(tmpdir(), 'gate-out-'));
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'out'));
  writeFileSync(join(root, 'docs', 'a.md'), 'hello');
  writeFileSync(join(root, 'secret.txt'), 'secret');
  writeFileSync(join(outside, 'x.txt'), 'outside');
  now = 1000;
  deps = {
    manifest: (id) => (id === 'a.b' ? manifest() : null),
    fetch: vi.fn(
      async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    ),
    notify: vi.fn(() => true),
    composer: vi.fn(async () => ({ ok: true })),
    config: vi.fn(() => ({ baseUrl: 'https://bce.example.com' })),
    mcpTools: vi.fn(async () => [
      { server: 'bce', name: 'enhance_prompt', description: '改写' },
      { server: 'bce', name: 'delete_index', description: '删索引' },
    ]),
    mcpCall: vi.fn(async () => ({ content: 'enhanced', isError: false })),
    now: () => now,
  };
  gate = new PluginHostGate(deps);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const agentCall = () =>
  gate.invocations.create({ pluginId: 'a.b', sessionId: 's1', projectRoot: root, gesture: false });
const uiCall = () =>
  gate.invocations.create({ pluginId: 'a.b', sessionId: 's1', projectRoot: root, gesture: true });

describe('PluginHostGate', () => {
  it('读取授权范围内的项目文件', async () => {
    await expect(
      gate.handle('a.b', 'fs.readText', { path: 'docs/a.md' }, agentCall())
    ).resolves.toBe('hello');
  });

  it('拒绝 fs 范围外、越界路径、无调用上下文', async () => {
    const inv = agentCall();
    await expect(
      gate.handle('a.b', 'fs.readText', { path: 'secret.txt' }, inv)
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(
      gate.handle('a.b', 'fs.readText', { path: '../x.txt' }, inv)
    ).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
    await expect(
      gate.handle('a.b', 'fs.readText', { path: 'docs/a.md' }, undefined)
    ).rejects.toMatchObject({
      code: 'NO_INVOCATION',
    });
  });

  it('拒绝经符号链接逃出项目根', async () => {
    symlinkSync(join(outside, 'x.txt'), join(root, 'docs', 'link.txt'));
    await expect(
      gate.handle('a.b', 'fs.readText', { path: 'docs/link.txt' }, agentCall())
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('没有项目根（如 SSH 会话）时拒绝 fs', async () => {
    const inv = gate.invocations.create({
      pluginId: 'a.b',
      sessionId: 's1',
      projectRoot: null,
      gesture: false,
    });
    await expect(
      gate.handle('a.b', 'fs.readText', { path: 'docs/a.md' }, inv)
    ).rejects.toMatchObject({
      code: 'NO_PROJECT',
    });
  });

  it('写入授权目录；取消后拒绝写入', async () => {
    const inv = agentCall();
    await gate.handle('a.b', 'fs.writeText', { path: 'out/r.txt', text: 'done' }, inv);
    expect(readFileSync(join(root, 'out', 'r.txt'), 'utf8')).toBe('done');
    gate.invocations.cancel(inv);
    await expect(
      gate.handle('a.b', 'fs.writeText', { path: 'out/r.txt', text: 'x' }, inv)
    ).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });

  it('调用 id 不属于该插件时拒绝', async () => {
    const inv = gate.invocations.create({
      pluginId: 'c.d',
      sessionId: 's1',
      projectRoot: root,
      gesture: true,
    });
    await expect(
      gate.handle('a.b', 'fs.readText', { path: 'docs/a.md' }, inv)
    ).rejects.toMatchObject({
      code: 'NO_INVOCATION',
    });
  });

  it('net.fetch 只允许声明的域名，重定向到别的域名被拒绝', async () => {
    await expect(
      gate.handle('a.b', 'net.fetch', { url: 'https://api.example.com/x', init: {} }, undefined)
    ).resolves.toMatchObject({ status: 200, body: 'ok' });
    await expect(
      gate.handle('a.b', 'net.fetch', { url: 'https://evil.com/', init: {} }, undefined)
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    deps.fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.com/' } })
    );
    gate = new PluginHostGate(deps);
    await expect(
      gate.handle('a.b', 'net.fetch', { url: 'https://api.example.com/x', init: {} }, undefined)
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('没有权限时拒绝', async () => {
    deps.manifest = () => manifest({ permissions: [] });
    gate = new PluginHostGate(deps);
    await expect(gate.handle('a.b', 'ui.notify', { title: 't' }, undefined)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('服务端无系统通知时返回 UNSUPPORTED', async () => {
    deps.notify = () => false;
    gate = new PluginHostGate(deps);
    await expect(gate.handle('a.b', 'ui.notify', { title: 't' }, undefined)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });

  it('草稿读写需要用户手势，令牌 30 秒后过期', async () => {
    await expect(gate.handle('a.b', 'composer.readDraft', {}, agentCall())).rejects.toMatchObject({
      code: 'GESTURE_REQUIRED',
    });
    const inv = uiCall();
    await gate.handle('a.b', 'composer.readDraft', {}, inv);
    expect(deps.composer).toHaveBeenCalledWith({ sessionId: 's1', origin: null }, 'readDraft', {});
    now += 31_000;
    await expect(gate.handle('a.b', 'composer.readDraft', {}, inv)).rejects.toMatchObject({
      code: 'GESTURE_REQUIRED',
    });
  });

  it('草稿请求带上发起调用的窗口', async () => {
    const inv = gate.invocations.create({
      pluginId: 'a.b',
      sessionId: 's1',
      projectRoot: root,
      gesture: true,
      origin: 7,
    });
    await gate.handle('a.b', 'composer.insertText', { text: 'hi' }, inv);
    expect(deps.composer).toHaveBeenCalledWith({ sessionId: 's1', origin: 7 }, 'insertText', {
      text: 'hi',
    });
  });

  it('草稿写入超过 32KB 拒绝', async () => {
    await expect(
      gate.handle(
        'a.b',
        'composer.insertText',
        { generation: 1, rev: 1, span: { start: 0, end: 0 }, text: 'x'.repeat(33 * 1024) },
        uiCall()
      )
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('插件未启用时一律拒绝', async () => {
    deps.manifest = () => null;
    gate = new PluginHostGate(deps);
    await expect(gate.handle('a.b', 'ui.notify', { title: 't' }, undefined)).rejects.toMatchObject({
      code: 'PLUGIN_DISABLED',
    });
  });

  it('读自己的配置不需要权限，也不需要调用上下文', async () => {
    await expect(gate.handle('a.b', 'config.get', {}, undefined)).resolves.toEqual({
      baseUrl: 'https://bce.example.com',
    });
    expect(deps.config).toHaveBeenCalledWith('a.b');
  });

  describe('宿主 MCP', () => {
    const mcpManifest = () =>
      manifest({ permissions: ['mcp.call'], mcp: { tools: ['enhance_prompt'] } });
    beforeEach(() => {
      deps.manifest = (id) => (id === 'a.b' ? mcpManifest() : null);
      gate = new PluginHostGate(deps);
    });

    it('没有 mcp.call 权限一律拒绝', async () => {
      deps.manifest = () => manifest();
      gate = new PluginHostGate(deps);
      await expect(gate.handle('a.b', 'mcp.tools', {}, agentCall())).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
    });

    it('列工具只返回清单声明过的工具名', async () => {
      await expect(gate.handle('a.b', 'mcp.tools', {}, agentCall())).resolves.toEqual([
        { server: 'bce', name: 'enhance_prompt', description: '改写' },
      ]);
      expect(deps.mcpTools).toHaveBeenCalledWith(
        { sessionId: 's1', projectRoot: root },
        expect.any(AbortSignal)
      );
    });

    it('调用未声明的工具拒绝，不触达 MCP', async () => {
      await expect(
        gate.handle(
          'a.b',
          'mcp.call',
          { server: 'bce', tool: 'delete_index', args: {} },
          agentCall()
        )
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(deps.mcpCall).not.toHaveBeenCalled();
    });

    it('调用必须在宿主发起的调用内，参数必须是对象', async () => {
      await expect(
        gate.handle('a.b', 'mcp.call', { server: 'bce', tool: 'enhance_prompt' }, undefined)
      ).rejects.toMatchObject({ code: 'NO_INVOCATION' });
      await expect(
        gate.handle(
          'a.b',
          'mcp.call',
          { server: 'bce', tool: 'enhance_prompt', args: [1] },
          agentCall()
        )
      ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    });

    it('调用带上会话与项目根，取消调用会中止 MCP 请求', async () => {
      let seen: AbortSignal | undefined;
      deps.mcpCall = vi.fn(async (_target, _server, _tool, _args, signal: AbortSignal) => {
        seen = signal;
        return { content: 'enhanced', isError: false };
      });
      gate = new PluginHostGate(deps);
      const inv = agentCall();
      await expect(
        gate.handle(
          'a.b',
          'mcp.call',
          { server: 'bce', tool: 'enhance_prompt', args: { prompt: 'x' } },
          inv
        )
      ).resolves.toEqual({ content: 'enhanced', isError: false });
      expect(deps.mcpCall).toHaveBeenCalledWith(
        { sessionId: 's1', projectRoot: root },
        'bce',
        'enhance_prompt',
        { prompt: 'x' },
        expect.any(AbortSignal)
      );
      expect(seen?.aborted).toBe(false);
      gate.invocations.cancel(inv);
      expect(seen?.aborted).toBe(true);
    });
  });

  it('剪贴板和外链需要权限、手势，外链只接受 http/https/mailto', async () => {
    const clipboard = vi.fn();
    const openExternal = vi.fn(async () => undefined);
    deps.clipboard = clipboard;
    deps.openExternal = openExternal;
    deps.manifest = () => manifest({ permissions: ['ui.clipboard', 'ui.openExternal'] });
    gate = new PluginHostGate(deps);
    await expect(
      gate.handle('a.b', 'ui.clipboard', { text: 'hi' }, agentCall())
    ).rejects.toMatchObject({
      code: 'GESTURE_REQUIRED',
    });
    await expect(gate.handle('a.b', 'ui.clipboard', { text: 'hi' }, uiCall())).resolves.toBeNull();
    expect(clipboard).toHaveBeenCalledWith('hi');
    await expect(
      gate.handle('a.b', 'ui.openExternal', { url: 'file:///etc/passwd' }, uiCall())
    ).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
    await expect(
      gate.handle('a.b', 'ui.openExternal', { url: 'https://example.com/a' }, uiCall())
    ).resolves.toBeNull();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a');
    await expect(
      gate.handle('a.b', 'ui.openExternal', { url: 'mailto:a@b.c' }, uiCall())
    ).resolves.toBeNull();
  });

  it('会话接口：列表需要 session.read，跳转与新建需要各自权限和用户手势', async () => {
    const list = vi.fn(() => [
      { id: 's1', title: '当前', updatedAt: 2 },
      { id: 's2', title: '另一个', updatedAt: 1, running: true },
    ]);
    const sessionUi = vi.fn(async (_target: unknown, op: string) =>
      op === 'createSession' ? { sessionId: 's3' } : null
    );
    deps.sessions = { list };
    deps.sessionUi = sessionUi;
    deps.manifest = () => manifest({ permissions: [] });
    gate = new PluginHostGate(deps);
    for (const api of ['session.list', 'session.focus', 'session.create'] as const)
      await expect(gate.handle('a.b', api, { sessionId: 's2' }, uiCall())).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });

    deps.manifest = () =>
      manifest({ permissions: ['session.read', 'session.focus', 'session.create'] });
    gate = new PluginHostGate(deps);
    await expect(gate.handle('a.b', 'session.list', {}, agentCall())).resolves.toEqual({
      current: 's1',
      sessions: list(),
    });
    expect(list).toHaveBeenCalledWith('s1');

    await expect(
      gate.handle('a.b', 'session.focus', { sessionId: 's2' }, agentCall())
    ).rejects.toMatchObject({ code: 'GESTURE_REQUIRED' });
    await expect(
      gate.handle('a.b', 'session.focus', { sessionId: 'elsewhere' }, uiCall())
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      gate.handle('a.b', 'session.focus', { sessionId: 's2' }, uiCall())
    ).resolves.toBeNull();
    expect(sessionUi).toHaveBeenLastCalledWith({ sessionId: 's1', origin: null }, 'focusSession', {
      sessionId: 's2',
    });

    await expect(gate.handle('a.b', 'session.create', {}, agentCall())).rejects.toMatchObject({
      code: 'GESTURE_REQUIRED',
    });
    await expect(
      gate.handle('a.b', 'session.create', { text: 'x'.repeat(40 * 1024) }, uiCall())
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(
      gate.handle('a.b', 'session.create', { text: '整理看板' }, uiCall())
    ).resolves.toEqual({ sessionId: 's3' });
    expect(sessionUi).toHaveBeenLastCalledWith({ sessionId: 's1', origin: null }, 'createSession', {
      text: '整理看板',
    });
  });

  it('会话接口在调用不属于任何会话时拒绝', async () => {
    deps.sessions = { list: vi.fn(() => []) };
    deps.sessionUi = vi.fn(async () => ({ sessionId: 'x' }));
    deps.manifest = () =>
      manifest({ permissions: ['session.read', 'session.focus', 'session.create'] });
    gate = new PluginHostGate(deps);
    const orphan = () =>
      gate.invocations.create({
        pluginId: 'a.b',
        sessionId: null,
        projectRoot: null,
        gesture: true,
      });
    for (const api of ['session.list', 'session.focus', 'session.create'] as const)
      await expect(gate.handle('a.b', api, { sessionId: 's2' }, orphan())).rejects.toMatchObject({
        code: 'NO_SESSION',
      });
  });

  it('远端窗口发起的调用不能动宿主桌面的剪贴板和外链', async () => {
    deps.clipboard = vi.fn();
    deps.openExternal = vi.fn(async () => undefined);
    deps.manifest = () => manifest({ permissions: ['ui.clipboard', 'ui.openExternal'] });
    gate = new PluginHostGate(deps);
    const remote = () =>
      gate.invocations.create({
        pluginId: 'a.b',
        sessionId: 's1',
        projectRoot: root,
        gesture: true,
        remote: true,
      });
    await expect(
      gate.handle('a.b', 'ui.clipboard', { text: 'hi' }, remote())
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(
      gate.handle('a.b', 'ui.openExternal', { url: 'https://example.com' }, remote())
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(deps.clipboard).not.toHaveBeenCalled();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('注入参数不合法或目标未授权时不消耗频率配额', async () => {
    const inject = vi.fn(() => ({ ok: true as const }));
    deps.inject = inject;
    deps.manifest = () => manifest({ permissions: ['agent.inject'] });
    gate = new PluginHostGate(deps);
    for (let i = 0; i < 6; i++) {
      await expect(
        gate.handle('a.b', 'session.inject', { text: 'x'.repeat(40_000) }, agentCall())
      ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
      await expect(
        gate.handle('a.b', 'session.inject', { text: 'hi', sessionId: 'other' }, agentCall())
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    for (let i = 0; i < 5; i++)
      await expect(
        gate.handle('a.b', 'session.inject', { text: 'hi' }, agentCall())
      ).resolves.toBeNull();
    await expect(
      gate.handle('a.b', 'session.inject', { text: 'hi' }, agentCall())
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(inject).toHaveBeenCalledTimes(5);
  });

  it('net.fetch 随调用取消中止', async () => {
    let seen: AbortSignal | undefined;
    deps.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response('ok');
    });
    gate = new PluginHostGate(deps);
    const inv = agentCall();
    await gate.handle('a.b', 'net.fetch', { url: 'https://api.example.com/x', init: {} }, inv);
    expect(seen?.aborted).toBe(false);
    gate.invocations.cancel(inv);
    expect(seen?.aborted).toBe(true);
  });
});

describe('插件远程会话能力', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');

  it('net.fetch responseType=base64 原样返回二进制', async () => {
    deps.fetch = vi.fn(async () => new Response(new Uint8Array([0, 255, 128]), { status: 200 }));
    gate = new PluginHostGate(deps);
    const res = await gate.handle(
      'a.b',
      'net.fetch',
      { url: 'https://api.example.com/f', init: { responseType: 'base64' } },
      undefined
    );
    expect(res).toMatchObject({ status: 200, body: Buffer.from([0, 255, 128]).toString('base64') });
    await expect(
      gate.handle(
        'a.b',
        'net.fetch',
        { url: 'https://api.example.com/f', init: { responseType: 'blob' } },
        undefined
      )
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('session.inject 可带图片，校验类型、格式与数量', async () => {
    const inject = vi.fn(() => ({ ok: true as const }));
    deps.inject = inject;
    deps.manifest = () => manifest({ permissions: ['agent.inject'] });
    gate = new PluginHostGate(deps);
    const images = [{ data: png, mimeType: 'image/png' }];
    await expect(
      gate.handle('a.b', 'session.inject', { text: 'hi', images }, agentCall())
    ).resolves.toBeNull();
    expect(inject).toHaveBeenLastCalledWith('a.b', expect.objectContaining({ images }));
    for (const bad of [
      [{ data: png, mimeType: 'text/html' }],
      [{ data: '不是base64', mimeType: 'image/png' }],
      Array.from({ length: 5 }, () => images[0]),
      'x',
    ])
      await expect(
        gate.handle('a.b', 'session.inject', { text: 'hi', images: bad }, agentCall())
      ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('session.abort 中止会话，跨会话同样受授权约束', async () => {
    const abort = vi.fn(() => ({ ok: true as const }));
    deps.abort = abort;
    deps.manifest = () => manifest({ permissions: ['agent.inject'] });
    gate = new PluginHostGate(deps);
    await expect(gate.handle('a.b', 'session.abort', {}, agentCall())).resolves.toBeNull();
    expect(abort).toHaveBeenLastCalledWith('a.b', 's1');
    await expect(
      gate.handle('a.b', 'session.abort', { sessionId: 'other' }, agentCall())
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    deps.crossSessionInject = () => true;
    gate = new PluginHostGate(deps);
    await expect(
      gate.handle('a.b', 'session.abort', { sessionId: 'other' }, agentCall())
    ).resolves.toBeNull();
    deps.manifest = () => manifest({ permissions: [] });
    gate = new PluginHostGate(deps);
    await expect(gate.handle('a.b', 'session.abort', {}, agentCall())).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });
});

describe('常驻进程里的会话操作', () => {
  it('不在调用里：须指明会话且已允许跨会话，才能注入和中止', async () => {
    const inject = vi.fn(() => ({ ok: true as const }));
    const abort = vi.fn(() => ({ ok: true as const }));
    deps.inject = inject;
    deps.abort = abort;
    deps.manifest = () => manifest({ permissions: ['agent.inject'] });
    gate = new PluginHostGate(deps);
    await expect(
      gate.handle('a.b', 'session.inject', { text: 'hi', sessionId: 's1' }, undefined)
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    deps.crossSessionInject = () => true;
    gate = new PluginHostGate(deps);
    await expect(
      gate.handle('a.b', 'session.inject', { text: 'hi' }, undefined)
    ).rejects.toMatchObject({
      code: 'NO_SESSION',
    });
    await expect(
      gate.handle('a.b', 'session.inject', { text: 'hi', sessionId: 's1' }, undefined)
    ).resolves.toBeNull();
    await expect(
      gate.handle('a.b', 'session.abort', { sessionId: 's1' }, undefined)
    ).resolves.toBeNull();
    expect(inject).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith('a.b', 's1');
  });
});
