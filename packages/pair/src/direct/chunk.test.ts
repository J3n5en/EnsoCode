import { describe, expect, it } from 'vitest';
import { CHUNK_PAYLOAD_BYTES, createReassembler, encodeChunks } from './chunk';

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * seed + 7) & 0xff;
  return out;
}

function roundTrip(frame: Uint8Array): Uint8Array | null {
  const r = createReassembler();
  let got: Uint8Array | null = null;
  for (const c of encodeChunks(frame)) {
    const done = r.push(c);
    if (done) got = done;
  }
  return got;
}

describe('DataChannel 分片编解码', () => {
  it('空帧编成单个末片，解出空帧', () => {
    const chunks = encodeChunks(new Uint8Array(0));
    expect(chunks).toHaveLength(1);
    expect(chunks[0][0]).toBe(0x01);
    expect(roundTrip(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });

  it('小于一片：单片，头字节 0x01，往返一致', () => {
    const frame = bytes(100);
    const chunks = encodeChunks(frame);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].byteLength).toBe(101);
    expect(roundTrip(frame)).toEqual(frame);
  });

  it('恰好一片边界：仍是单片；多 1 字节变两片', () => {
    expect(encodeChunks(bytes(CHUNK_PAYLOAD_BYTES))).toHaveLength(1);
    const chunks = encodeChunks(bytes(CHUNK_PAYLOAD_BYTES + 1));
    expect(chunks).toHaveLength(2);
    expect(chunks[0][0]).toBe(0x00);
    expect(chunks[1][0]).toBe(0x01);
    expect(chunks[1].byteLength).toBe(2);
  });

  it('1MB 多片往返一致，每片不超过载荷上限 + 1 字节头', () => {
    const frame = bytes(1_000_000, 3);
    const chunks = encodeChunks(frame);
    expect(chunks.length).toBe(Math.ceil(1_000_000 / CHUNK_PAYLOAD_BYTES));
    for (const c of chunks) expect(c.byteLength).toBeLessThanOrEqual(CHUNK_PAYLOAD_BYTES + 1);
    const r = createReassembler();
    let got: Uint8Array | null = null;
    for (const c of chunks) got = r.push(c) ?? got;
    expect(got).not.toBeNull();
    expect(Buffer.compare(got as Uint8Array, frame)).toBe(0);
  });

  it('中间片返回 null，末片才吐完整帧；连续两帧互不串', () => {
    const r = createReassembler();
    const a = bytes(CHUNK_PAYLOAD_BYTES + 10, 5);
    const b = bytes(20, 9);
    const [a0, a1] = encodeChunks(a);
    expect(r.push(a0)).toBeNull();
    expect(r.push(a1)).toEqual(a);
    expect(r.push(encodeChunks(b)[0])).toEqual(b);
  });

  it('非法头字节：丢弃并重置正在拼的帧', () => {
    const r = createReassembler();
    const [a0] = encodeChunks(bytes(CHUNK_PAYLOAD_BYTES + 10));
    expect(r.push(a0)).toBeNull();
    expect(r.push(new Uint8Array([0x7f, 1, 2]))).toBeNull();
    const b = bytes(5);
    expect(r.push(encodeChunks(b)[0])).toEqual(b);
  });

  it('累计超过 1MB 上限：丢弃并重置', () => {
    const r = createReassembler();
    const piece = new Uint8Array(CHUNK_PAYLOAD_BYTES + 1);
    piece[0] = 0x00;
    const pieces = Math.ceil(1_048_576 / CHUNK_PAYLOAD_BYTES) + 1;
    for (let i = 0; i < pieces; i++) expect(r.push(piece)).toBeNull();
    // 超限后进入跳过态：本帧剩余片（含末片）全部吞掉，下一帧正常
    expect(r.push(piece)).toBeNull();
    expect(r.push(new Uint8Array([0x01, 1]))).toBeNull();
    const b = bytes(5);
    expect(r.push(encodeChunks(b)[0])).toEqual(b);
  });
});
