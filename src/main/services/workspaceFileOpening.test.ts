import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canOpenWorkspaceFileExternally,
  launchWorkspaceFileApplication,
  openLocalWorkspaceFile,
  openLocalWorkspaceFileContext,
  openWorkspacePdfWindow,
  type WorkspaceFileOpeningDependencies,
} from './workspaceFileOpening';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  windowOptions: vi.fn(),
  windowOpen: vi.fn(),
  on: vi.fn(),
  loadFile: vi.fn(),
  destroy: vi.fn(),
  permissionRequest: vi.fn(),
  permissionCheck: vi.fn(),
  mainFrame: { url: '' },
  realPaths: new Map<string, string>(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: (file: string) => mocks.realPaths.get(file) ?? actual.realpathSync(file),
  };
});
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: unknown) {
      mocks.windowOptions(options);
    }
    webContents = {
      mainFrame: mocks.mainFrame,
      setWindowOpenHandler: mocks.windowOpen,
      on: mocks.on,
      session: {
        setPermissionRequestHandler: mocks.permissionRequest,
        setPermissionCheckHandler: mocks.permissionCheck,
      },
    };
    loadFile = mocks.loadFile;
    destroy = mocks.destroy;
  },
  shell: {},
}));

let root: string;
let dependencies: WorkspaceFileOpeningDependencies;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'workspace-opening-')));
  dependencies = {
    platform: 'win32',
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
    previewPdf: vi.fn(async () => {}),
    launchApplication: vi.fn(async () => {}),
  };
  mocks.spawn.mockReset();
  mocks.windowOptions.mockReset();
  mocks.windowOpen.mockReset();
  mocks.on.mockReset();
  mocks.loadFile.mockReset().mockResolvedValue(undefined);
  mocks.destroy.mockReset();
  mocks.permissionRequest.mockReset();
  mocks.permissionCheck.mockReset();
  mocks.mainFrame.url = '';
  mocks.realPaths.clear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const file = (rel: string) => {
  const abs = path.join(root, rel);
  writeFileSync(abs, rel.endsWith('.pdf') ? '%PDF-1.7\nfixture' : 'fixture');
  return abs;
};

describe('文件链接右键打开', () => {
  it('默认只定位文件，VS Code 可打开源码且工作目录使用父目录', async () => {
    const abs = file('source.ts');
    const context = { ...dependencies, openVSCode: vi.fn(async () => ({ ok: true })) };
    expect(
      await openLocalWorkspaceFileContext(root, 'source.ts', { target: 'reveal' }, context)
    ).toEqual({ ok: true });
    expect(context.showItemInFolder).toHaveBeenCalledWith(abs);
    expect(context.openVSCode).not.toHaveBeenCalled();
    expect(
      await openLocalWorkspaceFileContext(root, 'source.ts', { target: 'vscode' }, context)
    ).toEqual({ ok: true });
    expect(context.openVSCode).toHaveBeenCalledWith(abs, root);
    expect(context.openPath).not.toHaveBeenCalled();
  });

  it.each(['中文 报告.txt', 'source.ts'])(
    '指定应用需验证真实可执行路径，独立传递文件参数 %s',
    async (rel) => {
      const abs = file(rel);
      const applicationPath = file('Editor.exe');
      const context = { ...dependencies, openVSCode: vi.fn(async () => ({ ok: true })) };
      expect(
        await openLocalWorkspaceFileContext(
          root,
          rel,
          { target: 'application', applicationPath },
          context
        )
      ).toEqual({ ok: true });
      expect(context.launchApplication).toHaveBeenCalledWith(applicationPath, abs);
      expect(
        await openLocalWorkspaceFileContext(
          root,
          rel,
          { target: 'application', applicationPath: path.join(root, 'missing.exe') },
          context
        )
      ).toEqual({ ok: false, error: 'invalid-application' });
      expect(context.launchApplication).toHaveBeenCalledTimes(1);
    }
  );

  it('拒绝越界目标，可执行文件和伪装链接仍仅定位', async () => {
    const exe = file('payload.exe');
    const alias = file('alias.txt');
    mocks.realPaths.set(alias, exe);
    const context = { ...dependencies, openVSCode: vi.fn(async () => ({ ok: true })) };
    expect(
      await openLocalWorkspaceFileContext(root, '../outside.txt', { target: 'vscode' }, context)
    ).toEqual({ ok: false, error: 'invalid-path' });
    expect(
      await openLocalWorkspaceFileContext(root, 'alias.txt', { target: 'vscode' }, context)
    ).toEqual({ ok: true });
    expect(context.showItemInFolder).toHaveBeenCalledWith(exe);
    expect(context.openVSCode).not.toHaveBeenCalled();
    expect(context.launchApplication).not.toHaveBeenCalled();
  });
});

