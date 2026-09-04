import { describe, expect, it } from 'vitest';
import { createSessionCommandTool, resolveSessionShellKind } from './sessionShell';

describe('resolveSessionShellKind', () => {
  it('远程会话即便在 win32 上也选 bash', () => {
    expect(resolveSessionShellKind({ platform: 'win32', remote: true })).toBe('bash');
  });

  it('本地 win32 选 powershell', () => {
    expect(resolveSessionShellKind({ platform: 'win32' })).toBe('powershell');
  });

  it('本地非 win32(如 darwin)选 bash', () => {
    expect(resolveSessionShellKind({ platform: 'darwin' })).toBe('bash');
  });

  it('远程且非 win32 也选 bash', () => {
    expect(resolveSessionShellKind({ platform: 'linux', remote: true })).toBe('bash');
  });
});

describe('createSessionCommandTool', () => {
  it('本地 win32 建出的工具名为 powershell', () => {
    const tool = createSessionCommandTool({ cwd: '/tmp', platform: 'win32' });
    expect(tool.name).toBe('powershell');
  });

  it('远程 win32 建出的工具名仍为 bash', () => {
    const tool = createSessionCommandTool({ cwd: '/tmp', platform: 'win32', remote: true });
    expect(tool.name).toBe('bash');
  });

  it('本地 darwin 建出的工具名为 bash', () => {
    const tool = createSessionCommandTool({ cwd: '/tmp', platform: 'darwin' });
    expect(tool.name).toBe('bash');
  });

  it('不传 platform 时按 process.platform 判断', () => {
    const tool = createSessionCommandTool({ cwd: '/tmp' });
    expect(tool.name).toBe(process.platform === 'win32' ? 'powershell' : 'bash');
  });
});
