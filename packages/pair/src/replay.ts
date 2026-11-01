import { openFrame, PairCryptoError, sealFrame } from './crypto';
import { fromBase64Url, toBase64Url } from './encoding';

/**
 * 同一把 contentKey 上的防重放。帧版本仍是 1，旧端忽略多出来的 replay 字段。
 * 见过对端质询之后，nonce 改为 8 字节连接前缀 + 4 字节计数；对端回声对上才锁定。
 * 锁定前仍收随机 nonce，所以旧端不用改。中继改不了加密字段，只能整帧丢掉。
 */

const PREFIX_LEN = 8;
const NONCE_LEN = 12;
const WINDOW = 64;

type Seal = (key: Uint8Array, payload: unknown, nonce?: Uint8Array) => Promise<Uint8Array>;
type Open = (key: Uint8Array, frame: Uint8Array) => Promise<unknown>;

interface Stamp {
  p: Uint8Array;
  c: Uint8Array;
  e?: Uint8Array;
}

export interface FrameReplay {
  seal(key: Uint8Array, payload: unknown): Promise<Uint8Array>;
  /** 解密失败仍抛错；重放或锁定后的错前缀返回 undefined，调用方丢弃 */
  open(key: Uint8Array, frame: Uint8Array): Promise<unknown | undefined>;
  /** 对端重新出现：换质询并解除接收锁定。发送前缀和计数保持，避免 nonce 复用 */
  peerReset(): void;
  /** 刚知道对端质询：调用方补一帧，好让对端锁定。只触发一次 */
  takeHello(): boolean;
}

export function isReplayHello(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'replay-hello'
  );
}

export function createFrameReplay(seal: Seal = sealFrame, open: Open = openFrame): FrameReplay {
  const sendPrefix = random(PREFIX_LEN);
  let sendCounter = 0;
  let challenge = random(PREFIX_LEN);
  let peerChallenge: Uint8Array | null = null;
  let armed = false;
  let locked = false;
  let recvPrefix: Uint8Array | null = null;
  let high = 0;
  let helloPending = false;
  let bits = 0n;

  function peerReset(): void {
    challenge = random(PREFIX_LEN);
    peerChallenge = null;
    armed = false;
    locked = false;
    recvPrefix = null;
    high = 0;
    helloPending = false;
    bits = 0n;
  }

  function announcement(): Record<string, string> {
    const stamp: Record<string, string> = {
      p: toBase64Url(sendPrefix),
      c: toBase64Url(challenge),
    };
    if (peerChallenge) stamp.e = toBase64Url(peerChallenge);
    return stamp;
  }

  function acceptCounter(counter: number): boolean {
    if (counter <= 0 || counter > 0xffffffff) return false;
    if (high === 0) {
      high = counter;
      bits = 1n;
      return true;
    }
    if (counter > high) {
      const shift = BigInt(counter - high);
      bits = shift >= BigInt(WINDOW) ? 1n : ((bits << shift) | 1n) & ((1n << BigInt(WINDOW)) - 1n);
      high = counter;
      return true;
    }
    const behind = high - counter;
    if (behind >= WINDOW) return false;
    const mask = 1n << BigInt(behind);
    if (bits & mask) return false;
    bits |= mask;
    return true;
  }

  return {
    peerReset,
    async seal(key, payload) {
      const body = stampPayload(payload, announcement());
      if (!armed) return seal(key, body);
      if (sendCounter === 0xffffffff) throw new PairCryptoError('replay counter exhausted');
      sendCounter += 1;
      const nonce = new Uint8Array(NONCE_LEN);
      nonce.set(sendPrefix, 0);
      nonce[8] = sendCounter >>> 24;
      nonce[9] = (sendCounter >>> 16) & 0xff;
      nonce[10] = (sendCounter >>> 8) & 0xff;
      nonce[11] = sendCounter & 0xff;
      return seal(key, body, nonce);
    },
    async open(key, frame) {
      const payload = await open(key, frame);
      const announced = readStamp(payload);
      if (announced && (!peerChallenge || !equal(peerChallenge, announced.c))) {
        peerChallenge = announced.c;
        armed = true;
        helloPending = true;
      }
      const nonce = frame.subarray(1, 1 + NONCE_LEN);
      if (
        announced?.e &&
        equal(announced.e, challenge) &&
        equal(nonce.subarray(0, PREFIX_LEN), announced.p)
      ) {
        if (!locked || !recvPrefix || !equal(recvPrefix, announced.p)) {
          locked = true;
          recvPrefix = announced.p;
          high = 0;
          bits = 0n;
        }
        return acceptCounter(readCounter(nonce)) ? strip(payload) : undefined;
      }
      if (!locked) return strip(payload);
      if (
        recvPrefix &&
        equal(nonce.subarray(0, PREFIX_LEN), recvPrefix) &&
        acceptCounter(readCounter(nonce))
      ) {
        return strip(payload);
      }
      return undefined;
    },
    takeHello() {
      if (!helloPending) return false;
      helloPending = false;
      return true;
    },
  };
}

function stampPayload(payload: unknown, replay: Record<string, string>): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  return { ...payload, replay };
}

function strip(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || !('replay' in payload)) return payload;
  const { replay: _, ...rest } = payload as Record<string, unknown>;
  return rest;
}

function readStamp(payload: unknown): Stamp | null {
  if (typeof payload !== 'object' || payload === null || !('replay' in payload)) return null;
  const replay = (payload as { replay?: unknown }).replay;
  if (typeof replay !== 'object' || replay === null) return null;
  const record = replay as Record<string, unknown>;
  const p = readBytes(record.p);
  const c = readBytes(record.c);
  if (!p || !c) return null;
  if (record.e === undefined) return { p, c };
  const e = readBytes(record.e);
  return e ? { p, c, e } : null;
}

function readBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  try {
    const bytes = fromBase64Url(value);
    return bytes.length === PREFIX_LEN ? bytes : null;
  } catch {
    return null;
  }
}

function readCounter(nonce: Uint8Array): number {
  return ((nonce[8] << 24) | (nonce[9] << 16) | (nonce[10] << 8) | nonce[11]) >>> 0;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function random(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}
