import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>(),
  project: { kind: 'local', state: 'active', canonicalPath: '', sshHost: 'host' },
  conversation: { projectId: 'project', lifecycle: 'active' },
  exec: vi.fn(),
  writeText: vi.fn(),
  showItemInFolder: vi.fn(),
  openPath: vi.fn(),
  busy: vi.fn(() => false),
  readSettings: vi.fn((): Record<string, unknown> | null => null),
  search: vi.fn(async () => ({ ok: true as const, mode: 'names' as const, hits: [] })),
}));
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('node:path') }>();
  return { ...actual, default: { ...actual.default } };
});
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  clipboard: { writeText: mocks.writeText },
  shell: { showItemInFolder: mocks.showItemInFolder, openPath: mocks.openPath },
  ipcMain: { handle: (key: string, fn: never) => mocks.handlers.set(key, fn) },
}));
vi.mock('./worktree', () => ({ sessionWorktreeBusy: mocks.busy }));
vi.mock('./settings', async () => {
  const { normalizeContextMenuOpen, normalizeFileOpenRules } = await import('@shared/fileOpening');
  return {
    readContextMenuOpen: () => {
      const settings = mocks.readSettings();
      const store = settings?.['enso-settings'] as
        | { state?: { contextMenuOpen?: unknown } }
        | undefined;
      return normalizeContextMenuOpen(store?.state?.contextMenuOpen);
    },
    readFileOpenRules: () => {
      const settings = mocks.readSettings();
      const store = settings?.['enso-settings'] as
        | { state?: { fileOpenRules?: unknown } }
        | undefined;
      return normalizeFileOpenRules(store?.state?.fileOpenRules);
    },
    readSshTimeoutSeconds: () => 30,
  };
});
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => ({
    conversation: () => mocks.conversation,
    project: () => mocks.project,
  }),
}));
vi.mock('../services/browserFileRoot', () => ({
  resolveLocalCwdForBrowser: () => mocks.project.canonicalPath,
}));
vi.mock('../services/sshConnectionStore', () => ({
  getSshConnectionStore: () => ({ getSecret: () => undefined }),
}));
vi.mock('../../agent/ssh/executor', () => ({ createSshExecutor: () => ({ exec: mocks.exec }) }));
vi.mock('../services/workspaceFileSearch', () => ({
  searchWorkspaceFiles: mocks.search,
}));

import { registerFilesWorkspaceHandlers } from './filesWorkspace';

let root = '';
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'files-ipc-')));
  mocks.project = { kind: 'local', state: 'active', canonicalPath: root, sshHost: 'host' };
  mocks.conversation = { projectId: 'project', lifecycle: 'active' };
  mocks.exec.mockReset();
  mocks.busy.mockReturnValue(false);
  mocks.readSettings.mockReset().mockReturnValue(null);
  mocks.writeText.mockReset();
  mocks.showItemInFolder.mockReset();
  mocks.openPath.mockReset().mockResolvedValue('');
  mocks.search.mockReset();
  mocks.search.mockResolvedValue({ ok: true, mode: 'names', hits: [] });
  registerFilesWorkspaceHandlers();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const invoke = (channel: string, request = {}) =>
  mocks.handlers.get(channel)?.(
    {},
    { conversationId: 'conversation', projectId: 'project', rel: 'file', itemId: 'reveal', ...request }
  );
