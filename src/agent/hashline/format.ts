const HL_FILE_PREFIX = '[';
const HL_FILE_SUFFIX = ']';
const HL_FILE_HASH_SEP = '#';
const HL_FILE_HASH_LENGTH = 4;

const XXH_P1 = 2654435761;
const XXH_P2 = 2246822519;
const XXH_P3 = 3266489917;
const XXH_P4 = 668265263;
const XXH_P5 = 374761393;

function u32(n: number): number {
  return n >>> 0;
}

function rotl(n: number, r: number): number {
  return u32((n << r) | (n >>> (32 - r)));
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function xxHash32(input: string, seed = 0): number {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  let h: number;
  let i = 0;
  if (len >= 16) {
    let v1 = u32(seed + XXH_P1 + XXH_P2);
    let v2 = u32(seed + XXH_P2);
    let v3 = u32(seed);
    let v4 = u32(seed - XXH_P1);
    const limit = len - 16;
    while (i <= limit) {
      v1 = u32(rotl(u32(v1 + u32(readU32LE(bytes, i) * XXH_P2)), 13) * XXH_P1);
      v2 = u32(rotl(u32(v2 + u32(readU32LE(bytes, i + 4) * XXH_P2)), 13) * XXH_P1);
      v3 = u32(rotl(u32(v3 + u32(readU32LE(bytes, i + 8) * XXH_P2)), 13) * XXH_P1);
      v4 = u32(rotl(u32(v4 + u32(readU32LE(bytes, i + 12) * XXH_P2)), 13) * XXH_P1);
      i += 16;
    }
    h = u32(rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18));
  } else {
    h = u32(seed + XXH_P5);
  }
  h = u32(h + len);
  while (i + 4 <= len) {
    h = u32(rotl(u32(h + u32(readU32LE(bytes, i) * XXH_P3)), 17) * XXH_P4);
    i += 4;
  }
  while (i < len) {
    h = u32(rotl(u32(h + u32(bytes[i]! * XXH_P5)), 11) * XXH_P1);
    i += 1;
  }
  h = u32(h ^ (h >>> 15));
  h = u32(h * XXH_P2);
  h = u32(h ^ (h >>> 13));
  h = u32(h * XXH_P3);
  return u32(h ^ (h >>> 16));
}

function normalizeFileHashText(text: string): string {
  return text.replace(/[ \t\r]+(?=\n|$)/g, '');
}

export function computeFileHash(text: string): string {
  const low16 = xxHash32(normalizeFileHashText(text), 0) & 0xffff;
  return low16.toString(16).padStart(HL_FILE_HASH_LENGTH, '0').toUpperCase();
}

export function formatHashlineHeader(filePath: string, fileHash: string): string {
  return `${HL_FILE_PREFIX}${filePath}${HL_FILE_HASH_SEP}${fileHash}${HL_FILE_SUFFIX}`;
}
