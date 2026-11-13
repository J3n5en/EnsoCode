import { spawn } from 'node:child_process';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { shell } from '@platform';
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
import { fileDesktop } from './desktopHooks';
import { resolveLocalUnderCwd } from './filesWorkspace';
import { openInApps } from './openInApps';

export interface WorkspaceFileOpeningDependencies {
  platform: NodeJS.Platform;
  openPath: (file: string) => Promise<string>;
  showItemInFolder: (file: string) => void;
  previewPdf: (file: string) => Promise<void>;
  launchApplication: (application: string, file: string) => Promise<void>;
}

/**
 * 外部打开同时检查扩展名与 Unix 执行位，避免文件关联或伪装后缀执行脚本与程序。
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
 */
export async function openWorkspacePdfWindow(file: string): Promise<void> {
  if (!isPdfFile(file)) throw new Error('unsupported-viewer');
  await fileDesktop().openWorkspacePdf(file);
}

/**
 * 直接传递应用与文件作为独立参数，永不启用 shell；Mac 只使用系统 open 的 -a 与 -- 分隔。
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
