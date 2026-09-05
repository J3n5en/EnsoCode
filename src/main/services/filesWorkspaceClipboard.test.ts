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
});
