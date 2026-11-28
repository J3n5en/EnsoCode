import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { type FrameCodec, MAX_DECOMPRESSED_BYTES, PairCryptoError } from '@enso/pair';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Electron Main 使用 node:zlib 作为 v2 加密帧与分片的编解码器，限制解压上限防内存放大攻击 */
export const nodeFrameCodec: FrameCodec = {
  async gzip(data) {
    return new Uint8Array(await gzipAsync(data));
  },
  async gunzip(data) {
    try {
      return new Uint8Array(await gunzipAsync(data, { maxOutputLength: MAX_DECOMPRESSED_BYTES }));
    } catch {
      throw new PairCryptoError('gzip decompression failed');
    }
  },
};
