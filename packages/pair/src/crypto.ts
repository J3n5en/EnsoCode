import nacl from 'tweetnacl';

/** 配对与业务帧的加密原语。三端（Electron main / PWA / 单测）共用同一实现。 */

export class PairCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairCryptoError';
  }
}

const VERSION = 1;
const NONCE_LEN = 12; // AES-GCM 96-bit nonce
const TAG_LEN = 16;
const CONTENT_KEY_LEN = 32; // AES-256

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 取视图对应的独立 ArrayBuffer 交给 Web Crypto（TS7 下 Uint8Array<ArrayBufferLike> 不满足 BufferSource） */
function ab(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

// ── 配对换钥（NaCl box，Curve25519-XSalsa20-Poly1305）───────────────────

export interface PairKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Electron 侧生成一次性 box 密钥对，公钥进 QR，私钥留本地解开 boxedKey */
export function generatePairKeypair(): PairKeypair {
  return nacl.box.keyPair();
}

/** 手机侧生成 32 字节 contentKey */
export function generateContentKey(): Uint8Array {
  return nacl.randomBytes(CONTENT_KEY_LEN);
}

export interface BoxedContentKey {
  /** 发送方一次性公钥，接收方据此解 box */
  ephPublicKey: Uint8Array;
  nonce: Uint8Array;
  boxed: Uint8Array;
}

/** 手机用 Electron 公钥把 contentKey box 起来（发送方用一次性 ephemeral 密钥对） */
export function boxContentKey(
  contentKey: Uint8Array,
  recipientPublicKey: Uint8Array
): BoxedContentKey {
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(contentKey, nonce, recipientPublicKey, eph.secretKey);
  return { ephPublicKey: eph.publicKey, nonce, boxed };
}

/** Electron 用留存的私钥解开 boxedKey，拿到与手机同一把 contentKey */
export function openBoxedContentKey(
  boxed: BoxedContentKey,
  recipientSecretKey: Uint8Array
): Uint8Array {
  const out = nacl.box.open(boxed.boxed, boxed.nonce, boxed.ephPublicKey, recipientSecretKey);
  if (!out) throw new PairCryptoError('unbox failed: wrong key or tampered payload');
  return out;
}

// ── 业务帧（AES-256-GCM，Web Crypto）────────────────────────────────────
// 帧布局：version(1) + nonce(12) + ciphertext + tag(16)

async function importContentKey(contentKey: Uint8Array): Promise<CryptoKey> {
  if (contentKey.length !== CONTENT_KEY_LEN) {
    throw new PairCryptoError(`contentKey must be ${CONTENT_KEY_LEN} bytes`);
  }
  return crypto.subtle.importKey('raw', ab(contentKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** 加密任意 JSON payload 成一帧密文 */
export async function sealFrame(contentKey: Uint8Array, payload: unknown): Promise<Uint8Array> {
  const key = await importContentKey(contentKey);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(nonce) }, key, ab(plaintext))
  );
  const frame = new Uint8Array(1 + NONCE_LEN + ct.length);
  frame[0] = VERSION;
  frame.set(nonce, 1);
  frame.set(ct, 1 + NONCE_LEN);
  return frame;
}

/** 解开一帧密文；错误密钥 / 篡改 / 版本不符均抛 PairCryptoError */
export async function openFrame(contentKey: Uint8Array, frame: Uint8Array): Promise<unknown> {
  if (frame.length < 1 + NONCE_LEN + TAG_LEN) {
    throw new PairCryptoError('frame too short');
  }
  if (frame[0] !== VERSION) {
    throw new PairCryptoError(`unsupported frame version ${frame[0]}`);
  }
  const nonce = frame.subarray(1, 1 + NONCE_LEN);
  const ct = frame.subarray(1 + NONCE_LEN);
  const key = await importContentKey(contentKey);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(nonce) }, key, ab(ct));
  } catch {
    throw new PairCryptoError('decrypt failed: wrong key or tampered frame');
  }
  try {
    return JSON.parse(decoder.decode(new Uint8Array(plaintext)));
  } catch {
    throw new PairCryptoError('decrypt ok but payload is not valid JSON');
  }
}
