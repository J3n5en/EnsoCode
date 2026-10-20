import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type ContextMenuOpenTarget,
  type FileOpenRule,
  fileOpenExtension,
  fileOpenViewer,
  isExternalFileOpenBlocked,
  isFileOpenApplicationPath,
  resolveFileOpenTarget,
} from '@shared/fileOpening';
import type { FilesMutateResult, FilesOpenResult } from '@shared/types/filesWorkspace';
import { BrowserWindow, shell } from 'electron';
import { resolveLocalUnderCwd } from './filesWorkspace';
import { openInApps } from './openInApps';

const PDF_VIEWER_URL = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html';
const PDF_STREAM_URL =
  /^chrome-extension:\/\/mhjfbmdgcfjbbpaeojofohoefgiehjai\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface WorkspaceFileOpeningDependencies {
  platform: NodeJS.Platform;
  openPath: (file: string) => Promise<string>;
  showItemInFolder: (file: string) => void;
  previewPdf: (file: string) => Promise<void>;
  launchApplication: (application: string, file: string) => Promise<void>;
}

/**
 * 外部打开同时检查扩展名与 Unix 执行位，避免文件关联或伪装后缀执行脚本与程序。
 *
 * External opening checks both extensions and Unix executable bits to prevent executing programs
 * or scripts through file associations or disguised extensions.
 */
export function canOpenWorkspaceFileExternally(
  rel: string,
  mode: number,
  platform: NodeJS.Platform
): boolean {
  return !isExternalFileOpenBlocked(rel) && (platform === 'win32' || (mode & 0o111) === 0);
}

function isPdfFile(file: string): boolean {
  if (path.extname(file).toLowerCase() !== '.pdf') return false;
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(5);
    return (
      readSync(fd, header, 0, header.length, 0) === header.length &&
      header.toString('ascii') === '%PDF-'
    );
  } finally {
    closeSync(fd);
  }
}

/**
 * PDF 使用独立的无 preload 沙箱窗口，只允许内置 viewer 初始化已验证 PDF 的 stream 子帧；
 * 其他页面导航、新窗口和 WebView 一律禁止，加载失败不会返回成功。
 *
 * PDFs use a separate sandboxed window without preload, allowing only the built-in viewer's
 * initial stream child frame for the validated PDF. All other navigation, new windows, and
 * WebViews are denied; failed loading is never reported as success.
 */
