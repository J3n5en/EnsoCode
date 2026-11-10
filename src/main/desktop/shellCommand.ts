import { execFile } from 'node:child_process';
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

export async function linkEnsoCommand(source: string, target: string): Promise<void> {
  const existing = await lstat(target).catch(() => null);
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`${target} already exists and is not a link to EnsoCode.`);
  }
  if (existing) await unlink(target);
  await symlink(source, target);
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

async function showResult(
  locale: Locale,
  result: { type: 'info' | 'error'; message: string; detail: string }
): Promise<void> {
  await dialog.showMessageBox({ ...result, buttons: [translate(locale, 'OK')] });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    // osascript 在用户取消授权时以 -128 退出
    if (String((error as { stderr?: unknown }).stderr ?? '').includes('-128')) return;
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

async function installFinderQuickAction(locale: Locale): Promise<void> {
  const target = path.join(homedir(), 'Library', 'Services', QUICK_ACTION);
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

const INSTALLERS: Record<ShellIntegration, (locale: Locale) => Promise<void>> = {
  ensoCommand: installEnsoCommand,
  finderQuickAction: installFinderQuickAction,
};

export function installShellIntegration(kind: ShellIntegration, locale: Locale): Promise<void> {
  return INSTALLERS[kind](locale);
}
