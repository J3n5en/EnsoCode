import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export type ClipboardFileResult = { ok: boolean; reason?: string };

export type ClipboardFileDeps = {
  platform: NodeJS.Platform;
  desktop?: string;
  writeBuffer: (format: string, buffer: Buffer) => void;
  runCommand: (command: string, args: string[], stdin?: string) => Promise<void>;
};

/** 把本地文件写成 OS「文件」剪贴板，访达/资源管理器可粘贴。 */
export async function writeFileToClipboard(
  filePath: string,
  deps: ClipboardFileDeps
): Promise<ClipboardFileResult> {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    return { ok: false, reason: 'invalid-path' };
  }

  if (deps.platform === 'darwin') {
    try {
      deps.writeBuffer('public.file-url', Buffer.from(pathToFileURL(filePath).href, 'utf8'));
      return { ok: true };
    } catch {
      return { ok: false, reason: 'clipboard-write-failed' };
    }
  }

  if (deps.platform === 'win32') {
    const escaped = filePath.replace(/'/g, "''");
    try {
      await deps.runCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Set-Clipboard -LiteralPath '${escaped}'`,
      ]);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'clipboard-command-failed' };
    }
  }

  const fileUrl = pathToFileURL(filePath).href;
  const [mime, payload] = /kde/i.test(deps.desktop ?? '')
    ? ['text/uri-list', `${fileUrl}\r\n`]
    : ['x-special/gnome-copied-files', `copy\n${fileUrl}`];
  for (const [command, args] of [
    ['wl-copy', ['--type', mime]],
    ['xclip', ['-selection', 'clipboard', '-t', mime]],
  ] as const) {
    try {
      await deps.runCommand(command, [...args], payload);
      return { ok: true };
    } catch {
      // 试下一个工具
    }
  }
  return { ok: false, reason: 'unsupported-platform' };
}
