import { describe, expect, it } from 'vitest';
import {
  createRemoteBinaryPartAssembler,
  createRemoteOrderedStream,
  createRemotePartAssembler,
  decodeRemoteValue,
  encodeRemoteValue,
  gunzipRemoteFrame,
  gzipRemoteJson,
  isRemoteBinaryPart,
  isRemotePart,
  type RemoteBinaryPart,
  type RemotePart,
  splitRemoteBinaryFrame,
  splitRemoteFrame,
} from './remote';

const roundTrip = (value: unknown) =>
  decodeRemoteValue(JSON.parse(JSON.stringify(encodeRemoteValue(value))));

describe('remote value codec', () => {
  it('restores structured-clone types that JSON loses', () => {
    const value = {
      bytes: new Uint8Array([0, 1, 255]),
      map: new Map([['a', 1]]),
      set: new Set([1, 2]),
      date: new Date(5),
      big: 10n,
      args: [undefined, 1],
      inf: Number.POSITIVE_INFINITY,
    };
    expect(roundTrip(value)).toEqual(value);
  });

  it('drops undefined object properties like JSON but keeps array slots', () => {
    expect(roundTrip({ a: undefined, b: [undefined] })).toEqual({ b: [undefined] });
    expect(roundTrip(undefined)).toBeUndefined();
  });

  it('turns errors into plain errors without stack', () => {
    const decoded = roundTrip(new TypeError('boom')) as Error;
    expect(decoded).toBeInstanceOf(Error);
    expect(decoded.name).toBe('TypeError');
    expect(decoded.message).toBe('boom');
  });

  it('breaks cycles instead of throwing', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(roundTrip(a)).toEqual({ x: 1, self: null });
  });

  it('ignores __proto__ keys from untrusted input', () => {
    const decoded = decodeRemoteValue(JSON.parse('{"__proto__":{"polluted":1},"a":1}')) as object;
    expect(decoded).toEqual({ a: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('remote frame parts', () => {
  it('keeps small frames intact', () => {
    const message = { type: 'rpc-event', ch: 'x', args: [] };
    expect(splitRemoteFrame(message, () => 'p', 100)).toEqual([message]);
  });

  it('splits large frames and reassembles out of order', () => {
    const message = { type: 'asset', data: '中'.repeat(250) + 'x'.repeat(300) };
    const parts = splitRemoteFrame(message, () => 'pid', 100) as RemotePart[];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(isRemotePart)).toBe(true);
    const assembler = createRemotePartAssembler();
    const shuffled = [...parts].reverse();
    const results = shuffled.map((part) => assembler.push(part));
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
    expect(results.at(-1)).toEqual(message);
  });

  it('rejects malformed parts', () => {
    expect(isRemotePart({ type: 'part', pid: 'a', index: 2, total: 2, data: '' })).toBe(false);
    expect(isRemotePart({ type: 'part', pid: '', index: 0, total: 1, data: '' })).toBe(false);
    expect(isRemotePart({ type: 'part', pid: 'a', index: 0, total: 5000, data: '' })).toBe(false);
  });

  it('expires stale partial frames', () => {
    let t = 0;
    const assembler = createRemotePartAssembler({ ttlMs: 10, now: () => t });
    assembler.push({ type: 'part', pid: 'a', index: 0, total: 2, data: '{"x":' });
    t = 100;
    expect(assembler.push({ type: 'part', pid: 'a', index: 1, total: 2, data: '1}' })).toBeNull();
  });
});

describe('remote ordered stream', () => {
  it('applies frames in seq order even when big frames arrive late', () => {
    const stream = createRemoteOrderedStream<string>();
    expect(stream.push(2, 'b')).toEqual([]);
    expect(stream.gap).toBe(true);
    expect(stream.push(1, 'a')).toEqual(['a', 'b']);
    expect(stream.gap).toBe(false);
    expect(stream.applied).toBe(2);
  });

  it('drops replayed duplicates after a resume', () => {
    const stream = createRemoteOrderedStream<string>();
    stream.push(1, 'a');
    stream.push(3, 'c');
    expect(stream.push(1, 'a')).toEqual([]);
    expect(stream.push(3, 'c')).toEqual([]);
    expect(stream.push(2, 'b')).toEqual(['b', 'c']);
  });

  it('passes through frames without seq (old host)', () => {
    const stream = createRemoteOrderedStream<string>();
    expect(stream.push(undefined, 'x')).toEqual(['x']);
    expect(stream.applied).toBe(0);
  });

  it('reports overflow when a gap never fills', () => {
    const stream = createRemoteOrderedStream<number>({ maxHeld: 3 });
    for (let seq = 2; seq <= 4; seq++) stream.push(seq, seq);
    expect(stream.overflowed).toBe(false);
    stream.push(5, 5);
    expect(stream.overflowed).toBe(true);
  });
});

describe('remote gzip frames', () => {
  it('round-trips a large host frame', async () => {
    const frame = {
      type: 'rpc-result' as const,
      cid: 'c',
      id: 1,
      ok: true as const,
      data: 'x'.repeat(200_000),
      seq: 3,
    };
    const packed = await gzipRemoteJson(JSON.stringify(frame));
    expect(packed.type).toBe('gzip');
    expect(packed.data.length).toBeLessThan(10_000);
    expect(await gunzipRemoteFrame(packed)).toEqual(frame);
  });

  it('rejects garbage instead of throwing', async () => {
    expect(await gunzipRemoteFrame({ type: 'gzip', data: 'bm90IGd6aXA=' })).toBeNull();
  });
});

describe('remote binary parts (bpart)', () => {
  it('keeps small frames unsplit', async () => {
    const msg = { type: 'rpc-event' as const, cid: 'c1', ch: 'evt', args: ['hello'], seq: 1 };
    expect(await splitRemoteBinaryFrame(msg, () => 'p', { limit: 1024 })).toEqual([msg]);
  });

  it('splits large compressible JS asset with raw gzip and reassembles out of order', async () => {
    const body = new TextEncoder().encode('console.log("hi");\n'.repeat(500));
    const msg = { type: 'asset' as const, id: 9, status: 200, mime: 'text/javascript', bin: body };
    const parts = (await splitRemoteBinaryFrame(msg, () => 'bp1', {
      limit: 300,
    })) as RemoteBinaryPart[];
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(parts.every((p) => isRemoteBinaryPart(p, 300))).toBe(true);
    expect(parts[0]?.gz).toBe(true);
    expect(parts[0]?.enc).toBe('bin');

    const assembler = createRemoteBinaryPartAssembler();
    const reversed = [...parts].reverse();
    let assembled: unknown = null;
    for (const part of reversed) {
      assembled = await assembler.push(part);
    }
    const out = assembled as typeof msg;
    expect(out.type).toBe('asset');
    expect(out.id).toBe(9);
    expect(Buffer.from(out.bin).equals(Buffer.from(body))).toBe(true);
  });

  it('skips gzip for incompressible PNG asset and splits cleanly', async () => {
    const png = new Uint8Array(1500);
    crypto.getRandomValues(png);
    const msg = { type: 'asset' as const, id: 10, status: 200, mime: 'image/png', bin: png };
    const parts = (await splitRemoteBinaryFrame(msg, () => 'bp2', {
      limit: 400,
    })) as RemoteBinaryPart[];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.gz === undefined && isRemoteBinaryPart(p, 400))).toBe(true);

    const assembler = createRemoteBinaryPartAssembler();
    let assembled: unknown = null;
    for (const part of parts) assembled = await assembler.push(part);
    const out = assembled as typeof msg;
    expect(Buffer.from(out.bin).equals(Buffer.from(png))).toBe(true);
  });

  it('splits large JSON frame with gz json encoding', async () => {
    const msg = {
      type: 'rpc-result' as const,
      cid: 'c1',
      id: 1,
      ok: true as const,
      data: Array.from({ length: 100 }, (_, i) => ({ idx: i, text: 'hello world' })),
      seq: 2,
    };
    const parts = (await splitRemoteBinaryFrame(msg, () => 'bp3', {
      limit: 150,
    })) as RemoteBinaryPart[];
    expect(parts.every((p) => p.enc === 'json' && isRemoteBinaryPart(p, 150))).toBe(true);
    const assembler = createRemoteBinaryPartAssembler();
    let assembled: unknown = null;
    for (const part of parts) assembled = await assembler.push(part);
    expect(assembled).toEqual(msg);
  });

  it('rejects malformed bpart and expires stale entries', async () => {
    expect(
      isRemoteBinaryPart({
        type: 'bpart',
        pid: 'a',
        index: 1,
        total: 1,
        enc: 'json',
        bin: new Uint8Array(1),
      })
    ).toBe(false);
    expect(
      isRemoteBinaryPart({
        type: 'bpart',
        pid: 'a',
        index: 0,
        total: 1,
        enc: 'bad',
        bin: new Uint8Array(1),
      })
    ).toBe(false);

    let now = 0;
    const assembler = createRemoteBinaryPartAssembler({ ttlMs: 10, now: () => now });
    expect(
      await assembler.push({
        type: 'bpart',
        pid: 'stale',
        index: 0,
        total: 2,
        enc: 'json',
        bin: new Uint8Array([123]),
      })
    ).toBeNull();
    now = 20;
    expect(
      await assembler.push({
        type: 'bpart',
        pid: 'stale',
        index: 1,
        total: 2,
        enc: 'json',
        bin: new Uint8Array([125]),
      })
    ).toBeNull();
  });
});
