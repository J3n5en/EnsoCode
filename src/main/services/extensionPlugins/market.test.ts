import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type MarketFetch, marketSources, PluginMarket } from './market';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const zip = Buffer.from('PK-fake-zip');
const sha = createHash('sha256').update(zip).digest('hex');

const indexOf = (sequence: number, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  generatedAt: '',
  sequence,
  plugins: [
    {
      id: 'enso.notes',
      name: 'Notes',
      tier: 'official',
      versions: [
        {
          version: '1.0.0',
          path: 'packages/enso.notes/1.0.0.zip',
          sha256: sha,
          size: zip.length,
          ...over,
        },
      ],
    },
  ],
});
const signed = (value: unknown) => {
  const index = Buffer.from(JSON.stringify(value));
  return { index, sig: Buffer.from(sign(null, index, privateKey).toString('base64')) };
};

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-market-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 每个源一张路径→内容表；不在表里返回 404，值为 'down' 时抛网络错误 */
function fakeFetch(
  sites: Record<string, Record<string, Buffer> | 'down'>,
  log: string[] = []
): MarketFetch {
  return async (url) => {
    log.push(url);
    const base = Object.keys(sites).find((b) => url.startsWith(b));
    const site = base ? sites[base] : undefined;
    if (!base || site === 'down') throw new Error('network');
    const body = site?.[url.slice(base.length)];
    if (!body)
      return {
        status: 404,
        headers: new Headers(),
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    return {
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(body));
          c.close();
        },
      }),
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    };
  };
}

const site = (seq: number, extra: Record<string, Buffer> = {}) => {
  const s = signed(indexOf(seq));
  return {
    'index.json': s.index,
    'index.json.sig': s.sig,
    'packages/enso.notes/1.0.0.zip': zip,
    ...extra,
  };
};

const market = (
  root: string,
  fetch: MarketFetch,
  sources = ['https://a/v1/', 'https://b/v1/'],
  builtin = null as null | { index: string; signature: string }
) =>
  new PluginMarket({
    root,
    fetch,
    hostVersion: '1.0.0',
    publicKeys: [publicPem],
    sources: () => sources,
    builtin,
  });

describe('marketSources', () => {
  it('国内镜像开关决定 jsDelivr 与 GitHub 的先后，Worker 始终第一', () => {
    const off = marketSources(false);
    const on = marketSources(true);
    expect(off[0]).toBe(on[0]);
    expect(on.findIndex((u) => u.includes('jsdelivr'))).toBeLessThan(
      on.findIndex((u) => u.includes('githubusercontent'))
    );
    expect(off.findIndex((u) => u.includes('githubusercontent'))).toBeLessThan(
      off.findIndex((u) => u.includes('jsdelivr'))
    );
  });
});

describe('PluginMarket.index', () => {
  it('第一个源挂了用下一个', async () => {
    const log: string[] = [];
    const m = market(temp(), fakeFetch({ 'https://a/v1/': 'down', 'https://b/v1/': site(3) }, log));
    const r = await m.index();
    expect(r.ok && r.index.sequence).toBe(3);
    expect(log[0]).toBe('https://a/v1/index.json');
  });

  it('签名被篡改的源被跳过', async () => {
    const bad = site(9);
    bad['index.json'] = Buffer.from(bad['index.json'].toString().replace('Notes', 'Evil'));
    const r = await market(
      temp(),
      fakeFetch({ 'https://a/v1/': bad, 'https://b/v1/': site(3) })
    ).index();
    expect(r.ok && r.index.sequence).toBe(3);
  });

  it('全部源失败时用磁盘缓存；拒绝比已见更旧的索引', async () => {
    const root = temp();
    await market(root, fakeFetch({ 'https://a/v1/': site(5) })).index();
    const offline = await market(root, fakeFetch({})).index();
    expect(offline.ok && offline.index.sequence).toBe(5);
    expect(offline.ok && offline.stale).toBe(true);
    const rollback = await market(root, fakeFetch({ 'https://a/v1/': site(4) })).index({
      refresh: true,
    });
    expect(rollback.ok && rollback.index.sequence).toBe(5);
  });

  it('没有缓存时用内置索引，内置索引同样验签', async () => {
    const s = signed(indexOf(2));
    const good = await market(temp(), fakeFetch({}), undefined, {
      index: s.index.toString(),
      signature: s.sig.toString(),
    }).index();
    expect(good.ok && good.index.sequence).toBe(2);
    const bad = await market(temp(), fakeFetch({}), undefined, {
      index: s.index.toString(),
      signature: 'AAAA',
    }).index();
    expect(bad.ok).toBe(false);
  });

  it('不 refresh 时复用内存结果', async () => {
    const log: string[] = [];
    const m = market(temp(), fakeFetch({ 'https://a/v1/': site(1) }, log));
    await m.index();
    await m.index();
    expect(log.filter((u) => u.endsWith('index.json'))).toHaveLength(1);
  });
});

describe('PluginMarket.download', () => {
  it('下载并校验 sha256；源返回被篡改的包时换下一个源', async () => {
    const root = temp();
    const evil = site(1, { 'packages/enso.notes/1.0.0.zip': Buffer.from('PK-evil-zip') });
    const m = market(root, fakeFetch({ 'https://a/v1/': evil, 'https://b/v1/': site(1) }));
    const dest = join(root, 'x.zip');
    const r = await m.download('enso.notes', undefined, dest);
    expect(r).toEqual({ ok: true, version: '1.0.0' });
    expect(readFileSync(dest).equals(zip)).toBe(true);
  });

  it('所有源的包都不符时失败；未知插件或版本报错', async () => {
    const root = temp();
    const evil = site(1, { 'packages/enso.notes/1.0.0.zip': Buffer.from('PK-evil-zip') });
    const m = market(root, fakeFetch({ 'https://a/v1/': evil }));
    expect((await m.download('enso.notes', undefined, join(root, 'x.zip'))).ok).toBe(false);
    expect((await m.download('enso.nope', undefined, join(root, 'y.zip'))).ok).toBe(false);
    expect((await m.download('enso.notes', '9.9.9', join(root, 'z.zip'))).ok).toBe(false);
  });
});

describe('PluginMarket.mirror', () => {
  it('国内镜像开关持久化', () => {
    const root = temp();
    market(root, fakeFetch({})).setChinaMirror(true);
    expect(market(root, fakeFetch({})).chinaMirror()).toBe(true);
  });
});