describe('本地工作区文件按类型打开', () => {
  it('PDF 仅由安全内部预览处理', async () => {
    const abs = file('中文 报告.pdf');
    expect(await openLocalWorkspaceFile(root, '中文 报告.pdf', [], dependencies)).toEqual({
      ok: true,
      target: 'handled',
    });
    expect(dependencies.previewPdf).toHaveBeenCalledWith(abs);
    expect(dependencies.openPath).not.toHaveBeenCalled();
  });
  it('PDF 预览拒绝 HTML 假后缀与软链接伪装的真实 HTML 目标', async () => {
    const html = file('payload.html');
    const disguised = file('disguised.pdf');
    writeFileSync(disguised, '<html><script>bad()</script></html>');
    expect(await openLocalWorkspaceFile(root, 'disguised.pdf', [], dependencies)).toEqual({
      ok: false,
      error: 'unsupported-viewer',
    });
    const alias = file('alias.pdf');
    mocks.realPaths.set(alias, html);
    expect(await openLocalWorkspaceFile(root, 'alias.pdf', [], dependencies)).toEqual({
      ok: false,
      error: 'unsupported-viewer',
    });
    expect(dependencies.previewPdf).not.toHaveBeenCalled();
    expect(dependencies.openPath).not.toHaveBeenCalled();
  });
  it('未知文件仅定位，显式内部规则也不能任意读取二进制', async () => {
    const abs = file('unknown.data');
    expect(await openLocalWorkspaceFile(root, 'unknown.data', [], dependencies)).toEqual({
      ok: true,
      target: 'handled',
    });
    expect(dependencies.showItemInFolder).toHaveBeenCalledWith(abs);
    expect(
      await openLocalWorkspaceFile(
        root,
        'unknown.data',
        [{ extension: '.data', target: 'internal' }],
        dependencies
      )
    ).toEqual({ ok: false, error: 'unsupported-viewer' });
  });
  it.each(['exe', 'msi', 'com', 'lnk', 'bat', 'cmd', 'ps1', 'app'])(
    '外部规则不能执行 %s',
    async (extension) => {
      const abs = file(`danger.${extension}`);
      for (const target of ['system', 'application'] as const) {
        expect(
          await openLocalWorkspaceFile(
            root,
            `danger.${extension}`,
            [
              {
                extension: `.${extension}`,
                target,
                ...(target === 'application' ? { applicationPath: abs } : {}),
              },
            ],
            dependencies
          )
        ).toEqual({ ok: true, target: 'handled' });
      }
      expect(dependencies.openPath).not.toHaveBeenCalled();
      expect(dependencies.launchApplication).not.toHaveBeenCalled();
      expect(dependencies.showItemInFolder).toHaveBeenCalledWith(abs);
    }
  );
  it('普通目录打开但应用包目录只能定位', async () => {
    mkdirSync(path.join(root, 'dir'));
    mkdirSync(path.join(root, 'Danger.app'));
    expect(await openLocalWorkspaceFile(root, 'dir', [], dependencies)).toEqual({
      ok: true,
      target: 'handled',
    });
    expect(dependencies.openPath).toHaveBeenCalledWith(path.join(root, 'dir'));
    expect(await openLocalWorkspaceFile(root, 'Danger.app', [], dependencies)).toEqual({
      ok: true,
      target: 'handled',
    });
    expect(dependencies.showItemInFolder).toHaveBeenCalledWith(path.join(root, 'Danger.app'));
    expect(dependencies.openPath).toHaveBeenCalledTimes(1);
  });
  it('系统打开只允许安全文件，并报告操作系统错误', async () => {
    const abs = file('report.csv');
    const rules = [{ extension: '.csv', target: 'system' as const }];
    expect(await openLocalWorkspaceFile(root, 'report.csv', rules, dependencies)).toEqual({
      ok: true,
      target: 'handled',
    });
    expect(dependencies.openPath).toHaveBeenCalledWith(abs);
    vi.mocked(dependencies.openPath).mockResolvedValue('failed to open');
    expect(await openLocalWorkspaceFile(root, 'report.csv', rules, dependencies)).toEqual({
      ok: false,
      error: 'failed to open',
    });
  });
  it('应用路径必须存在且不能是命令参数字符串，启动失败不伪造成功', async () => {
    const abs = file('report.csv');
    const applicationPath = file('Reader.exe');
    expect(
      await openLocalWorkspaceFile(
        root,
        'report.csv',
        [{ extension: '.csv', target: 'application', applicationPath }],
        dependencies
      )
    ).toEqual({ ok: true, target: 'handled' });
    expect(dependencies.launchApplication).toHaveBeenCalledWith(applicationPath, abs);
    expect(
      await openLocalWorkspaceFile(
        root,
        'report.csv',
        [{ extension: '.csv', target: 'application', applicationPath: `${applicationPath} --run` }],
        dependencies
      )
    ).toEqual({ ok: false, error: 'invalid-application' });
    expect(
      await openLocalWorkspaceFile(
        root,
        'report.csv',
        [
          {
            extension: '.csv',
            target: 'application',
            applicationPath: path.join(root, 'missing.exe'),
          },
        ],
        dependencies
      )
    ).toEqual({ ok: false, error: 'invalid-application' });
    vi.mocked(dependencies.launchApplication).mockRejectedValue(new Error('spawn failed'));
    expect(
      await openLocalWorkspaceFile(
        root,
        'report.csv',
        [{ extension: '.csv', target: 'application', applicationPath }],
        dependencies
      )
    ).toEqual({ ok: false, error: 'unavailable' });
  });
  it('工作区内软链接也不能掩盖危险真实后缀', async () => {
    const application = path.join(root, 'Danger.app');
    mkdirSync(application);
    symlinkSync(application, path.join(root, 'alias.csv'), 'junction');
    expect(
      await openLocalWorkspaceFile(
        root,
        'alias.csv',
        [{ extension: '.csv', target: 'system' }],
        dependencies
      )
    ).toEqual({ ok: true, target: 'handled' });
    expect(dependencies.openPath).not.toHaveBeenCalled();
    expect(dependencies.showItemInFolder).toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')('Linux 可执行位阻止非脚本后缀的外部打开', async () => {
    const abs = file('danger.csv');
    chmodSync(abs, 0o755);
    dependencies.platform = 'linux';
    expect(
      await openLocalWorkspaceFile(
        root,
        'danger.csv',
        [{ extension: '.csv', target: 'system' }],
        dependencies
      )
    ).toEqual({ ok: true, target: 'handled' });
    expect(dependencies.openPath).not.toHaveBeenCalled();
    expect(dependencies.showItemInFolder).toHaveBeenCalledWith(abs);
  });
  it('定位异常与预览失败明确失败', async () => {
    file('unknown.data');
    vi.mocked(dependencies.showItemInFolder).mockImplementation(() => {
      throw new Error('failed');
    });
    expect(await openLocalWorkspaceFile(root, 'unknown.data', [], dependencies)).toEqual({
      ok: false,
      error: 'unavailable',
    });
    file('report.pdf');
    vi.mocked(dependencies.previewPdf).mockRejectedValue(new Error('preview failed'));
    expect(await openLocalWorkspaceFile(root, 'report.pdf', [], dependencies)).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('Unix 执行位判定不依赖测试机文件模式', () => {
    expect(canOpenWorkspaceFileExternally('a.csv', 0o755, 'linux')).toBe(false);
    expect(canOpenWorkspaceFileExternally('a.csv', 0o755, 'darwin')).toBe(false);
    expect(canOpenWorkspaceFileExternally('a.csv', 0o644, 'linux')).toBe(true);
    expect(canOpenWorkspaceFileExternally('a.csv', 0o755, 'win32')).toBe(true);
    expect(canOpenWorkspaceFileExternally('a.pif', 0o644, 'win32')).toBe(false);
  });

  it('文件软链接真实目标不能用隐藏危险后缀绕过外部守卫', async () => {
    const dangerous = file('.pif');
    const alias = file('alias.csv');
    mocks.realPaths.set(alias, dangerous);
    expect(
      await openLocalWorkspaceFile(
        root,
        'alias.csv',
        [{ extension: '.csv', target: 'system' }],
        dependencies
      )
    ).toEqual({ ok: true, target: 'handled' });
    expect(dependencies.openPath).not.toHaveBeenCalled();
    expect(dependencies.showItemInFolder).toHaveBeenCalledWith(dangerous);
  });

  it('Windows/Linux 启动应用时不启用 shell 且路径保持一个参数', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as ChildProcess;
      child.unref = vi.fn(() => child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    await launchWorkspaceFileApplication(
      'C:\\Program Files\\Reader.exe',
      'C:\\Workspace\\中文 报告.csv',
      'win32'
    );
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      'C:\\Program Files\\Reader.exe',
      ['C:\\Workspace\\中文 报告.csv'],
      { shell: false, stdio: 'ignore' }
    );
    await launchWorkspaceFileApplication('/opt/Reader App/reader', '/work/中文 报告.csv', 'linux');
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      '/opt/Reader App/reader',
      ['/work/中文 报告.csv'],
      { shell: false, stdio: 'ignore' }
    );
  });

  it('Mac 用系统 open -a 和 -- 分隔，并报告启动错误和非零退出', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    await launchWorkspaceFileApplication(
      '/Applications/Reader App.app',
      '/work/report.pdf',
      'darwin'
    );
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      '/usr/bin/open',
      ['-a', '/Applications/Reader App.app', '--', '/work/report.pdf'],
      { shell: false, stdio: 'ignore' }
    );
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    });
    await expect(
      launchWorkspaceFileApplication('/missing', '/work/report.pdf', 'linux')
    ).rejects.toThrow('spawn failed');
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });
    await expect(
      launchWorkspaceFileApplication('/missing.app', '/work/report.pdf', 'darwin')
    ).rejects.toThrow();
  });

  it('PDF 窗口无 preload、沙箱隔离且阻止导航、新窗口与 WebView', async () => {
    const pdf = file('report.pdf');
    await openWorkspacePdfWindow(pdf);
    expect(mocks.windowOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          plugins: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
          partition: expect.stringMatching(/^workspace-pdf-/),
        }),
      })
    );
    expect(mocks.windowOptions.mock.calls[0][0].webPreferences).not.toHaveProperty('preload');
    expect(mocks.windowOpen.mock.calls[0][0]()).toEqual({ action: 'deny' });
    expect(mocks.on.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining([
        'will-navigate',
        'will-frame-navigate',
        'will-redirect',
        'will-attach-webview',
      ])
    );
    expect(mocks.permissionCheck.mock.calls[0][0]()).toBe(false);
    const callback = vi.fn();
    mocks.permissionRequest.mock.calls[0][0]({}, 'camera', callback);
    expect(callback).toHaveBeenCalledWith(false);
    for (const [, listener] of mocks.on.mock.calls) {
      const preventDefault = vi.fn();
      listener({ preventDefault });
      expect(preventDefault).toHaveBeenCalled();
    }
    mocks.loadFile.mockRejectedValue(new Error('load failed'));
    await expect(openWorkspacePdfWindow(pdf)).rejects.toThrow('load failed');
    expect(mocks.destroy).toHaveBeenCalled();
  });

  it('PDF 内置 viewer 的初始 stream 子帧可以导航，避免只有 toolbar 而无正文', async () => {
    const pdf = file('中文 # 报告.pdf');
    mocks.mainFrame.url = pathToFileURL(pdf).href;
    await openWorkspacePdfWindow(pdf);
    const viewer = {
      url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
      parent: mocks.mainFrame,
    };
    const preventDefault = vi.fn();
    const listener = mocks.on.mock.calls.find(([name]) => name === 'will-frame-navigate')?.[1];
    listener({
      preventDefault,
      url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/d943b806-44bf-4fb3-bcd4-a5b0255631f2',
      isMainFrame: false,
      frame: { url: '', parent: viewer },
      initiator: viewer,
    });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('PDF stream 例外不允许主帧、已加载帧、其他来源或任意 extension 路径导航', async () => {
    const pdf = file('report.pdf');
    mocks.mainFrame.url = pathToFileURL(pdf).href;
    await openWorkspacePdfWindow(pdf);
    const viewer = {
      url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
      parent: mocks.mainFrame,
    };
    const streamUrl =
      'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/d943b806-44bf-4fb3-bcd4-a5b0255631f2';
    const initial = {
      url: streamUrl,
      isMainFrame: false,
      frame: { url: '', parent: viewer },
      initiator: viewer,
    };
    const invalid = [
      { isMainFrame: true },
      { frame: { url: mocks.mainFrame.url, parent: viewer } },
      { frame: null },
      { initiator: null },
      { initiator: { ...viewer } },
      { frame: { url: '', parent: { ...viewer, parent: { ...mocks.mainFrame } } } },
      { frame: { url: '', parent: { ...viewer, url: `${viewer.url}?other` } } },
      { url: 'https://example.invalid/report.pdf' },
      { url: pathToFileURL(file('other.pdf')).href },
      { url: viewer.url },
      { url: `${streamUrl}?other` },
      { url: `${streamUrl}#other` },
      { url: `${streamUrl}/other` },
      { url: streamUrl.replace('mhjfbmdgcfjbbpaeojofohoefgiehjai', 'other-extension') },
    ];
    for (const [name, listener] of mocks.on.mock.calls) {
      if (!['will-frame-navigate', 'will-navigate', 'will-redirect'].includes(name)) continue;
      const cases = name === 'will-frame-navigate' ? invalid : [{}, ...invalid];
      for (const override of cases) {
        const preventDefault = vi.fn();
        listener({ ...initial, ...override, preventDefault });
        expect(preventDefault).toHaveBeenCalledOnce();
      }
    }
    mocks.mainFrame.url = pathToFileURL(path.join(root, 'other.pdf')).href;
    const preventDefault = vi.fn();
    const listener = mocks.on.mock.calls.find(([name]) => name === 'will-frame-navigate')?.[1];
    listener({ ...initial, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
