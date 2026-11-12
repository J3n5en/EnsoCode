import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadMarketIndex, parseMarketIndex } from './marketIndex';

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
};
const key = pair();
const other = pair();

const version = (over: Record<string, unknown> = {}) => ({
  version: '1.0.0',
  engines: { enso: '>=0.1.0' },
  permissions: ['ui.view'],
  path: 'packages/enso.example.notes/1.0.0.zip',
  sha256: 'a'.repeat(64),
  size: 100,
  publishedAt: '2026-11-01T00:00:00Z',
  ...over,
});
const plugin = (over: Record<string, unknown> = {}) => ({
  id: 'enso.example.notes',
  name: 'Notes',
  description: '便签',
  tier: 'official',
  tags: ['ui'],
  latest: '1.0.0',
  versions: [version()],
  ...over,
});
const index = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  generatedAt: '2026-11-02T00:00:00Z',
  sequence: 5,
  plugins: [plugin()],
  ...over,
});
const signed = (value: unknown, privateKey = key.privateKey) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, signature: sign(null, bytes, privateKey).toString('base64') };
};

describe('loadMarketIndex', () => {
  it('签名正确时返回解析结果', () => {
    const r = loadMarketIndex({
      ...signed(index()),
      publicKeys: [key.publicPem],
      minSequence: 0,
      hostVersion: '1.0.0',
    });
    expect(r.ok && r.index.sequence).toBe(5);
    expect(r.ok && r.index.plugins.map((p) => p.id)).toEqual(['enso.example.notes']);
  });

  it('任一内置公钥通过即可（支持轮换）', () => {
    const r = loadMarketIndex({
      ...signed(index()),
      publicKeys: [other.publicPem, key.publicPem],
      minSequence: 0,
      hostVersion: '1.0.0',
    });
    expect(r.ok).toBe(true);
  });

  it('篡改内容、错误公钥、缺失或乱码签名均拒绝', () => {
    const s = signed(index());
    const tampered = Buffer.from(s.bytes);
    tampered[tampered.length - 2] ^= 1;
    const base = { publicKeys: [key.publicPem], minSequence: 0, hostVersion: '1.0.0' };
    expect(loadMarketIndex({ ...base, bytes: tampered, signature: s.signature }).ok).toBe(false);
    expect(loadMarketIndex({ ...base, ...s, publicKeys: [other.publicPem] }).ok).toBe(false);
    expect(loadMarketIndex({ ...base, bytes: s.bytes, signature: '' }).ok).toBe(false);
    expect(loadMarketIndex({ ...base, bytes: s.bytes, signature: '!!!' }).ok).toBe(false);
  });

  it('sequence 小于已见值时拒绝（防回滚），等于时接受', () => {
    const s = signed(index({ sequence: 5 }));
    const base = { ...s, publicKeys: [key.publicPem], hostVersion: '1.0.0' };
    expect(loadMarketIndex({ ...base, minSequence: 6 }).ok).toBe(false);
    expect(loadMarketIndex({ ...base, minSequence: 5 }).ok).toBe(true);
  });

  it('签名有效但不是合法 JSON 或结构不对时拒绝', () => {
    const bytes = Buffer.from('not json');
    const signature = sign(null, bytes, key.privateKey).toString('base64');
    const base = { publicKeys: [key.publicPem], minSequence: 0, hostVersion: '1.0.0' };
    expect(loadMarketIndex({ ...base, bytes, signature }).ok).toBe(false);
    expect(loadMarketIndex({ ...base, ...signed(index({ schemaVersion: 2 })) }).ok).toBe(false);
  });
});

