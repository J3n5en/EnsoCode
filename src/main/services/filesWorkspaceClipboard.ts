import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export type ClipboardFileResult = { ok: boolean; reason?: string };

export type ClipboardFileDeps = {
  platform: NodeJS.Platform;
  desktop?: string;
  writeBuffer: (format: string, buffer: Buffer) => Promise<void>;
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
      await deps.writeBuffer('public.file-url', Buffer.from(pathToFileURL(filePath).href, 'utf8'));
      return { ok: true };
    } catch {
      return { ok: false, reason: 'clipboard-write-failed' };
    }
  }

  if (deps.platform === 'win32') {
    // 路径不能以字符串字面量拼进命令：PowerShell 把 ‘ ’ ‚ ‛ 也当单引号，只转义 ASCII ' 挡不住注入。
    // base64 字母表里没有任何引号或分隔符，PowerShell 侧按 UTF-8 解回原路径，中文路径也不受控制台代码页影响。
    const encoded = Buffer.from(filePath, 'utf8').toString('base64');
    try {
      await deps.runCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Set-Clipboard -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`,
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
