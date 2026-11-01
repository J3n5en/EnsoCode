import { describe, expect, it, vi } from 'vitest';
import {
  deletePluginArtifact,
  listPluginArtifacts,
  parseConfigPatch,
  parsePickPathKind,
  readPluginArtifact,
  savePluginArtifact,
  setPluginConfig,
  setPluginViewState,
} from './extensionPlugins';

const info = {
  id: 'art_1',
  pluginId: 'enso.example.notes',
  name: '报告.txt',
  mime: 'text/plain',
  size: 5,
  createdAt: 1,
};

describe('插件 IPC 入参', () => {
  it('配置补丁接受字符串、数字、布尔和 null，拒绝对象与非有限数字', () => {
    expect(parseConfigPatch({ token: 'abc', count: 2, enabled: false, gone: null })).toEqual({
      token: 'abc',
      count: 2,
      enabled: false,
      gone: null,
    });
    expect(parseConfigPatch({ token: { nested: true } })).toBeNull();
    expect(parseConfigPatch({ count: Number.NaN })).toBeNull();
    expect(parseConfigPatch({ count: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseConfigPatch(['x'])).toBeNull();
  });

  it('非法插件 id 或产出 id 不调用服务，也不读盘', () => {
    const list = vi.fn(() => [info]);
    expect(listPluginArtifacts({ listArtifacts: list }, '../etc/passwd')).toEqual({
      ok: false,
      error: '参数不合法',
    });
    expect(listPluginArtifacts({ listArtifacts: list }, { path: '/tmp/a' })).toEqual({
      ok: false,
      error: '参数不合法',
    });
    expect(list).not.toHaveBeenCalled();
    expect(listPluginArtifacts({ listArtifacts: list }, undefined)).toEqual({
      ok: true,
      artifacts: [info],
    });
    expect(list).toHaveBeenCalledWith(undefined);

    const remove = vi.fn();
    const readPath = vi.fn();
    const readFile = vi.fn();
    expect(deletePluginArtifact({ deleteArtifact: remove }, '../etc/passwd').ok).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(
      readPluginArtifact({ artifactInfo: vi.fn(), artifactPath: readPath }, '/etc/passwd', readFile)
    ).toMatchObject({ ok: false });
    expect(readPath).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('产出读取只跟服务返回的路径走，超限不回 base64', () => {
    const readFile = vi.fn(() => Buffer.from('hello'));
    const result = readPluginArtifact(
      {
        artifactInfo: () => info,
        artifactPath: (id) => (id === info.id ? '/data/artifacts/art_1' : null),
      },
      info.id,
      readFile
    );
    expect(result).toEqual({ ok: true, info, base64: Buffer.from('hello').toString('base64') });
    expect(readFile).toHaveBeenCalledWith('/data/artifacts/art_1');

    readFile.mockClear();
    const big = readPluginArtifact(
      {
        artifactInfo: () => ({ ...info, size: 9 * 1024 * 1024 }),
        artifactPath: () => '/data/artifacts/art_1',
      },
      info.id,
      readFile
    );
    expect(big).toMatchObject({ ok: false });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('另存只收产出 id；取消和非法 id 都不复制文件', async () => {
    const choose = vi.fn(async (_name: string): Promise<string | null> => '/tmp/out.txt');
    const copy = vi.fn(async () => {});
    const plugins = {
      artifactInfo: (id: string) => (id === info.id ? info : null),
      artifactPath: (id: string) => (id === info.id ? '/data/artifacts/art_1' : null),
    };
    await expect(savePluginArtifact(plugins, '../x', choose, copy)).resolves.toMatchObject({
      ok: false,
    });
    expect(copy).not.toHaveBeenCalled();

    choose.mockResolvedValueOnce(null);
    await expect(savePluginArtifact(plugins, info.id, choose, copy)).resolves.toEqual({
      ok: true,
      cancelled: true,
    });
    expect(copy).not.toHaveBeenCalled();

    choose.mockResolvedValueOnce('/tmp/报告.txt');
    await expect(savePluginArtifact(plugins, info.id, choose, copy)).resolves.toEqual({
      ok: true,
    });
    expect(choose).toHaveBeenCalledWith('报告.txt');
    expect(copy).toHaveBeenCalledWith('/data/artifacts/art_1', '/tmp/报告.txt');
  });

  it('侧栏状态补丁只收字符串和 null', () => {
    const set = vi.fn(() => ({ ok: true }));
    expect(
      setPluginViewState({ viewStateSet: set }, 'enso.example.notes', { a: '1', b: null })
    ).toEqual({
      ok: true,
    });
    expect(set).toHaveBeenCalledWith('enso.example.notes', { a: '1', b: null });
    expect(setPluginViewState({ viewStateSet: set }, '../x', { a: '1' }).ok).toBe(false);
    expect(setPluginViewState({ viewStateSet: set }, 'enso.example.notes', { a: 1 }).ok).toBe(
      false
    );
  });

  it('路径选择只接受 file 或 directory', () => {
    expect(parsePickPathKind('file')).toBe('file');
    expect(parsePickPathKind('directory')).toBe('directory');
    expect(parsePickPathKind('zip')).toBeNull();
    expect(parsePickPathKind('/tmp')).toBeNull();
  });

  it('配置写入把收窄后的补丁交给服务', () => {
    const set = vi.fn(() => ({ ok: true }));
    expect(setPluginConfig({ setConfig: set }, 'enso.example.notes', { n: 1, on: true })).toEqual({
      ok: true,
    });
    expect(set).toHaveBeenCalledWith('enso.example.notes', { n: 1, on: true });
    expect(setPluginConfig({ setConfig: set }, 'enso.example.notes', { n: { bad: true } }).ok).toBe(
      false
    );
  });
});