describe('parseMarketIndex', () => {
  const parse = (value: unknown, host = '1.0.0') => parseMarketIndex(value, host);

  it('非法条目只丢弃该条，不影响其他', () => {
    const r = parse(
      index({
        plugins: [
          plugin(),
          plugin({ id: 'Bad Id' }),
          plugin({ id: 'enso.b', name: '' }),
          'x',
          plugin({ id: 'enso.c', tier: 'vip' }),
        ],
      })
    );
    expect(r?.plugins.map((p) => p.id)).toEqual(['enso.example.notes']);
  });

  it('重复 id 只保留第一个', () => {
    const r = parse(index({ plugins: [plugin(), plugin({ name: 'Dup' })] }));
    expect(r?.plugins).toHaveLength(1);
    expect(r?.plugins[0].name).toBe('Notes');
  });

  it('丢弃路径越界、哈希或大小不合法的版本', () => {
    const r = parse(
      index({
        plugins: [
          plugin({
            latest: '1.0.0',
            versions: [
              version({ version: '0.1.0', path: '../evil.zip' }),
              version({ version: '0.2.0', path: '/abs.zip' }),
              version({ version: '0.3.0', path: 'https://x/a.zip' }),
              version({ version: '0.4.0', sha256: 'zz' }),
              version({ version: '0.5.0', size: -1 }),
              version({ version: '0.6.0', path: 'a\\b.zip' }),
              version(),
            ],
          }),
        ],
      })
    );
    expect(r?.plugins[0].versions.map((v) => v.version)).toEqual(['1.0.0']);
  });

  it('过滤宿主版本不满足 engines 的版本；没有可用版本的插件整体丢弃', () => {
    const r = parse(
      index({
        plugins: [
          plugin({
            versions: [version({ version: '2.0.0', engines: { enso: '>=9.0.0' } }), version()],
          }),
          plugin({ id: 'enso.future', versions: [version({ engines: { enso: '>=9.0.0' } })] }),
        ],
      })
    );
    expect(r?.plugins.map((p) => p.id)).toEqual(['enso.example.notes']);
    expect(r?.plugins[0].versions.map((v) => v.version)).toEqual(['1.0.0']);
  });

  it('latest 取可用版本里 semver 最大者，不信任索引里的 latest', () => {
    const r = parse(
      index({
        plugins: [
          plugin({
            latest: '9.9.9',
            versions: [
              version({ version: '1.2.0' }),
              version({ version: '1.10.0' }),
              version({ version: '2.0.0', engines: { enso: '>=9.0.0' } }),
            ],
          }),
        ],
      })
    );
    expect(r?.plugins[0].latest).toBe('1.10.0');
  });

  it('顶层结构不对返回 null', () => {
    expect(parse(null)).toBeNull();
    expect(parse(index({ sequence: -1 }))).toBeNull();
    expect(parse(index({ sequence: 1.5 }))).toBeNull();
    expect(parse(index({ plugins: {} }))).toBeNull();
  });

  it('合法 readme 保留，路径、哈希或大小不合法时只丢掉该字段', () => {
    const readme = {
      path: 'packages/enso.example.notes/1.0.0.readme.md',
      sha256: 'b'.repeat(64),
      size: 20,
    };
    const ok = parse(index({ plugins: [plugin({ readme })] }));
    expect(ok?.plugins[0].readme).toEqual(readme);
    for (const bad of [
      { path: '../secret.md', sha256: 'b'.repeat(64), size: 20 },
      { path: '/abs.md', sha256: 'b'.repeat(64), size: 20 },
      { path: 'packages/a.md', sha256: 'zz', size: 20 },
      { path: 'packages/a.md', sha256: 'b'.repeat(64), size: 0 },
      { path: 'packages/a.md', sha256: 'b'.repeat(64), size: 256 * 1024 + 1 },
    ]) {
      const r = parse(index({ plugins: [plugin({ readme: bad })] }));
      expect(r?.plugins.map((p) => p.id)).toEqual(['enso.example.notes']);
      expect(r?.plugins[0].readme).toBeUndefined();
    }
  });

  it('category 只认已知分类；screenshots 只收 https、最多 6 张，坏项单独丢掉', () => {
    const ok = parse(
      index({
        plugins: [
          plugin({
            category: 'productivity',
            screenshots: [
              { url: 'https://cdn.example/a.png', alt: '看板' },
              { url: 'http://cdn.example/b.png', alt: 'x' },
              { url: 'https://cdn.example/c.png' },
              'https://cdn.example/d.png',
            ],
          }),
        ],
      })
    );
    expect(ok?.plugins[0]).toMatchObject({
      category: 'productivity',
      screenshots: [
        { url: 'https://cdn.example/a.png', alt: '看板' },
        { url: 'https://cdn.example/c.png', alt: '' },
      ],
    });
    const many = Array.from({ length: 8 }, (_, i) => ({ url: `https://cdn.example/${i}.png` }));
    expect(
      parse(index({ plugins: [plugin({ screenshots: many })] }))?.plugins[0].screenshots
    ).toHaveLength(6);
    const bad = parse(index({ plugins: [plugin({ category: 'games', screenshots: 'x' })] }));
    expect(bad?.plugins[0].category).toBeUndefined();
    expect(bad?.plugins[0].screenshots).toBeUndefined();
  });
});
