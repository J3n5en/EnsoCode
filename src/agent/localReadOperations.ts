import { constants } from 'node:fs';
import { access, open, readFile } from 'node:fs/promises';
import {
  detectSupportedImageMimeTypeFromFile,
  type ReadOperations,
} from '@earendil-works/pi-coding-agent';

/**
 * 逐行照抄 pi 1.5.1 dist/core/tools/read.js 的 defaultReadOperations，只多一处建流前的同步检查：
 * pi 在 access 之后到建流之间不再检查 signal，
 * 中止落在这段 await 里时，已 abort 的 signal 会交给 FileHandle.createReadStream（autoClose:false），
 * Node 会在迭代器已拒绝之后再派发一次无人监听的 error 事件，变成整个 worker 的 uncaughtException。
 * 升级 pi 时重新比对；pi 自己在建流前检查 signal 后删掉本文件。
 */
async function* readLocalFileChunks(
  file: string,
  { signal }: { signal?: AbortSignal }
): AsyncGenerator<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const stats = await handle.stat();
    const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
    signal?.throwIfAborted();
    yield* handle.createReadStream({ end, signal, autoClose: false });
  } finally {
    await handle.close();
  }
}

export const localReadOperations: ReadOperations = {
  readFile: (file) => readFile(file),
  access: (file) => access(file, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
  createReadStream: readLocalFileChunks,
};
