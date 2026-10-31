import { open, rm } from 'node:fs/promises';
import { parsePluginInstallUrl } from '@shared/extensionPlugins/installUrl';

export { parsePluginInstallUrl } from '@shared/extensionPlugins/installUrl';

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ArchiveResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export type ArchiveFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: 'manual' }
) => Promise<ArchiveResponse>;

export interface DownloadPluginOptions {
  fetch: ArchiveFetch;
  maxBytes: number;
  timeoutMs?: number;
}

const isTimeout = (error: unknown) =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

async function writeBody(
  body: ReadableStream<Uint8Array> | null,
  dest: string,
  maxBytes: number
): Promise<void> {
  if (!body) throw new Error('下载没有内容');
  const file = await open(dest, 'w');
  const reader = body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error('插件过大');
      await file.write(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    await file.close();
  }
  if (received === 0) throw new Error('下载没有内容');
}

/** 下载插件 zip。只跟随仍是 http(s) 的重定向，超过大小上限即停并删除半截文件 */
export async function downloadPluginArchive(
  url: URL,
  dest: string,
  options: DownloadPluginOptions
): Promise<void> {
  let current = url;
  try {
    for (let redirects = 0; ; redirects++) {
      const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const response = await options.fetch(current.href, { signal, redirect: 'manual' });
      if (REDIRECT.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        if (redirects >= MAX_REDIRECTS) throw new Error('重定向过多');
        const location = response.headers.get('location');
        if (!location) throw new Error('重定向地址不合法');
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new Error('重定向地址不合法');
        }
        const parsed = parsePluginInstallUrl(next.href);
        if (!parsed.ok) throw new Error('重定向地址不合法');
        current = parsed.url;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`下载失败（HTTP ${response.status}）`);
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > options.maxBytes) throw new Error('插件过大');
      await writeBody(response.body, dest, options.maxBytes);
      return;
    }
  } catch (error) {
    await rm(dest, { force: true });
    if (isTimeout(error)) throw new Error('下载超时');
    if (error instanceof Error && isArchiveError(error.message)) throw error;
    throw new Error('无法下载插件');
  }
}

function isArchiveError(message: string): boolean {
  return (
    message === '插件过大' ||
    message === '重定向过多' ||
    message === '重定向地址不合法' ||
    message === '下载没有内容' ||
    message.startsWith('下载失败（HTTP ')
  );
}
