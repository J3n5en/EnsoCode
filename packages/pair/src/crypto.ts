import nacl from 'tweetnacl';

/** 配对与业务帧的加密原语。三端（Electron main / PWA / 单测）共用同一实现。 */

export class PairCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairCryptoError';
  }
}

const VERSION = 1;
const VERSION_V2 = 2;
const NONCE_LEN = 12; // AES-GCM 96-bit nonce
const TAG_LEN = 16;
const CONTENT_KEY_LEN = 32; // AES-256

const FLAG_GZIP = 0x01;
const FLAG_BINARY = 0x02;
const VALID_FLAGS_MASK = FLAG_GZIP | FLAG_BINARY;

/** v2 启用原生二进制 gzip 的默认阈值（字节） */
export const FRAME_V2_GZIP_MIN_BYTES = 2 * 1024;
/** 单帧解压上限（防 zip bomb 耗尽内存） */
export const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FrameCodec {
  gzip(data: Uint8Array): Promise<Uint8Array>;
  gunzip(data: Uint8Array): Promise<Uint8Array>;
}

const INCOMPRESSIBLE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/avif',
  'font/woff2',
  'font/woff',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/br',
  'application/zstd',
]);

/** 已经压缩过的 MIME 类型无需再走 gzip（忽略参数与大小写） */
export function isIncompressibleMime(mime: unknown): boolean {
  if (typeof mime !== 'string') return false;
  const base = mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!base) return false;
  return INCOMPRESSIBLE_MIMES.has(base) || base.startsWith('audio/') || base.startsWith('video/');
}

function readableFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(copy);
      controller.close();
    },
  });
}

