import { describe, expect, it, vi } from 'vitest';
import {
  createViewBridge,
  decodeUtf8Base64,
  viewEventPush,
  viewFileEdit,
  viewFilePush,
  viewStoragePatch,
  viewThemeNotice,
  viewThemePush,
} from './viewBridge';

describe('侧栏页面桥', () => {
  it('转发 call 并带回结果', async () => {
    const call = vi.fn(async () => ({ n: 1 }));
    const handle = createViewBridge(call);
    await expect(handle({ id: 3, method: 'stats', args: { a: 1 } })).resolves.toEqual({
      id: 3,
      ok: true,
      value: { n: 1 },
    });
    expect(call).toHaveBeenCalledWith('stats', { a: 1 });
  });

  it('调用失败时回错误文本', async () => {
    const handle = createViewBridge(async () => {
      throw new Error('boom');
    });
    await expect(handle({ id: 'x', method: 'm', args: null })).resolves.toEqual({
      id: 'x',
      ok: false,
      error: 'boom',
    });
  });

  it('坏消息直接丢弃', async () => {
    const call = vi.fn();
    const handle = createViewBridge(call);
    for (const bad of [null, 'x', { id: 1 }, { id: {}, method: 'm' }, { id: 1, method: '' }])
      await expect(handle(bad)).resolves.toBeNull();
    await expect(handle({ id: 1, method: 'x'.repeat(200) })).resolves.toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('base64 按 UTF-8 解码', () => {
    expect(decodeUtf8Base64(btoa(String.fromCharCode(...new TextEncoder().encode('你好'))))).toBe(
      '你好'
    );
  });

  it('只把侧栏存储补丁从端口消息里拆出来', () => {
    expect(viewStoragePatch({ type: 'enso-storage', patch: { a: '1', b: null } })).toEqual({
      a: '1',
      b: null,
    });
    expect(viewStoragePatch({ type: 'enso-storage', patch: { a: 1 } })).toBeNull();
    expect(viewStoragePatch({ id: 1, method: 'stats', args: {} })).toBeNull();
  });

  it('主题推送只接受 light 和 dark', () => {
    expect(viewThemePush('dark')).toEqual({ type: 'enso-theme', theme: 'dark' });
    expect(viewThemeNotice(viewThemePush('light'))).toBe('light');
    expect(viewThemeNotice({ type: 'enso-theme', theme: 'blue' })).toBeNull();
    expect(viewThemeNotice({ id: 1, ok: true, value: null })).toBeNull();
  });

  it('侧栏事件原样带上名字和数据', () => {
    expect(viewEventPush('snapshot', { n: 1 })).toEqual({
      type: 'enso-view-event',
      name: 'snapshot',
      data: { n: 1 },
    });
  });

  it('文件查看器：推送当前文件，只收字符串编辑', () => {
    expect(viewFilePush('a.csv', 'x,y')).toEqual({ type: 'enso-file', rel: 'a.csv', text: 'x,y' });
    expect(viewFileEdit({ type: 'enso-file-edit', text: 'a,b' })).toBe('a,b');
    expect(viewFileEdit({ type: 'enso-file-edit', text: 1 })).toBeNull();
    expect(viewFileEdit({ type: 'enso-storage', patch: {} })).toBeNull();
    expect(viewFileEdit(null)).toBeNull();
  });
});
