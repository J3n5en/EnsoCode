import { describe, expect, it } from 'vitest';
import { parseWindowsLocalShell } from './windowsLocalShell';

describe('parseWindowsLocalShell', () => {
  it('合法枚举原样返回', () => {
    expect(parseWindowsLocalShell('auto')).toBe('auto');
    expect(parseWindowsLocalShell('powershell')).toBe('powershell');
    expect(parseWindowsLocalShell('bash')).toBe('bash');
  });

  it('缺字段、空串、乱值按 auto', () => {
    expect(parseWindowsLocalShell(undefined)).toBe('auto');
    expect(parseWindowsLocalShell(null)).toBe('auto');
    expect(parseWindowsLocalShell('')).toBe('auto');
    expect(parseWindowsLocalShell('pwsh')).toBe('auto');
    expect(parseWindowsLocalShell(1)).toBe('auto');
  });
});
