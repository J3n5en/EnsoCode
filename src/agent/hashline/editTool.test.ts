import { describe, expect, it, vi } from 'vitest';
import { createHashlineEditTool } from './editTool';

const handlers = () => ({
  applyReplace: vi.fn(async () => 'replace-result'),
  applyHashline: vi.fn(async () => 'hashline-result'),
});

describe('createHashlineEditTool', () => {
  it('replace 参数只交给原替换处理器', async () => {
    const callbacks = handlers();
    const tool = createHashlineEditTool(callbacks);
    const params = { path: '/a.ts', edits: [{ oldText: 'a', newText: 'b' }] };
    await expect(tool.execute('call-1', params)).resolves.toBe('replace-result');
    expect(callbacks.applyReplace).toHaveBeenCalledOnce();
    expect(callbacks.applyReplace).toHaveBeenCalledWith(params);
    expect(callbacks.applyHashline).not.toHaveBeenCalled();
  });

  it('Hashline 参数只交给补丁处理器', async () => {
    const callbacks = handlers();
    const tool = createHashlineEditTool(callbacks);
    const params = { input: 'PUT...' };
    await expect(tool.execute('call-2', params)).resolves.toBe('hashline-result');
    expect(callbacks.applyHashline).toHaveBeenCalledOnce();
    expect(callbacks.applyHashline).toHaveBeenCalledWith(params);
    expect(callbacks.applyReplace).not.toHaveBeenCalled();
  });

  it('混合参数直接拒绝且不调用任何处理器', async () => {
    const callbacks = handlers();
    const tool = createHashlineEditTool(callbacks);
    await expect(tool.execute('call-3', { input: 'PUT...', edits: [] })).rejects.toThrow();
    expect(callbacks.applyReplace).not.toHaveBeenCalled();
    expect(callbacks.applyHashline).not.toHaveBeenCalled();
  });

  it('无效参数直接拒绝', async () => {
    const tool = createHashlineEditTool(handlers());
    await expect(tool.execute('call-4', {})).rejects.toThrow();
  });
});