it('文件链接右键只采信 Main 配置，身份、远程与边界校验先于本机打开', async () => {
  const abs = path.join(root, 'readme.md');
  writeFileSync(abs, 'fixture');
  expect(await invoke(IPC_CHANNELS.FILES_OPEN_CONTEXT, { rel: 'readme.md' })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  const configured = {
    'enso-settings': {
      state: { contextMenuOpen: [{ id: 'reveal', target: 'reveal', enabled: true }] },
    },
  };
  mocks.readSettings.mockReturnValue(configured);
  expect(
    await invoke(IPC_CHANNELS.FILES_OPEN_CONTEXT, {
      rel: 'readme.md',
      target: 'application',
      applicationPath: '/bad/editor',
    })
  ).toEqual({ ok: true });
  expect(mocks.showItemInFolder).toHaveBeenCalledWith(abs);
  mocks.showItemInFolder.mockClear();
  expect(
    await invoke(IPC_CHANNELS.FILES_OPEN_CONTEXT, { rel: 'readme.md', itemId: 'unknown' })
  ).toEqual({ ok: false, error: 'unavailable' });
  mocks.readSettings.mockReturnValue({
    'enso-settings': {
      state: { contextMenuOpen: [{ id: 'reveal', target: 'reveal', enabled: false }] },
    },
  });
  expect(await invoke(IPC_CHANNELS.FILES_OPEN_CONTEXT, { rel: 'readme.md' })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  mocks.readSettings.mockReturnValue(configured);
  expect(await invoke(IPC_CHANNELS.FILES_OPEN_CONTEXT, { rel: '../escape.md' })).toEqual({
    ok: false,
    error: 'invalid-path',
  });
  mocks.project.kind = 'ssh';
  expect(await invoke(IPC_CHANNELS.FILES_OPEN_CONTEXT)).toEqual({ ok: false, error: 'unsupported' });
  mocks.project.kind = 'local';
  mocks.conversation.projectId = 'other';
  expect(await invoke(IPC_CHANNELS.FILES_OPEN_CONTEXT)).toEqual({ ok: false, error: 'unavailable' });
  expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  expect(mocks.openPath).not.toHaveBeenCalled();
});
it.each([
  ['readme.md', 'markdown'],
  ['source.ts', 'text'],
  ['picture.png', 'image'],
])('按默认类型返回内部查看器 %s', async (rel, viewer) => {
  writeFileSync(path.join(root, rel), 'fixture');
  expect(await invoke('files:open', { rel })).toEqual({
    ok: true,
    target: 'internal',
    viewer,
    rel,
  });
  expect(mocks.openPath).not.toHaveBeenCalled();
});
it('新打开通道只采信 Main 设置，不采信 renderer 的动作和应用路径', async () => {
  writeFileSync(path.join(root, 'readme.md'), 'fixture');
  mocks.readSettings.mockReturnValue({
    'enso-settings': { state: { fileOpenRules: [{ extension: 'md', target: 'reveal' }] } },
  });
  expect(
    await invoke('files:open', {
      rel: 'readme.md',
      target: 'application',
      applicationPath: '/malicious/editor',
    })
  ).toEqual({ ok: true, target: 'handled' });
  expect(mocks.showItemInFolder).toHaveBeenCalledWith(path.join(root, 'readme.md'));
  expect(mocks.openPath).not.toHaveBeenCalled();
});
it.each(['../outside.md', '/absolute.md', 'C:\\absolute.md', 'nested\\bad.md', 'bad\0.md'])(
  '新打开通道拒绝恶意路径 %s',
  async (rel) => {
    expect(await invoke('files:open', { rel })).toEqual({ ok: false, error: 'invalid-path' });
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  }
);
it('新打开通道拒绝缺失目标与越界软链接', async () => {
  expect(await invoke('files:open', { rel: 'missing.md' })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  symlinkSync(os.tmpdir(), path.join(root, 'escape'), 'junction');
  expect(await invoke('files:open', { rel: 'escape/outside.md' })).toEqual({
    ok: false,
    error: 'invalid-path',
  });
  expect(mocks.openPath).not.toHaveBeenCalled();
});
it('新打开通道拒绝错误身份、迁移中工作区和非字符串 rel', async () => {
  writeFileSync(path.join(root, 'file'), 'fixture');
  mocks.conversation.projectId = 'other';
  expect(await invoke('files:open')).toEqual({ ok: false, error: 'unavailable' });
  mocks.conversation.projectId = 'project';
  mocks.busy.mockReturnValue(true);
  expect(await invoke('files:open')).toEqual({ ok: false, error: 'unavailable' });
  mocks.busy.mockReturnValue(false);
  expect(await invoke('files:open', { rel: 12 })).toEqual({ ok: false, error: 'unavailable' });
  expect(mocks.openPath).not.toHaveBeenCalled();
});
it('新打开通道 SSH 明确不支持且不执行本机打开', async () => {
  mocks.project.kind = 'ssh';
  expect(await invoke('files:open', { rel: 'readme.md' })).toEqual({
    ok: false,
    error: 'unsupported',
  });
  expect(mocks.exec).not.toHaveBeenCalled();
  expect(mocks.openPath).not.toHaveBeenCalled();
});
it('新打开通道报告目录定位错误', async () => {
  mkdirSync(path.join(root, 'dir'));
  mocks.openPath.mockResolvedValue('Explorer failed');
  expect(await invoke('files:open', { rel: 'dir' })).toEqual({
    ok: false,
    error: 'Explorer failed',
  });
});
it.each([
  IPC_CHANNELS.FILES_WRITE,
  IPC_CHANNELS.FILES_CREATE,
  IPC_CHANNELS.FILES_MKDIR,
  IPC_CHANNELS.FILES_RENAME,
  IPC_CHANNELS.FILES_REMOVE,
])('blocks local mutation %s while the shared workspace is switching', async (channel) => {
  writeFileSync(path.join(root, 'file'), 'original');
  mocks.busy.mockReturnValue(true);
  expect(await invoke(channel, { content: 'changed', name: 'new' })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  expect(readFileSync(path.join(root, 'file'), 'utf8')).toBe('original');
  expect(existsSync(path.join(root, 'new'))).toBe(false);
});
it('拒绝不匹配的会话项目且不写剪贴板', async () => {
  mocks.conversation.projectId = 'other';
  expect(await invoke(IPC_CHANNELS.FILES_COPY_PATH, { mode: 'relative' })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  expect(mocks.writeText).not.toHaveBeenCalled();
});
it('已结束 SSH 会话拒绝访问', async () => {
  mocks.conversation.lifecycle = 'ended';
  remote();
  expect(await invoke(IPC_CHANNELS.FILES_ABS)).toEqual({ ok: false, error: 'unavailable' });
  expect(mocks.exec).not.toHaveBeenCalled();
});
it('失效 SSH 项目不能回退本地', async () => {
  mocks.project.kind = 'ssh';
  mocks.project.sshHost = '';
  expect(await invoke(IPC_CHANNELS.FILES_ABS)).toEqual({ ok: false, error: 'unavailable' });
});
it.each(['.', './', 'nested/../'])('拒绝根目录重命名 %s', async (rel) => {
  expect(await invoke(IPC_CHANNELS.FILES_RENAME, { rel, name: 'renamed' })).toEqual({
    ok: false,
    error: 'invalid-path',
  });
});
it('拒绝工作区内部绝对路径', async () => {
  expect(await invoke(IPC_CHANNELS.FILES_ABS, { rel: path.join(root, 'file') })).toEqual({
    ok: false,
    error: 'invalid-path',
  });
});
it('本地文件链接定位并选中文件，不执行 exe', async () => {
  const exe = path.join(root, 'EnsoCode-Setup-0.1.32.exe');
  writeFileSync(exe, 'not an executable in test');
  expect(await invoke(IPC_CHANNELS.FILES_REVEAL, { rel: 'EnsoCode-Setup-0.1.32.exe' })).toEqual({
    ok: true,
  });
  expect(mocks.showItemInFolder).toHaveBeenCalledWith(exe);
  expect(mocks.openPath).not.toHaveBeenCalled();
});
it('本地目录链接打开目录', async () => {
  const dir = path.join(root, '中文 空格');
  mkdirSync(dir);
  expect(await invoke(IPC_CHANNELS.FILES_REVEAL, { rel: '中文 空格' })).toEqual({ ok: true });
  expect(mocks.openPath).toHaveBeenCalledWith(dir);
  expect(mocks.showItemInFolder).not.toHaveBeenCalled();
});
it('本地文件链接目标不存在时明确失败', async () => {
  expect(await invoke(IPC_CHANNELS.FILES_REVEAL, { rel: 'missing.md' })).toEqual({
    ok: false,
    error: 'unavailable',
  });
  expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  expect(mocks.openPath).not.toHaveBeenCalled();
});
it('本地文件链接越出工作区时拒绝', async () => {
  expect(await invoke(IPC_CHANNELS.FILES_REVEAL, { rel: '../outside.md' })).toEqual({
    ok: false,
    error: 'invalid-path',
  });
  expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  expect(mocks.openPath).not.toHaveBeenCalled();
});
it('目录打开失败时返回系统错误', async () => {
  mkdirSync(path.join(root, 'broken-open'));
  mocks.openPath.mockResolvedValue('Explorer failed');
  expect(await invoke(IPC_CHANNELS.FILES_REVEAL, { rel: 'broken-open' })).toEqual({
    ok: false,
    error: 'Explorer failed',
  });
});
it('SSH 工作区不误开本机路径', async () => {
  remote();
  expect(await invoke(IPC_CHANNELS.FILES_REVEAL, { rel: 'remote/file.md' })).toEqual({
    ok: false,
    error: 'unsupported',
  });
  expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  expect(mocks.openPath).not.toHaveBeenCalled();
});
it('拒绝软链接指向工作区外的新建路径', async () => {
  symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  expect(await invoke(IPC_CHANNELS.FILES_CREATE, { rel: 'escape', name: 'never-create' })).toEqual({
    ok: false,
    error: 'invalid-path',
  });
});
it('相对路径复制也必须验证路径', async () => {
  expect(
    await invoke(IPC_CHANNELS.FILES_COPY_PATH, { mode: 'relative', rel: '../escape' })
  ).toEqual({ ok: false, error: 'invalid-path' });
});
function remote() {
  mocks.project.kind = 'ssh';
  mocks.exec.mockImplementation(async (args: string[]) => {
    const result = spawnSync(args[0], args.slice(1), {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
      timeout: 10_000,
    });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  });
}
it('SSH 创建同名文件报告冲突且不覆盖', { timeout: 20_000 }, async () => {
  remote();
  writeFileSync(path.join(root, 'file'), 'keep');
  expect(await invoke(IPC_CHANNELS.FILES_CREATE, { rel: '', name: 'file' })).toEqual({
    ok: false,
    error: 'exists',
  });
  expect(readFileSync(path.join(root, 'file'), 'utf8')).toBe('keep');
});
it('Windows 客户端也拒绝删除 SSH 根目录', async () => {
  remote();
  const remoteRoot = root;
  const original = path.resolve;
  const spy = vi
    .spyOn(path, 'resolve')
    .mockImplementation((...parts) =>
      parts.length === 1 && parts[0] === remoteRoot
        ? path.win32.resolve(...parts)
        : original(...parts)
    );
  mocks.exec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  try {
    expect(await invoke(IPC_CHANNELS.FILES_REMOVE, { rel: '.' })).toEqual({
      ok: false,
      error: 'invalid-path',
    });
    expect(mocks.exec.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
it('SSH 在本机 shell 支持成功重命名', { timeout: 20_000 }, async () => {
  remote();
  writeFileSync(path.join(root, 'file'), 'keep');
  expect(await invoke(IPC_CHANNELS.FILES_RENAME, { name: 'renamed' })).toEqual({
    ok: true,
    rel: 'renamed',
  });
  expect(readFileSync(path.join(root, 'renamed'), 'utf8')).toBe('keep');
  expect(existsSync(path.join(root, 'file'))).toBe(false);
});
it('SSH 重命名不将源移动到已有目录内', { timeout: 20_000 }, async () => {
  remote();
  writeFileSync(path.join(root, 'file'), 'keep');
  mkdirSync(path.join(root, 'taken'));
  expect(await invoke(IPC_CHANNELS.FILES_RENAME, { name: 'taken' })).toEqual({
    ok: false,
    error: 'exists',
  });
  expect(existsSync(path.join(root, 'file'))).toBe(true);
  expect(existsSync(path.join(root, 'taken/file'))).toBe(false);
});
it('SSH 拒绝软链接逃逸', { timeout: 20_000 }, async () => {
  remote();
  symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  expect(await invoke(IPC_CHANNELS.FILES_ABS, { rel: 'escape' })).toEqual({
    ok: false,
    error: 'invalid-path',
  });
});
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

it('Markdown 预览读图片：本地位图返回 data URL', async () => {
  writeFileSync(path.join(root, 'a.png'), PNG_MAGIC);
  expect(await invoke(IPC_CHANNELS.FILES_READ_IMAGE, { rel: 'a.png' })).toEqual({
    ok: true,
    dataUrl: `data:image/png;base64,${PNG_MAGIC.toString('base64')}`,
  });
});
it('Markdown 预览读图片：内容魔数与扩展名不符时拒绝（改后缀伪装）', async () => {
  writeFileSync(path.join(root, 'fake.png'), '<svg onload="alert(1)"></svg>');
  expect(await invoke(IPC_CHANNELS.FILES_READ_IMAGE, { rel: 'fake.png' })).toEqual({
    ok: false,
    error: 'unsupported',
  });
});
it('Markdown 预览读图片：svg 支持（只通过 <img> 标签渲染，浏览器按图片上下文禁脚本）', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  writeFileSync(path.join(root, 'a.svg'), svg);
  expect(await invoke(IPC_CHANNELS.FILES_READ_IMAGE, { rel: 'a.svg' })).toEqual({
    ok: true,
    dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  });
});
it('Markdown 预览读图片：未知扩展名不支持', async () => {
  writeFileSync(path.join(root, 'a.txt'), 'plain text');
  expect(await invoke(IPC_CHANNELS.FILES_READ_IMAGE, { rel: 'a.txt' })).toEqual({
    ok: false,
    error: 'unsupported',
  });
});
it('Markdown 预览读图片：越权路径拒绝', async () => {
  expect(await invoke(IPC_CHANNELS.FILES_READ_IMAGE, { rel: '../escape.png' })).toEqual({
    ok: false,
    error: 'invalid-path',
  });
});
it('Markdown 预览读图片：SSH 走 base64 命令解析', { timeout: 20_000 }, async () => {
  remote();
  writeFileSync(path.join(root, 'a.jpg'), JPEG_MAGIC);
  expect(await invoke(IPC_CHANNELS.FILES_READ_IMAGE, { rel: 'a.jpg' })).toEqual({
    ok: true,
    dataUrl: `data:image/jpeg;base64,${JPEG_MAGIC.toString('base64')}`,
  });
});
it('Markdown 预览读图片：SSH 内容魔数与声明 mime 不符时拒绝', { timeout: 20_000 }, async () => {
  remote();
  writeFileSync(path.join(root, 'fake.jpg'), '<svg onload="alert(1)"></svg>');
  expect(await invoke(IPC_CHANNELS.FILES_READ_IMAGE, { rel: 'fake.jpg' })).toEqual({
    ok: false,
    error: 'unsupported',
  });
});
it('剪贴板异常返回结果', async () => {
  writeFileSync(path.join(root, 'file'), '');
  mocks.writeText.mockImplementation(() => {
    throw new Error('clipboard');
  });
  expect(await invoke(IPC_CHANNELS.FILES_COPY_PATH, { mode: 'relative' })).toEqual({
    ok: false,
    error: 'unavailable',
  });
});
it('工作区搜索拒绝不匹配的会话且不跑 rg', async () => {
  mocks.conversation.projectId = 'other';
  expect(
    await invoke(IPC_CHANNELS.FILES_SEARCH_WORKSPACE, { query: 'chat', mode: 'names' })
  ).toEqual({ ok: false, error: 'unavailable' });
  expect(mocks.search).not.toHaveBeenCalled();
});
it('SSH 工作区搜索不跑本地 rg', async () => {
  remote();
  expect(
    await invoke(IPC_CHANNELS.FILES_SEARCH_WORKSPACE, { query: 'chat', mode: 'names' })
  ).toEqual({ ok: false, error: 'unsupported' });
  expect(mocks.search).not.toHaveBeenCalled();
});
it('本地搜索 cwd 来自会话而不是请求路径', async () => {
  await invoke(IPC_CHANNELS.FILES_SEARCH_WORKSPACE, {
    query: 'chat',
    mode: 'names',
    cwd: '/etc',
    rootPath: '/etc',
  });
  expect(mocks.search).toHaveBeenCalledWith(
    root,
    expect.objectContaining({
      conversationId: 'conversation',
      projectId: 'project',
      query: 'chat',
      mode: 'names',
    })
  );
});
