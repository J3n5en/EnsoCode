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
  grant: {
    permissions: [],
    fsRead: [],
    fsWrite: [],
    netDomains: [],
    mcp: [],
    mcpTools: [],
    renderer: false,
    env: [],
    interop: [],
    intercepts: [],
    resident: false,
    styles: false,
  },
  installedAt: 1,
  crossSessionInject: false,
};

describe('插件登记表', () => {
  it('文件不存在时为空，不算读不出', () => {
    expect(readRegistry(tempRoot())).toMatchObject({ plugins: [], unreadable: false });
  });

  it.each([
    ['不是 JSON', '{bad'],
    ['不是对象', '[]'],
    ['plugins 不是数组', JSON.stringify({ version: 2, plugins: null })],
  ])('读不出（%s）时标记 unreadable，与空表区分', (_label, raw) => {
    const root = tempRoot();
    writeFileSync(join(root, 'registry.json'), raw);
    expect(readRegistry(root)).toEqual({
      version: 2,
      plugins: [],
      discarded: [],
      unreadable: true,
    });
  });

  it('写入后读回', () => {
    const root = tempRoot();
    writeRegistry(root, { version: 2, plugins: [valid as never] });
    expect(readRegistry(root)).toEqual({
      version: 2,
      plugins: [valid],
      discarded: [],
      unreadable: false,
    });
    expect(JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')).version).toBe(2);
  });

  it('丢弃字段不合法的记录，保留其余', () => {
    const root = tempRoot();
    const bad = [
      { ...valid, id: '../x' },
      { ...valid, id: 'a.b', dir: '../escape' },
      { ...valid, id: 'a.c', state: 'root' },
      { ...valid, id: 'a.d', grant: null },
      { ...valid, id: 'a.e', grant: { ...valid.grant, env: undefined } },
    ];
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({ version: 2, plugins: [valid, ...bad] })
    );
    const read = readRegistry(root);
    expect(read.plugins.map((p) => p.id)).toEqual(['example.demo']);
    expect(read.discarded).toEqual(['a.b', 'a.c', 'a.d', 'a.e']);
  });

  it('旧版本登记表整份丢弃，并列出被丢弃的插件 id', () => {
    const root = tempRoot();
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({ version: 1, plugins: [valid, { id: 'x.y' }, { nope: 1 }] })
    );
    expect(readRegistry(root)).toEqual({
      version: 2,
      plugins: [],
      discarded: ['example.demo', 'x.y'],
      unreadable: false,
    });
  });

  it('lastError 不合法时丢掉该字段，记录保留', () => {
    const root = mkdtempSync(join(tmpdir(), 'registry-'));
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({
        version: 2,
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
        version: 2,
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
      JSON.stringify({ version: 2, plugins: [valid, { ...valid, dir: 'x' }] })
    );
    expect(readRegistry(root).plugins).toHaveLength(1);
  });

  it('缺 styles 的旧授权按未同意样式读入，类型不对的记录丢弃', () => {
    const root = tempRoot();
    const { styles: _styles, ...legacyGrant } = valid.grant;
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({
        version: 2,
        plugins: [
          {
            ...valid,
            grant: legacyGrant,
            pending: { version: '2.0.0', dir: 'next', grant: legacyGrant },
          },
          { ...valid, id: 'a.s', grant: { ...valid.grant, styles: 'yes' } },
        ],
      })
    );
    const read = readRegistry(root);
    expect(read.plugins.map((p) => [p.id, p.grant.styles, p.pending?.grant.styles])).toEqual([
      ['example.demo', false, false],
    ]);
    expect(read.discarded).toEqual(['a.s']);
  });
});
