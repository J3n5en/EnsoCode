import { describe, expect, it } from 'vitest';
import {
  REMOTE_DELTA_STALE,
  RemoteReadCache,
  RemoteReadClient,
  RemoteWriteBases,
  RemoteWriteClient,
  UpsertDecoder,
  UpsertEncoder,
  writeSeedOf,
} from './remoteDelta';

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
};

function writePair() {
  const host = new RemoteWriteBases();
  const client = new RemoteWriteClient();
  const written: unknown[] = [];
  const sent: unknown[] = [];
  const send = async (arg: unknown) => {
    sent.push(arg);
    const { value, commit } = host.resolve('k', structuredClone(arg));
    written.push(value);
    commit();
    return true;
  };
  return { host, client, written, sent, send };
}

describe('远端写入增量', () => {
  it('首写整份，之后只发变化；相同值不发', async () => {
    const { client, written, sent, send } = writePair();
    const big = { conversations: { a: { title: 'x'.repeat(2000), activeMs: 1 } } };
    await client.write('k', big, send);
    const next = { conversations: { a: { title: 'x'.repeat(2000), activeMs: 2 } } };
    await client.write('k', next, send);
    expect(written).toEqual([big, next]);
    expect(JSON.stringify(sent[1]).length).toBeLessThan(200);
    expect(await client.write('k', structuredClone(next), send)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('宿主基线不符时报 stale，客户端改发整份', async () => {
    const { host, client, written, send } = writePair();
    const v1 = { a: 'y'.repeat(500), n: 1 };
    await client.write('k', v1, send);
    host.resolve('k', undefined).commit();
    const v2 = { a: 'y'.repeat(500), n: 2 };
    await client.write('k', v2, send);
    expect(written.at(-1)).toEqual(v2);
    expect(() => host.resolve('k', { __ensoWrite: { r: 9, b: 7, ops: [] } })).toThrow(
      REMOTE_DELTA_STALE
    );
  });

  it('写失败不推进基线', async () => {
    const { client, written, send } = writePair();
    const v1 = { a: 'z'.repeat(500), n: 1 };
    await client.write('k', v1, send);
    await expect(
      client.write('k', { ...v1, n: 2 }, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await client.write('k', { ...v1, n: 3 }, send);
    expect(written.at(-1)).toEqual({ ...v1, n: 3 });
  });

  it('删除键透传 undefined 并清空基线', async () => {
    const { client, written, send } = writePair();
    await client.write('k', { a: 1 }, send);
    await client.write('k', undefined, send);
    await client.write('k', { a: 1 }, send);
    expect(written).toEqual([{ a: 1 }, undefined, { a: 1 }]);
  });

  it('两端用同一次读取结果做基线：首写也只发变化', async () => {
    const { host, client, written, sent, send } = writePair();
    const read = { state: { rows: 'r'.repeat(5000) }, version: 1 };
    host.seed('k', structuredClone(read));
    client.seed('k', structuredClone(read));
    const next = { state: { rows: 'r'.repeat(5000), activeId: 'a' }, version: 1 };
    await client.write('k', next, send);
    expect(written).toEqual([next]);
    expect(JSON.stringify(sent[0]).length).toBeLessThan(200);
  });

  it('只有宿主没有基线时报 stale，客户端改发整份', async () => {
    const { client, written, send } = writePair();
    const read = { a: 'q'.repeat(500) };
    client.seed('k', read);
    await client.write('k', { ...read, n: 1 }, send);
    expect(written).toEqual([{ ...read, n: 1 }]);
  });

  it('两端基线来自不同的读取（并发读写换序）：报 stale 改发整份，不会套错基线', async () => {
    const { host, client, written, send } = writePair();
    host.seed('k', { a: 'h'.repeat(500), from: 'second' });
    const first = { a: 'h'.repeat(500), from: 'first' };
    client.seed('k', first);
    await client.write('k', { ...first, n: 1 }, send);
    expect(written).toEqual([{ ...first, n: 1 }]);
  });

  it('两端基线内容相同、对象键顺序不同（客户端由缓存加增量拼出）：仍只发变化', async () => {
    const { host, client, written, sent, send } = writePair();
    const rows = { b: { t: 'r'.repeat(3000) }, a: { t: 's'.repeat(3000), n: 1 } };
    host.seed('k', { state: { rows, activeId: 'a' }, version: 1 });
    const reordered = {
      version: 1,
      state: { activeId: 'a', rows: { a: { n: 1, t: rows.a.t }, b: rows.b } },
    };
    client.seed('k', reordered);
    const next = structuredClone(reordered);
    next.state.activeId = 'b';
    await client.write('k', next, send);
    expect(written).toEqual([next]);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]).length).toBeLessThan(200);
  });

  it('会话读取结果映射到会话记录的写入键', () => {
    expect(writeSeedOf('conversations:read', { value: { state: {} }, seq: 3 })).toEqual({
      name: 'enso-conversations',
      value: { state: {} },
    });
    expect(writeSeedOf('conversations:read', { seq: 3 })).toBeNull();
    expect(writeSeedOf('settings:read', { value: 1 })).toBeNull();
  });
});

describe('远端只读结果缓存', () => {
  it('未变返回 same，变化时按客户端已有版本发增量', async () => {
    const host = new RemoteReadCache(hash);
    const client = new RemoteReadClient(new Map());
    const replies: unknown[] = [];
    const read = (value: unknown) =>
      client.read('settings:read', async (ifNone) => {
        const reply = host.respond(value, ifNone);
        replies.push(reply);
        return reply;
      });
    const v1 = { s: 'q'.repeat(3000), n: 1 };
    expect(await read(v1)).toEqual(v1);
    expect(await read(v1)).toEqual(v1);
    expect(replies[1]).toMatchObject({ __ensoCached: { same: 1 } });
    const v2 = { ...v1, n: 2 };
    expect(await read(v2)).toEqual(v2);
    expect(JSON.stringify(replies[2]).length).toBeLessThan(200);
  });

  it('宿主不认识客户端版本时发整份；同时发出的相同读取只请求一次', async () => {
    const client = new RemoteReadClient(new Map());
    let calls = 0;
    const send = async (ifNone: string) => {
      calls++;
      return new RemoteReadCache(hash).respond({ v: 1 }, ifNone);
    };
    const [a, b] = await Promise.all([client.read('x', send), client.read('x', send)]);
    expect(a).toEqual({ v: 1 });
    expect(b).toEqual({ v: 1 });
    expect(a).not.toBe(b);
    expect(calls).toBe(1);
  });

  it('其他读取较多时仍保留旧基线，回来只发增量', () => {
    const host = new RemoteReadCache(hash);
    const v1 = { s: 'q'.repeat(3000), n: 1 };
    const base = host.respond(v1, '').__ensoCached.h;
    for (let i = 0; i < 40; i++) host.respond({ tail: i }, '');
    const reply = host.respond({ ...v1, n: 2 }, base).__ensoCached;
    expect(reply.ops).toBeDefined();
    expect(reply.v).toBeUndefined();
  });
});

describe('流式消息增量', () => {
  const msg = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });

  it('首帧整条，之后发追加；接收端还原', () => {
    const enc = new UpsertEncoder();
    const dec = new UpsertDecoder();
    const base = 'hello '.repeat(20);
    const frames = [base, `${base}a`, `${base}ab`].map((t) => enc.encode('k', msg(t)));
    expect(frames[0].message).toEqual(msg(base));
    expect(frames[2].message).toBeUndefined();
    expect(JSON.stringify(frames[2]).length).toBeLessThan(120);
    expect(frames.map((f) => dec.decode(f.mark, f.message))).toEqual([
      msg(base),
      msg(`${base}a`),
      msg(`${base}ab`),
    ]);
  });

  it('缺基线返回 null；reset 后宿主重发整条', () => {
    const enc = new UpsertEncoder();
    const dec = new UpsertDecoder();
    const base = 'w'.repeat(200);
    enc.encode('k', msg(base));
    const lost = enc.encode('k', msg(`${base}1`));
    expect(dec.decode(lost.mark, lost.message)).toBeNull();
    enc.reset();
    const again = enc.encode('k', msg(`${base}12`));
    expect(dec.decode(again.mark, again.message)).toEqual(msg(`${base}12`));
  });
});