export function concatBytes(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function runStreamCodec(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
  limit?: number
): Promise<Uint8Array> {
  const reader = readableFromBytes(bytes).pipeThrough(transform).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (limit !== undefined && total > limit) {
        await reader.cancel().catch(() => {});
        throw new PairCryptoError(`decompressed payload exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
    return concatBytes(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

export const defaultFrameCodec: FrameCodec = {
  async gzip(data) {
    if (typeof CompressionStream !== 'function') {
      throw new PairCryptoError('CompressionStream unavailable');
    }
    return runStreamCodec(data, new CompressionStream('gzip'));
  },
  async gunzip(data) {
    if (typeof DecompressionStream !== 'function') {
      throw new PairCryptoError('DecompressionStream unavailable');
    }
    return runStreamCodec(data, new DecompressionStream('gzip'), MAX_DECOMPRESSED_BYTES);
  },
};

export function packBinaryEnvelope(payload: unknown): {
  isBinary: boolean;
  bytes: Uint8Array;
  headType: unknown;
  mime: unknown;
} {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as { bin?: unknown }).bin instanceof Uint8Array
  ) {
    const { bin, ...head } = payload as Record<string, unknown> & { bin: Uint8Array };
    const headBytes = encoder.encode(JSON.stringify(head));
    const out = new Uint8Array(4 + headBytes.byteLength + bin.byteLength);
    const len = headBytes.byteLength;
    out[0] = (len >>> 24) & 0xff;
    out[1] = (len >>> 16) & 0xff;
    out[2] = (len >>> 8) & 0xff;
    out[3] = len & 0xff;
    out.set(headBytes, 4);
    out.set(bin, 4 + len);
    return { isBinary: true, bytes: out, headType: head.type, mime: head.mime };
  }
  const rec =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  return {
    isBinary: false,
    bytes: encoder.encode(JSON.stringify(payload)),
    headType: rec?.type,
    mime: rec?.mime,
  };
}

export function unpackBinaryEnvelope(raw: Uint8Array): unknown {
  if (raw.byteLength < 4) {
    throw new PairCryptoError('binary envelope too short');
  }
  const headLen = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
  if (4 + headLen > raw.byteLength) {
    throw new PairCryptoError('binary envelope head truncated');
  }
  let head: unknown;
  try {
    head = JSON.parse(decoder.decode(raw.subarray(4, 4 + headLen)));
  } catch {
    throw new PairCryptoError('binary envelope head is not valid JSON');
  }
  if (typeof head !== 'object' || head === null || Array.isArray(head)) {
    throw new PairCryptoError('binary envelope head must be an object');
  }
  return { ...(head as Record<string, unknown>), bin: raw.slice(4 + headLen) };
}

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
// v1 帧布局：version(1) + nonce(12) + ciphertext + tag(16)
// v2 帧布局：version(2) + nonce(12) + AES-GCM(flags(1) + body) + tag(16)

const keyCache = new WeakMap<Uint8Array, { bytes: Uint8Array; promise: Promise<CryptoKey> }>();

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function importContentKey(contentKey: Uint8Array): Promise<CryptoKey> {
  if (contentKey.length !== CONTENT_KEY_LEN) {
    throw new PairCryptoError(`contentKey must be ${CONTENT_KEY_LEN} bytes`);
  }
  const cached = keyCache.get(contentKey);
  if (cached && bytesEqual(cached.bytes, contentKey)) return cached.promise;
  const bytes = contentKey.slice();
  const promise = crypto.subtle.importKey('raw', ab(bytes), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  const entry = { bytes, promise };
  keyCache.set(contentKey, entry);
  void promise.catch(() => {
    if (keyCache.get(contentKey) === entry) keyCache.delete(contentKey);
  });
  return promise;
}

async function sealEncrypted(
  contentKey: Uint8Array,
  version: number,
  plaintext: Uint8Array,
  nonce: Uint8Array
): Promise<Uint8Array> {
  const key = await importContentKey(contentKey);
  if (nonce.length !== NONCE_LEN) throw new PairCryptoError('nonce must be 12 bytes');
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(nonce) }, key, ab(plaintext))
  );
  const frame = new Uint8Array(1 + NONCE_LEN + ct.length);
  frame[0] = version;
  frame.set(nonce, 1);
  frame.set(ct, 1 + NONCE_LEN);
  return frame;
}

/** 加密任意 JSON payload 成一帧密文（v1，兼容旧端） */
export async function sealFrame(
  contentKey: Uint8Array,
  payload: unknown,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(NONCE_LEN))
): Promise<Uint8Array> {
  const plaintext = encoder.encode(JSON.stringify(payload));
  return sealEncrypted(contentKey, VERSION, plaintext, nonce);
}

export interface SealFrameV2Options {
  nonce?: Uint8Array;
  codec?: FrameCodec;
  compress?: boolean;
  minGzipBytes?: number;
}

/** 加密 v2 帧：支持原生二进制 gzip 与 bin: Uint8Array 零 Base64 附载 */
export async function sealFrameV2(
  contentKey: Uint8Array,
  payload: unknown,
  opts: SealFrameV2Options = {}
): Promise<Uint8Array> {
  const nonce = opts.nonce ?? crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const { isBinary, bytes, headType, mime } = packBinaryEnvelope(payload);
  let flags = isBinary ? FLAG_BINARY : 0;
  let body = bytes;

  const minGzipBytes = opts.minGzipBytes ?? FRAME_V2_GZIP_MIN_BYTES;
  const skipGzip =
    opts.compress === false ||
    headType === 'gzip' ||
    headType === 'bpart' ||
    ((headType === 'asset' || isBinary) && isIncompressibleMime(mime));
  const codec = opts.codec ?? defaultFrameCodec;
  const hasStreamGzip = typeof CompressionStream === 'function';
  const wantGzip =
    !skipGzip &&
    (opts.compress === true || body.byteLength >= minGzipBytes) &&
    (opts.codec !== undefined || hasStreamGzip);

  if (wantGzip) {
    try {
      const packed = await codec.gzip(body);
      if (packed.byteLength < body.byteLength) {
        body = packed;
        flags |= FLAG_GZIP;
      }
    } catch {
      // 压缩失败时回退未压缩字节，避免正常发帧中断
    }
  }

  const plaintext = new Uint8Array(1 + body.byteLength);
  plaintext[0] = flags;
  plaintext.set(body, 1);
  return sealEncrypted(contentKey, VERSION_V2, plaintext, nonce);
}

/** 解开一帧密文（自动兼容 v1 与 v2）；错误密钥 / 篡改 / 版本不符均抛 PairCryptoError */
export async function openFrame(
  contentKey: Uint8Array,
  frame: Uint8Array,
  opts: { codec?: FrameCodec } = {}
): Promise<unknown> {
  if (frame.length < 1 + NONCE_LEN + TAG_LEN) {
    throw new PairCryptoError('frame too short');
  }
  const version = frame[0];
  if (version !== VERSION && version !== VERSION_V2) {
    throw new PairCryptoError(`unsupported frame version ${version}`);
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
  const plain = new Uint8Array(plaintext);
  if (version === VERSION) {
    try {
      return JSON.parse(decoder.decode(plain));
    } catch {
      throw new PairCryptoError('decrypt ok but payload is not valid JSON');
    }
  }
  if (plain.byteLength < 1) {
    throw new PairCryptoError('empty v2 payload');
  }
  const flags = plain[0];
  if ((flags & ~VALID_FLAGS_MASK) !== 0) {
    throw new PairCryptoError(`unsupported frame flags ${flags}`);
  }
  let body: Uint8Array = plain.subarray(1);
  if ((flags & FLAG_GZIP) !== 0) {
    const codec = opts.codec ?? defaultFrameCodec;
    try {
      body = await codec.gunzip(body);
    } catch (error) {
      if (error instanceof PairCryptoError) throw error;
      throw new PairCryptoError('decrypt ok but gzip decompression failed');
    }
  }
  if ((flags & FLAG_BINARY) !== 0) {
    return unpackBinaryEnvelope(body);
  }
  try {
    return JSON.parse(decoder.decode(body));
  } catch {
    throw new PairCryptoError('decrypt ok but payload is not valid JSON');
  }
}
