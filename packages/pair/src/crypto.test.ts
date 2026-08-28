import { describe, expect, it } from 'vitest';
import {
  boxContentKey,
  generateContentKey,
  generatePairKeypair,
  openBoxedContentKey,
  openFrame,
  PairCryptoError,
  sealFrame,
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
});
