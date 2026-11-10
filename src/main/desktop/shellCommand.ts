import { execFile } from 'node:child_process';
import { lstat, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { dialog } from 'electron';

const ENSO_COMMAND_TARGET = '/usr/local/bin/enso';

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
  await promisify(execFile)('osascript', [
    '-e',
    `do shell script ${appleScriptString(command)} with administrator privileges`,
  ]);
}

export async function installEnsoCommand(): Promise<void> {
  const source = path.join(process.resourcesPath, 'bin', 'enso');
  try {
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
    dialog.showErrorBox(
      "Couldn't install the 'enso' command",
      error instanceof Error ? error.message : String(error)
    );
    return;
  }
  await dialog.showMessageBox({
    type: 'info',
    message: `Shell command 'enso' installed in ${path.dirname(ENSO_COMMAND_TARGET)}.`,
    detail: 'Run `enso .` in a terminal to open the current folder in EnsoCode.',
  });
}