export async function openWorkspacePdfWindow(file: string): Promise<void> {
  if (!isPdfFile(file)) throw new Error('unsupported-viewer');
  const win = new BrowserWindow({
    width: 900,
    height: 1100,
    title: path.basename(file),
    autoHideMenuBar: true,
    webPreferences: {
      plugins: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      partition: `workspace-pdf-${randomUUID()}`,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  const pdfUrl = pathToFileURL(file).href;
  win.webContents.on('will-frame-navigate', (event) => {
    const viewer = event.frame?.parent;
    const initialPdfStream =
      !event.isMainFrame &&
      event.frame?.url === '' &&
      viewer?.url === PDF_VIEWER_URL &&
      event.initiator === viewer &&
      viewer.parent === win.webContents.mainFrame &&
      win.webContents.mainFrame.url === pdfUrl &&
      PDF_STREAM_URL.test(event.url);
    if (!initialPdfStream) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  );
  win.webContents.session.setPermissionCheckHandler(() => false);
  try {
    await win.loadFile(file);
  } catch (error) {
    win.destroy();
    throw error;
  }
}

/**
 * 直接传递应用与文件作为独立参数，永不启用 shell；Mac 只使用系统 open 的 -a 与 -- 分隔。
 *
 * Pass the application and file as separate arguments without a shell; macOS only uses the system
 * open command with -a and the -- separator.
 */
export function launchWorkspaceFileApplication(
  application: string,
  file: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  return new Promise((resolve, reject) => {
    const mac = platform === 'darwin';
    const child = spawn(
      mac ? '/usr/bin/open' : application,
      mac ? ['-a', application, '--', file] : [file],
      { shell: false, stdio: 'ignore' }
    );
    child.once('error', reject);
    if (mac) {
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Application open failed: ${code}`))
      );
    } else {
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    }
  });
}

function resolveApplication(application: unknown, platform: NodeJS.Platform): string | null {
  if (!isFileOpenApplicationPath(application) || !path.isAbsolute(application)) return null;
  try {
    const real = realpathSync(application);
    const stat = statSync(real);
    if (platform === 'darwin' && stat.isDirectory() && /\.app$/i.test(real)) return real;
    if (!stat.isFile()) return null;
    if (platform === 'win32') return /\.exe$/i.test(real) ? real : null;
    return (stat.mode & 0o111) !== 0 ? real : null;
  } catch {
    return null;
  }
}

function defaultDependencies(): WorkspaceFileOpeningDependencies {
  return {
    platform: process.platform,
    openPath: (file) => shell.openPath(file),
    showItemInFolder: (file) => shell.showItemInFolder(file),
    previewPdf: openWorkspacePdfWindow,
    launchApplication: launchWorkspaceFileApplication,
  };
}

type ContextOpeningDependencies = Pick<
  WorkspaceFileOpeningDependencies,
  'platform' | 'openPath' | 'showItemInFolder' | 'launchApplication'
> & {
  openVSCode: (file: string, cwd: string) => Promise<{ ok: boolean; error?: string }>;
};

export async function openLocalWorkspaceFileContext(
  cwd: string,
  rel: string,
  config: ContextMenuOpenTarget,
  dependencies: ContextOpeningDependencies = {
    ...defaultDependencies(),
    openVSCode: (file, directory) => openInApps.open('vscode', file, directory),
  }
): Promise<FilesMutateResult> {
  if (/[\p{Cc}:]/u.test(rel)) return { ok: false, error: 'invalid-path' };
  const abs = resolveLocalUnderCwd(cwd, rel);
  if (!abs) return { ok: false, error: 'invalid-path' };
  try {
    const real = realpathSync(abs);
    const stat = statSync(real);
    if (!stat.isFile() && !stat.isDirectory()) return { ok: false, error: 'unavailable' };
    const realRel = real.split(path.sep).join('/');
    const blocked = [rel, realRel].some(
      (file) => isExternalFileOpenBlocked(file) && !fileOpenViewer(file)
    );
    if (config.target === 'reveal' || blocked) {
      if (stat.isDirectory() && !blocked) {
        const error = await dependencies.openPath(real);
        return error ? { ok: false, error } : { ok: true };
      }
      dependencies.showItemInFolder(real);
      return { ok: true };
    }
    if (config.target === 'vscode') {
      const result = await dependencies.openVSCode(
        real,
        stat.isDirectory() ? real : path.dirname(real)
      );
      if (result.ok) return { ok: true };
      const error = result.error ?? 'unavailable';
      return { ok: false, error: error === 'unavailable' ? 'application-unavailable' : error };
    }
    const application = resolveApplication(config.applicationPath, dependencies.platform);
    if (!application) return { ok: false, error: 'invalid-application' };
    await dependencies.launchApplication(application, real);
    return { ok: true };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

/**
 * 仅从 Main 权威工作区解析相对路径，校验真实路径边界后按持久化规则打开；外部操作使用真实路径，
 * 防止软链接伪装危险后缀。依赖参数仅用于隔离测试，不来自 IPC 请求。
 *
 * Resolve relative paths only against Main's authoritative workspace, verify real-path boundaries,
 * then apply persisted rules. External actions use real paths to prevent symlink-disguised dangerous
 * extensions. Dependencies are for isolated tests only and never come from IPC requests.
 */
export async function openLocalWorkspaceFile(
  cwd: string,
  rel: string,
  rules: FileOpenRule[],
  dependencies: WorkspaceFileOpeningDependencies = defaultDependencies()
): Promise<FilesOpenResult> {
  if (/[\p{Cc}:]/u.test(rel)) return { ok: false, error: 'invalid-path' };
  const abs = resolveLocalUnderCwd(cwd, rel);
  if (!abs) return { ok: false, error: 'invalid-path' };
  try {
    const real = realpathSync(abs);
    const stat = statSync(real);
    const canonicalRel = path.relative(path.resolve(cwd), abs).split(path.sep).join('/');
    const rule = rules.find((item) => item.extension === fileOpenExtension(canonicalRel));
    let target = resolveFileOpenTarget(canonicalRel, rules);
    const dangerousReal =
      isExternalFileOpenBlocked(real.split(path.sep).join('/')) &&
      fileOpenViewer(real.split(path.sep).join('/')) === null;
    if (dangerousReal || stat.isDirectory()) target = 'reveal';
    if (!stat.isFile() && !stat.isDirectory()) return { ok: false, error: 'unavailable' };
    if (
      (target === 'system' || target === 'application') &&
      (!canOpenWorkspaceFileExternally(canonicalRel, stat.mode, dependencies.platform) ||
        !canOpenWorkspaceFileExternally(
          real.split(path.sep).join('/'),
          stat.mode,
          dependencies.platform
        ))
    )
      target = 'reveal';
    if (target === 'reveal') {
      if (stat.isDirectory() && !dangerousReal && !isExternalFileOpenBlocked(canonicalRel)) {
        const error = await dependencies.openPath(real);
        if (error) return { ok: false, error };
      } else dependencies.showItemInFolder(real);
      return { ok: true, target: 'handled' };
    }
    if (rule?.target === 'application' && !isFileOpenApplicationPath(rule.applicationPath))
      return { ok: false, error: 'invalid-application' };
    if (target === 'internal') {
      const viewer = fileOpenViewer(canonicalRel);
      if (!viewer) return { ok: false, error: 'unsupported-viewer' };
      if (viewer === 'pdf') {
        if (!isPdfFile(real)) return { ok: false, error: 'unsupported-viewer' };
        await dependencies.previewPdf(real);
        return { ok: true, target: 'handled' };
      }
      return { ok: true, target: 'internal', viewer, rel: canonicalRel };
    }
    if (target === 'system') {
      const error = await dependencies.openPath(real);
      return error ? { ok: false, error } : { ok: true, target: 'handled' };
    }
    const application = resolveApplication(rule?.applicationPath, dependencies.platform);
    if (!application) return { ok: false, error: 'invalid-application' };
    await dependencies.launchApplication(application, real);
    return { ok: true, target: 'handled' };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}
