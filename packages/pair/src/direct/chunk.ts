/**
 * DataChannel 分片：浏览器间单消息安全上限约 64KB～256KB，而中继允许 1MB 帧。
 * 通道 ordered + reliable，故只需 1 字节头：0x00 = 还有后续片，0x01 = 末片。
 */

export const CHUNK_PAYLOAD_BYTES = 16_384;
/** 与中继 MAX_FRAME_BYTES 对齐 */
export const MAX_REASSEMBLED_BYTES = 1_048_576;

const MORE = 0x00;
const LAST = 0x01;

export function encodeChunks(frame: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  do {
    const end = Math.min(frame.byteLength, offset + CHUNK_PAYLOAD_BYTES);
    const chunk = new Uint8Array(1 + end - offset);
    chunk[0] = end >= frame.byteLength ? LAST : MORE;
    chunk.set(frame.subarray(offset, end), 1);
    out.push(chunk);
    offset = end;
  } while (offset < frame.byteLength);
  return out;
}

export interface Reassembler {
  /** 喂一片；拼完整帧时返回该帧，否则 null。非法头或超限 → 丢弃当前帧并跳过其余片。 */
  push(chunk: Uint8Array): Uint8Array | null;
}

export function createReassembler(): Reassembler {
  let parts: Uint8Array[] = [];
  let size = 0;
  let skipping = false;
  const reset = (): void => {
    parts = [];
    size = 0;
  };
  return {
    push(chunk) {
      const flag = chunk[0];
      if (flag !== MORE && flag !== LAST) {
        reset();
        skipping = false;
        return null;
      }
      if (skipping) {
        if (flag === LAST) skipping = false;
        return null;
      }
      const payload = chunk.subarray(1);
      size += payload.byteLength;
      if (size > MAX_REASSEMBLED_BYTES) {
        reset();
        skipping = flag === MORE;
        return null;
      }
      parts.push(payload);
      if (flag === MORE) return null;
      const frame = new Uint8Array(size);
      let offset = 0;
      for (const p of parts) {
        frame.set(p, offset);
        offset += p.byteLength;
      }
      reset();
      return frame;
    },
  };
}
