import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { access, cp, lstat, rm, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Locale, translate } from '@shared/i18n';
import type { ShellIntegration } from '@shared/shellIntegration';
import { dialog } from 'electron';

const ENSO_COMMAND_TARGET = '/usr/local/bin/enso';
const QUICK_ACTION = 'Open with EnsoCode.workflow';
const execFileAsync = promisify(execFile);

function finderQuickActionPath(): string {
  return path.join(homedir(), 'Library', 'Services', QUICK_ACTION);
}

function lstatOrNull(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

/** 已安装只看磁盘。enso 必须是符号链接，普通文件不算。 */
export function readShellIntegrationStatusSync(paths?: {
  ensoCommand?: string;
  finderQuickAction?: string;
}): Record<ShellIntegration, boolean> {
  const enso = lstatOrNull(paths?.ensoCommand ?? ENSO_COMMAND_TARGET);
  const finder = lstatOrNull(paths?.finderQuickAction ?? finderQuickActionPath());
  return {
    ensoCommand: enso?.isSymbolicLink() === true,
    finderQuickAction: finder !== null,
  };
}

export async function linkEnsoCommand(source: string, target: string): Promise<void> {
  const existing = await lstat(target).catch(() => null);
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`${target} already exists and is not a link to EnsoCode.`);
  }
  if (existing) await unlink(target);
  await symlink(source, target);
}

export async function unlinkEnsoCommand(target: string): Promise<void> {
  let existing: Awaited<ReturnType<typeof lstat>> | null;
  try {
    existing = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!existing.isSymbolicLink()) {
    throw new Error(`${target} already exists and is not a link to EnsoCode.`);
  }
  try {
    await unlink(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 提权删除只允许发生在已确认的符号链接上，避免把普通文件交给 rm。
    if (code === 'EACCES' || code === 'EPERM') {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        ensoCommandLink: true,
      });
    }
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function linkAsAdmin(source: string, target: string): Promise<void> {
  const command = `mkdir -p ${shellQuote(path.dirname(target))} && ln -sf ${shellQuote(source)} ${shellQuote(target)}`;
  await execFileAsync('osascript', [
    '-e',
    `do shell script ${appleScriptString(command)} with administrator privileges`,
  ]);
}

async function removeLinkAsAdmin(target: string): Promise<void> {
  await execFileAsync('osascript', [
    '-e',
    `do shell script ${appleScriptString(`rm ${shellQuote(target)}`)} with administrator privileges`,
  ]);
}

async function showResult(
  locale: Locale,
  result: { type: 'info' | 'error'; message: string; detail?: string }
): Promise<void> {
  await dialog.showMessageBox({
    type: result.type,
    message: result.message,
    ...(result.detail ? { detail: result.detail } : {}),
    buttons: [translate(locale, 'OK')],
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelledByUser(error: unknown): boolean {
  return String((error as { stderr?: unknown }).stderr ?? '').includes('-128');
}

async function installEnsoCommand(locale: Locale): Promise<void> {
  const source = path.join(process.resourcesPath, 'bin', 'enso');
  try {
    await access(source);
    try {
      await linkEnsoCommand(source, ENSO_COMMAND_TARGET);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOENT') throw error;
      await linkAsAdmin(source, ENSO_COMMAND_TARGET);
    }
  } catch (error) {
    if (cancelledByUser(error)) return;
    await showResult(locale, {
      type: 'error',
      message: translate(locale, "Couldn't install the 'enso' command"),
      detail: errorText(error),
    });
    return;
  }
  await showResult(locale, {
    type: 'info',
    message: translate(locale, "Shell command 'enso' installed in {{dir}}.", {
      dir: path.dirname(ENSO_COMMAND_TARGET),
    }),
    detail: translate(locale, 'Run `enso .` in a terminal to open the current folder in EnsoCode.'),
  });
}

async function uninstallEnsoCommand(locale: Locale): Promise<void> {
  try {
    try {
      await unlinkEnsoCommand(ENSO_COMMAND_TARGET);
    } catch (error) {
      if (!(error as { ensoCommandLink?: boolean }).ensoCommandLink) throw error;
      await removeLinkAsAdmin(ENSO_COMMAND_TARGET);
    }
  } catch (error) {
    if (cancelledByUser(error)) return;
    await showResult(locale, {
      type: 'error',
      message: translate(locale, "Couldn't uninstall the 'enso' command"),
      detail: errorText(error),
    });
    return;
  }
  await showResult(locale, {
    type: 'info',
    message: translate(locale, "Shell command 'enso' uninstalled."),
  });
}

async function installFinderQuickAction(locale: Locale): Promise<void> {
  const target = finderQuickActionPath();
  try {
    await rm(target, { recursive: true, force: true });
    await cp(path.join(process.resourcesPath, 'finder', QUICK_ACTION), target, {
      recursive: true,
    });
    await execFileAsync('/System/Library/CoreServices/pbs', ['-update']);
  } catch (error) {
    await showResult(locale, {
      type: 'error',
      message: translate(locale, "Couldn't install the Finder Quick Action"),
      detail: errorText(error),
    });
    return;
  }
  await showResult(locale, {
    type: 'info',
    message: translate(locale, 'Finder Quick Action installed.'),
    detail: translate(
      locale,
      'Right-click a folder in Finder and choose Services > Open with EnsoCode.'
    ),
  });
}

async function uninstallFinderQuickAction(locale: Locale): Promise<void> {
  try {
    await rm(finderQuickActionPath(), { recursive: true, force: true });
    await execFileAsync('/System/Library/CoreServices/pbs', ['-update']);
  } catch (error) {
    await showResult(locale, {
      type: 'error',
      message: translate(locale, "Couldn't uninstall the Finder Quick Action"),
      detail: errorText(error),
    });
    return;
  }
  await showResult(locale, {
    type: 'info',
    message: translate(locale, 'Finder Quick Action uninstalled.'),
  });
}

const INTEGRATIONS: Record<
  ShellIntegration,
  { install: (locale: Locale) => Promise<void>; uninstall: (locale: Locale) => Promise<void> }
> = {
  ensoCommand: { install: installEnsoCommand, uninstall: uninstallEnsoCommand },
  finderQuickAction: { install: installFinderQuickAction, uninstall: uninstallFinderQuickAction },
};

export function shellIntegrationAction(kind: ShellIntegration, locale: Locale): Promise<void> {
  const step = readShellIntegrationStatusSync()[kind] ? 'uninstall' : 'install';
  return INTEGRATIONS[kind][step](locale);
}
