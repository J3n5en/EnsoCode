import { describe, expect, it, vi } from 'vitest';
import {
  boxContentKey,
  FRAME_V2_GZIP_MIN_BYTES,
  type FrameCodec,
  generateContentKey,
  generatePairKeypair,
  isIncompressibleMime,
  openBoxedContentKey,
  openFrame,
  PairCryptoError,
  sealFrame,
  sealFrameV2,
} from './crypto';

describe('AES-256-GCM 业务帧', () => {
  it('往返：对象/数组/中文/空值', async () => {
    const key = generateContentKey();
    for (const payload of [
      { type: 'prompt', sessionId: 's1', text: '你好，世界' },
      [1, 2, 3, 'a'],
      { nested: { a: [true, null, 'x'] } },
      null,
    ]) {
      const frame = await sealFrame(key, payload);
      expect(await openFrame(key, frame)).toEqual(payload);
    }
  });

  it('每次加密 nonce 随机，密文不同', async () => {
    const key = generateContentKey();
    const a = await sealFrame(key, { x: 1 });
    const b = await sealFrame(key, { x: 1 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('错误密钥解密失败', async () => {
    const frame = await sealFrame(generateContentKey(), { secret: 1 });
    await expect(openFrame(generateContentKey(), frame)).rejects.toBeInstanceOf(PairCryptoError);
  });

  it('篡改密文解密失败', async () => {
    const key = generateContentKey();
    const frame = await sealFrame(key, { secret: 1 });
    frame[frame.length - 1] ^= 0xff; // 翻转 tag 最后一字节
    await expect(openFrame(key, frame)).rejects.toBeInstanceOf(PairCryptoError);
  });

  it('版本不符 / 帧过短均抛错', async () => {
    const key = generateContentKey();
    const frame = await sealFrame(key, { x: 1 });
    frame[0] = 9;
    await expect(openFrame(key, frame)).rejects.toBeInstanceOf(PairCryptoError);
    await expect(openFrame(key, new Uint8Array(5))).rejects.toBeInstanceOf(PairCryptoError);
  });

  it('非 32 字节密钥被拒', async () => {
    await expect(sealFrame(new Uint8Array(16), { x: 1 })).rejects.toBeInstanceOf(PairCryptoError);
  });
});

describe('NaCl box 换钥（Happy 对调：Electron 持钥）', () => {
  it('手机 box、Electron 解开，双方拿到同一把 contentKey', () => {
    const host = generatePairKeypair();
    const contentKey = generateContentKey();
    const boxed = boxContentKey(contentKey, host.publicKey);
    const recovered = openBoxedContentKey(boxed, host.secretKey);
    expect(Buffer.from(recovered).equals(Buffer.from(contentKey))).toBe(true);
  });

  it('错误私钥解 box 失败', () => {
    const host = generatePairKeypair();
    const wrong = generatePairKeypair();
    const boxed = boxContentKey(generateContentKey(), host.publicKey);
    expect(() => openBoxedContentKey(boxed, wrong.secretKey)).toThrow(PairCryptoError);
  });

  it('换钥后 contentKey 可直接用于业务帧往返', async () => {
    const host = generatePairKeypair();
    const contentKey = generateContentKey();
    const boxed = boxContentKey(contentKey, host.publicKey);
    const hostKey = openBoxedContentKey(boxed, host.secretKey);
    const frame = await sealFrame(contentKey, { type: 'snapshot' });
    expect(await openFrame(hostKey, frame)).toEqual({ type: 'snapshot' });
  });

  it('复用同一 Uint8Array 的 CryptoKey，原址改字节时失效并重新导入', async () => {
    const spy = vi.spyOn(crypto.subtle, 'importKey');
    try {
      const key = generateContentKey();
      const f1 = await sealFrame(key, { n: 1 });
      const f2 = await sealFrame(key, { n: 2 });
      expect(await openFrame(key, f1)).toEqual({ n: 1 });
      expect(await openFrame(key, f2)).toEqual({ n: 2 });
      expect(spy).toHaveBeenCalledTimes(1);

      key[0] ^= 0xff;
      await expect(openFrame(key, f1)).rejects.toThrow(PairCryptoError);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('二进制加密帧 v2 与智能压缩', () => {
  it('openFrame 同时兼容 v1 与 v2（JSON、二进制 bin 与两者叠加）', async () => {
    const key = generateContentKey();
    const v1 = await sealFrame(key, { type: 'ping', n: 1 });
    expect(v1[0]).toBe(1);
    expect(await openFrame(key, v1)).toEqual({ type: 'ping', n: 1 });

    const small = await sealFrameV2(key, { type: 'ping', n: 2 });
    expect(small[0]).toBe(2);
    expect(await openFrame(key, small)).toEqual({ type: 'ping', n: 2 });

    const rawBytes = new Uint8Array([0, 1, 2, 255, 128]);
    const withBin = await sealFrameV2(key, {
      type: 'asset',
      id: 7,
      status: 200,
      mime: 'image/png',
      bin: rawBytes,
    });
    expect(withBin[0]).toBe(2);
    const decoded = (await openFrame(key, withBin)) as {
      type: string;
      id: number;
      status: number;
      mime: string;
      bin: Uint8Array;
    };
    expect(decoded.type).toBe('asset');
    expect(decoded.id).toBe(7);
    expect(decoded.bin).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(decoded.bin).equals(Buffer.from(rawBytes))).toBe(true);

    const emptyBin = await sealFrameV2(key, {
      type: 'asset',
      id: 8,
      status: 200,
      mime: 'application/octet-stream',
      bin: new Uint8Array(0),
    });
    const decodedEmpty = (await openFrame(key, emptyBin)) as { bin: Uint8Array };
    expect(decodedEmpty.bin).toBeInstanceOf(Uint8Array);
    expect(decodedEmpty.bin.byteLength).toBe(0);
  });

  it('v2 从 2KB 起自动原生 gzip 且无 Base64 膨胀；不可压缩与无法缩小的载荷自动跳过 gzip', async () => {
    const key = generateContentKey();
    const textPayload = {
      type: 'rpc-result',
      cid: 'c1',
      id: 1,
      ok: true,
      data: '重复文本abc123'.repeat(400),
    };
    expect(Buffer.byteLength(JSON.stringify(textPayload))).toBeGreaterThanOrEqual(
      FRAME_V2_GZIP_MIN_BYTES
    );
    const packedJson = await sealFrameV2(key, textPayload);
    expect(packedJson.byteLength).toBeLessThan(1500);
    expect(await openFrame(key, packedJson)).toEqual(textPayload);

    // 文本类二进制 asset（如 JS）直接二进制+gzip，比 JSON+base64 更小
    const jsBytes = new TextEncoder().encode('export const x = 42;\n'.repeat(400));
    const assetV2 = await sealFrameV2(key, {
      type: 'asset',
      id: 1,
      status: 200,
      mime: 'application/javascript; charset=utf-8',
      bin: jsBytes,
    });
    expect(assetV2.byteLength).toBeLessThan(1000);
    const decodedJs = (await openFrame(key, assetV2)) as { bin: Uint8Array };
    expect(Buffer.from(decodedJs.bin).equals(Buffer.from(jsBytes))).toBe(true);

    // PNG/WOFF2 等不可压缩 MIME 应跳过 gzip（codec.gzip 不被调用）
    const gzipSpy = vi.fn(async (d: Uint8Array) => d);
    const codec: FrameCodec = {
      gzip: gzipSpy,
      gunzip: vi.fn(async (d: Uint8Array) => d),
    };
    const fakePng = new Uint8Array(8192).fill(0x89);
    const pngFrame = await sealFrameV2(
      key,
      { type: 'asset', id: 2, status: 200, mime: 'IMAGE/PNG', bin: fakePng },
      { codec }
    );
    expect(gzipSpy).not.toHaveBeenCalled();
    const decodedPng = (await openFrame(key, pngFrame, { codec })) as { bin: Uint8Array };
    expect(Buffer.from(decodedPng.bin).equals(Buffer.from(fakePng))).toBe(true);

    // 纯高熵不可压缩随机数据：即使尝试 gzip 体积变大也不会使用压缩版本
    const rng = new Uint8Array(4096);
    crypto.getRandomValues(rng);
    const randomBinFrame = await sealFrameV2(key, {
      type: 'asset',
      id: 3,
      status: 200,
      mime: 'application/octet-stream',
      bin: rng,
    });
    // 无膨胀：长度不应超过 raw payload + 头文件 + GCM overhead
    expect(randomBinFrame.byteLength).toBeLessThan(rng.byteLength + 200);
    const decodedRng = (await openFrame(key, randomBinFrame)) as { bin: Uint8Array };
    expect(Buffer.from(decodedRng.bin).equals(Buffer.from(rng))).toBe(true);
  });

  it('isIncompressibleMime 识别大小写与参数后缀', () => {
    expect(isIncompressibleMime('image/png')).toBe(true);
    expect(isIncompressibleMime('Image/JPEG; charset=binary')).toBe(true);
    expect(isIncompressibleMime('font/woff2')).toBe(true);
    expect(isIncompressibleMime('audio/mpeg')).toBe(true);
    expect(isIncompressibleMime('video/mp4')).toBe(true);
    expect(isIncompressibleMime('application/javascript; charset=utf-8')).toBe(false);
    expect(isIncompressibleMime('image/svg+xml')).toBe(false);
    expect(isIncompressibleMime('text/plain')).toBe(false);
  });

  it('拒绝未知 flag、篡改密文和损坏解压流', async () => {
    const key = generateContentKey();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const keyBuf = key.slice().buffer as ArrayBuffer;
    const subtleKey = await crypto.subtle.importKey('raw', keyBuf, 'AES-GCM', false, ['encrypt']);
    const badPlaintext = new Uint8Array([0x80, 0x7b, 0x7d]); // flag 0x80 非法
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, subtleKey, badPlaintext)
    );
    const forged = new Uint8Array(1 + 12 + ct.length);
    forged[0] = 2;
    forged.set(nonce, 1);
    forged.set(ct, 13);
    await expect(openFrame(key, forged)).rejects.toBeInstanceOf(PairCryptoError);

    // 超限解压拒绝
    const tinyBombCodec: FrameCodec = {
      gzip: async () => new Uint8Array([1, 2, 3]),
      gunzip: async () => {
        throw new Error('decompression limit exceeded');
      },
    };
    const v2 = await sealFrameV2(
      key,
      { text: 'x'.repeat(3000) },
      { codec: tinyBombCodec, compress: true }
    );
    await expect(openFrame(key, v2, { codec: tinyBombCodec })).rejects.toBeInstanceOf(
      PairCryptoError
    );
  });
});
