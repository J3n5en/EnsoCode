import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRegistry, writeRegistry } from './registry';

const roots: string[] = [];
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'enso-plugins-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const valid = {
  id: 'example.demo',
  version: '1.0.0',
  dir: 'abc',
  state: 'enabled',
  grant: { permissions: [], fsRead: [], fsWrite: [], netDomains: [], mcp: [], renderer: false },
  installedAt: 1,
};

describe('插件登记表', () => {
  it('文件不存在时为空', () => {
    expect(readRegistry(tempRoot()).plugins).toEqual([]);
  });

  it('写入后读回', () => {
    const root = tempRoot();
    writeRegistry(root, { version: 1, plugins: [valid as never] });
    expect(readRegistry(root).plugins).toEqual([valid]);
    expect(JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')).version).toBe(1);
  });

  it('损坏的文件按空处理，不抛错', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'registry.json'), '{bad');
    expect(readRegistry(root).plugins).toEqual([]);
  });

  it('丢弃字段不合法的记录，保留其余', () => {
    const root = tempRoot();
    const bad = [
      { ...valid, id: '../x' },
      { ...valid, id: 'a.b', dir: '../escape' },
      { ...valid, id: 'a.c', state: 'root' },
      { ...valid, id: 'a.d', grant: null },
    ];
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({ version: 1, plugins: [valid, ...bad] })
    );
    expect(readRegistry(root).plugins.map((p) => p.id)).toEqual(['example.demo']);
  });

  it('lastError 不合法时丢掉该字段，记录保留', () => {
    const root = mkdtempSync(join(tmpdir(), 'registry-'));
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          { ...valid, lastError: { at: 1, message: 'boom' } },
          { ...valid, id: 'a.c', lastError: { at: 'x', message: 1 } },
        ],
      })
    );
    const plugins = readRegistry(root).plugins;
    expect(plugins[0]?.lastError).toEqual({ at: 1, message: 'boom' });
    expect(plugins[1]?.id).toBe('a.c');
    expect(plugins[1]?.lastError).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('安装来源不合法时丢掉该字段', () => {
    const root = tempRoot();
    const sources = [
      { kind: 'dir', path: '/srv/p' },
      { kind: 'url', url: 'https://github.com/a/b' },
      { kind: 'dir', path: 'relative' },
      { kind: 'url', url: 'file:///etc/passwd' },
      { kind: 'exe', path: '/x' },
    ];
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({
        version: 1,
        plugins: sources.map((source, i) => ({ ...valid, id: `a.p${i}`, source })),
      })
    );
    expect(readRegistry(root).plugins.map((p) => p.source)).toEqual([
      sources[0],
      sources[1],
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('同 id 重复时只保留第一条', () => {
    const root = tempRoot();
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({ version: 1, plugins: [valid, { ...valid, dir: 'x' }] })
    );
    expect(readRegistry(root).plugins).toHaveLength(1);
  });
});
