import { describe, expect, it, vi } from 'vitest';
import { writeFileToClipboard } from './filesWorkspaceClipboard';

describe('writeFileToClipboard', () => {
  it('拒绝非绝对路径', async () => {
    const result = await writeFileToClipboard('relative.txt', {
      platform: 'darwin',
      writeBuffer: vi.fn(),
      runCommand: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-path');
  });

  it('darwin 写 public.file-url', async () => {
    const writeBuffer = vi.fn();
    const result = await writeFileToClipboard('/repo/INSTALL.md', {
      platform: 'darwin',
      writeBuffer,
      runCommand: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(writeBuffer).toHaveBeenCalledOnce();
    expect(writeBuffer.mock.calls[0]?.[0]).toBe('public.file-url');
  });

  // 审计：PowerShell 把 U+2018/2019/201A/201B 也当单引号，只转义 ASCII ' 时，
  // 恶意仓库里名为 a’; calc; ’.txt 的文件右键「复制文件」即可执行 calc。
  // 路径用 /repo 开头：win32 与 posix 的 isAbsolute 都认，测试在任何系统上都走到命令构造
  it('Windows 下路径不进入 PowerShell 命令文本，弯引号无法闭合字符串注入命令', async () => {
    const filePath = '/repo/a’; calc; ’.txt';
    const runCommand = vi.fn(async (_command: string, _args: string[], _stdin?: string) => {});
    const result = await writeFileToClipboard(filePath, {
      platform: 'win32',
      writeBuffer: vi.fn(),
      runCommand,
    });
    expect(result.ok).toBe(true);
    const [command, args] = runCommand.mock.calls[0] ?? [];
    expect(command).toBe('powershell.exe');
    const script = args?.[args.indexOf('-Command') + 1] ?? '';
    expect(script).not.toContain('calc');
    expect(script).not.toMatch(/[\u2018-\u201b]/);
    const encoded = /'([A-Za-z0-9+/=]*)'/.exec(script)?.[1] ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(filePath);
  });

  // 审计：路径里带 ’（如英文所有格目录名）时，旧实现对该目录下所有文件都失败
  it('Windows 下含中文与弯引号的普通路径原样送达 PowerShell', async () => {
    const filePath = '/work/Team’s Projects/笔记 ‘草稿’.md';
    const runCommand = vi.fn(async (_command: string, _args: string[], _stdin?: string) => {});
    await writeFileToClipboard(filePath, { platform: 'win32', writeBuffer: vi.fn(), runCommand });
    const args = runCommand.mock.calls[0]?.[1] ?? [];
    const script = args[args.indexOf('-Command') + 1] ?? '';
    const encoded = /'([A-Za-z0-9+/=]*)'/.exec(script)?.[1] ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(filePath);
  });

  it('darwin 异步写入失败时报 clipboard-write-failed', async () => {
    const result = await writeFileToClipboard('/repo/INSTALL.md', {
      platform: 'darwin',
      writeBuffer: vi.fn().mockRejectedValue(new Error('denied')),
      runCommand: vi.fn(),
    });
    expect(result).toEqual({ ok: false, reason: 'clipboard-write-failed' });
  });
});
