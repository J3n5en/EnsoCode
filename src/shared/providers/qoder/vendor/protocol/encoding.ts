const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";

const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const encodeTable = new Uint8Array(256);

for (let i = 0; i < encodeTable.length; i++) {
  encodeTable[i] = i;
}

for (let i = 0; i < qoderStdAlphabet.length; i++) {
  encodeTable[qoderStdAlphabet.charCodeAt(i)] = qoderCustomAlphabet.charCodeAt(i);
}

// Qoder uses "$" instead of standard Base64 "=" padding.
encodeTable["=".charCodeAt(0)] = "$".charCodeAt(0);

const decodeTable = new Uint8Array(256);

for (let i = 0; i < decodeTable.length; i++) {
  decodeTable[i] = i;
}

for (let i = 0; i < qoderStdAlphabet.length; i++) {
  decodeTable[qoderCustomAlphabet.charCodeAt(i)] = qoderStdAlphabet.charCodeAt(i);
}

decodeTable["$".charCodeAt(0)] = "=".charCodeAt(0);

/**
 * Encode a request body with Qoder's custom Base64 alphabet and block reorder.
 * Returns a Buffer of ASCII bytes identical to the previous string encoding.
 */
export function qoderEncodeBody(plaintext: string | Buffer): Buffer {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");

  const n = std.length;
  const a = Math.floor(n / 3);

  const out = Buffer.allocUnsafe(n);
  let dst = 0;

  // Equivalent to:
  // std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a)
  //
  // Translate directly into the output buffer via charCodeAt to avoid an
  // intermediate Buffer.from(std, "ascii") copy of the base64 string.
  for (let i = n - a; i < n; i++) {
    out[dst++] = encodeTable[std.charCodeAt(i)];
  }

  for (let i = a; i < n - a; i++) {
    out[dst++] = encodeTable[std.charCodeAt(i)];
  }

  for (let i = 0; i < a; i++) {
    out[dst++] = encodeTable[std.charCodeAt(i)];
  }

  return out;
}

/**
 * Decode a response body produced by Qoder's custom Base64 alphabet and block
 * reorder (`qoderEncodeBody`). The gateway uses the same scheme for a few
 * control-plane responses, e.g. `region/endpoints`, which is otherwise opaque.
 */
export function qoderDecodeBody(encoded: string | Buffer): string {
  const src = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded, "ascii");
  const n = src.length;
  if (n === 0) return "";

  const a = Math.floor(n / 3);
  const std = Buffer.allocUnsafe(n);

  // Inverse of `tail + middle + head`: put the tail block back at the end, the
  // middle block in place, and the head block at the start.
  for (let i = 0; i < a; i++) {
    std[n - a + i] = decodeTable[src[i]];
  }

  for (let i = a; i < n - a; i++) {
    std[i] = decodeTable[src[i]];
  }

  for (let i = n - a; i < n; i++) {
    std[i - (n - a)] = decodeTable[src[i]];
  }

  return Buffer.from(std.toString("latin1"), "base64").toString("utf8");
}
