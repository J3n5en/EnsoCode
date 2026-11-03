import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fsActual = vi.hoisted(() => ({
  writeFile: null as null | typeof import('node:fs/promises').writeFile,
  next: null as null | typeof import('node:fs/promises').writeFile,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  fsActual.writeFile = actual.writeFile.bind(actual);
  return {
    ...actual,
    writeFile: ((...args: Parameters<typeof actual.writeFile>) => {
      const next = fsActual.next;
      if (next) return next(...args);
      return fsActual.writeFile?.(...args);
    }) as typeof actual.writeFile,
  };
});

import { ArtifactStore } from './artifacts';

describe('ArtifactStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('异步写入产出并可再读出', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artifacts-'));
    dirs.push(root);
    const store = new ArtifactStore(root);
    const pending = store.write('a.b', { name: 'n.txt', text: 'hello' });
    expect(pending).toBeInstanceOf(Promise);
    const info = await pending;
    expect(info).toMatchObject({ pluginId: 'a.b', name: 'n.txt', size: 5 });
    expect(readFileSync(join(root, 'artifacts', 'a.b', `${info.id}.bin`), 'utf8')).toBe('hello');
  });

  it('写入期间插件被移除时删掉新文件，不重建索引', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artifacts-'));
    dirs.push(root);
    const store = new ArtifactStore(root);
    fsActual.next = async (path, data, options) => {
      fsActual.next = null;
      await fsActual.writeFile?.(path, data, options);
      store.removePlugin('a.b');
    };
    await expect(store.write('a.b', { name: 'n.txt', text: 'hello' })).rejects.toMatchObject({
      code: 'PLUGIN_REMOVED',
    });
    fsActual.next = null;
    const dir = join(root, 'artifacts', 'a.b');
    const names = existsSync(dir) ? readdirSync(dir) : [];
    expect(names.filter((name) => name.endsWith('.bin') || name === 'index.json')).toEqual([]);
    expect(store.list('a.b')).toEqual([]);
  });

  it('写入失败不淘汰已有产出', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artifacts-'));
    dirs.push(root);
    const store = new ArtifactStore(root);
    const first = await store.write('a.b', { name: 'first.txt', text: '1' });
    for (let i = 0; i < 199; i++) await store.write('a.b', { name: `n${i}.txt`, text: 'x' });
    fsActual.next = async () => {
      throw new Error('disk');
    };
    await expect(store.write('a.b', { name: 'more.txt', text: 'z' })).rejects.toThrow('disk');
    fsActual.next = null;
    const ids = store.list('a.b').map((item) => item.id);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe(first.id);
  });

  it('并发写入后索引不超过 200', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artifacts-'));
    dirs.push(root);
    const store = new ArtifactStore(root);
    await Promise.all(
      Array.from({ length: 201 }, (_, index) =>
        store.write('a.b', { name: `n${index}.txt`, text: 'x' })
      )
    );
    expect(store.list('a.b')).toHaveLength(200);
    const names = readdirSync(join(root, 'artifacts', 'a.b'));
    expect(names.filter((name) => name.endsWith('.bin'))).toHaveLength(200);
  });
});
