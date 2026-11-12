import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ImageGenerationConfig, ImageGenItem } from '@shared/imageGeneration';
import type { ConfirmOutsideImage } from '../tools/sendImage';
import { isPublicAddress, validateFetchUrl } from '../tools/webFetch';
import { imageDownloadDispatcher } from './downloadDispatcher';
import { imageFetch } from './transport';

const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_RESPONSE = 280 * 1024 * 1024;
const RESERVED = new BlockList();
for (const [address, prefix] of [
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
] as const)
  RESERVED.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001:db8::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
] as const)
  RESERVED.addSubnet(address, prefix, 'ipv6');
function publicAddress(address: string): boolean {
  const family = isIP(address);
  return isPublicAddress(address) && !RESERVED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
export interface EngineDeps {
  cwd: string;
  remote?: boolean;
  homeDir?: string;
  confirmOutside: ConfirmOutsideImage;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  lookup?: (hostname: string) => Promise<string[]>;
}
export interface ImageArgs {
  prompt: string;
  count: number;
  referenceImages: string[];
}
type Picture = { bytes: Buffer; mimeType: string };
class ImageFailure extends Error {}
class HttpFailure extends Error {
  constructor(readonly status: number) {
    super('HTTP failure');
  }
}
const generated = new Map<
  string,
  Map<string, { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }>
>();

function mime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  throw new ImageFailure('Unsupported image format (expected PNG, JPEG or WebP)');
}
function decoded(value: unknown, declared?: unknown): Picture {
  // 嵌套重复的正则作用于 MB 级图片可能撑爆 V8 的 regexp 栈。
  // 下方的规范往返校验还会检查填充和未使用的比特位。
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(MAX_IMAGE / 3) * 4 ||
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(value)
  )
    throw new ImageFailure('Invalid or oversized Base64 image');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE || bytes.toString('base64') !== value)
    throw new ImageFailure('Invalid or oversized Base64 image');
  const mimeType = mime(bytes);
  if (declared !== undefined && declared !== mimeType)
    throw new ImageFailure('Image MIME type does not match its bytes');
  return { bytes, mimeType };
}
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
async function capped(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new ImageFailure('Image API response exceeds the size limit');
  }
  if (!response.body) throw new ImageFailure('Image API returned an empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new ImageFailure('Image API response exceeds the size limit');
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  return Buffer.concat(chunks);
}
async function download(input: string, deps: EngineDeps, signal: AbortSignal): Promise<Picture> {
  let url = validateFetchUrl(input);
  const lookup =
    deps.lookup ??
    (async (host: string) =>
      (await dnsLookup(host, { all: true, verbatim: true })).map((x) => x.address));
  for (let hop = 0; hop <= 5; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const addresses = isIP(host) ? [host] : await lookup(host);
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      !addresses.length ||
      !addresses.every(publicAddress)
    )
      throw new ImageFailure('Image download URL resolves to a non-public address');
    const agent = deps.fetch ? undefined : imageDownloadDispatcher(url, addresses);
    try {
      const init = { redirect: 'manual' as const, signal, ...(agent ? { dispatcher: agent } : {}) };
      const response = await (deps.fetch ?? imageFetch)(url.href, init);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location || hop === 5)
          throw new ImageFailure('Invalid or excessive image download redirects');
        url = validateFetchUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ImageFailure(`Image download HTTP ${response.status}`);
      }
      const bytes = await capped(response, MAX_IMAGE);
      const mimeType = mime(bytes);
      const declared = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (declared && declared !== mimeType && declared !== 'application/octet-stream')
        throw new ImageFailure('Downloaded image MIME type does not match its bytes');
      return { bytes, mimeType };
    } finally {
      await agent?.close();
    }
  }
  throw new ImageFailure('Too many image download redirects');
}
async function scratch(home: string, session: string, create = true): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new ImageFailure('Invalid session ID');
  let current = await realpath(home);
  for (const segment of ['.pi', 'scratch', session]) {
    current = path.join(current, segment);
    if (create) {
      await mkdir(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
    }
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory() || (await realpath(current)) !== current)
      throw new ImageFailure('Session scratch directory is not a safe local directory');
  }
  return current;
}
async function save(
  dir: string,
  picture: Picture,
  signal: AbortSignal,
  assertScratch: () => Promise<void>
): Promise<string> {
  const ext =
    picture.mimeType === 'image/png' ? 'png' : picture.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
  const file = path.join(dir, `imagegen-${randomUUID()}.${ext}`);
  let created = false;
  try {
    signal.throwIfAborted();
    await assertScratch();
    const handle = await open(file, 'wx', 0o600);
    created = true;
    try {
      const opened = await handle.stat();
      await assertScratch();
      await handle.writeFile(picture.bytes);
      signal.throwIfAborted();
      await assertScratch();
      const saved = await lstat(file);
      if (
        saved.isSymbolicLink() ||
        saved.dev !== opened.dev ||
        saved.ino !== opened.ino ||
        saved.size !== picture.bytes.length
      )
        throw new ImageFailure('Generated image changed while saving');
    } finally {
      await handle.close();
    }
    return file;
  } catch (error) {
    if (created) await unlink(file).catch(() => {});
    throw error;
  }
}

export async function generate(
  config: ImageGenerationConfig,
  args: ImageArgs,
  deps: EngineDeps,
  session: string,
  toolCallId: string,
  externalSignal?: AbortSignal
): Promise<{
  items: ImageGenItem[];
  diagnostics: string[];
  images: { type: 'image'; data: string; mimeType: string }[];
}> {
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  const items: ImageGenItem[] = [];
  const diagnostics: string[] = [];
  const images: { type: 'image'; data: string; mimeType: string }[] = [];
  try {
    signal.throwIfAborted();
    const home = deps.homeDir ?? homedir();
    const dir = await scratch(home, session);
    const originalDir = await lstat(dir);
    const assertScratch = async () => {
      await scratch(home, session, false);
      const current = await lstat(dir);
      if (
        current.dev !== originalDir.dev ||
        current.ino !== originalDir.ino ||
        current.birthtimeMs !== originalDir.birthtimeMs
      )
        throw new ImageFailure('Session scratch directory was replaced during generation');
    };
    const workspace =
      args.referenceImages.length && !deps.remote
        ? await realpath(deps.cwd).catch(() => null)
        : null;
    const refs: Picture[] = [];
    for (const input of args.referenceImages) {
      signal.throwIfAborted();
      const expanded =
        input === '~' || input.startsWith('~/') || input.startsWith('~\\')
          ? path.join(deps.homeDir ?? homedir(), input.slice(1))
          : input;
      const file = await realpath(path.resolve(deps.cwd, expanded));
      const info = await stat(file);
      const saved = generated.get(dir)?.get(file);
      const own =
        saved &&
        saved.dev === info.dev &&
        saved.ino === info.ino &&
        saved.size === info.size &&
        saved.mtimeMs === info.mtimeMs &&
        saved.ctimeMs === info.ctimeMs;
      if ((!workspace || !inside(workspace, file)) && !own) {
        try {
          await deps.confirmOutside(file, signal, toolCallId);
        } catch {
          signal.throwIfAborted();
          throw new ImageFailure('Reference image access was not approved');
        }
      }
      if (!info.isFile() || info.size > MAX_IMAGE)
        throw new ImageFailure('Reference image is not a regular file or exceeds 20 MiB');
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          opened.size !== info.size ||
          opened.mtimeMs !== info.mtimeMs ||
          opened.ctimeMs !== info.ctimeMs
        )
          throw new Error('Reference changed');
        const buffer = Buffer.alloc(info.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        if (offset !== info.size) throw new Error('Reference changed');
        const after = await handle.stat();
        if (
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs
        )
          throw new Error('Reference changed');
        bytes = buffer.subarray(0, offset);
      } finally {
        await handle.close();
      }
      if (bytes.length > MAX_IMAGE) throw new ImageFailure('Reference image exceeds 20 MiB');
      refs.push({ bytes, mimeType: mime(bytes) });
    }
    const base = config.baseUrl.replace(/\/+$/, '');
    const jsonRequest = async (url: string, init: RequestInit) => {
      const response = await (deps.fetch ?? imageFetch)(url, {
        ...init,
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new HttpFailure(response.status);
      }
      return JSON.parse((await capped(response, MAX_RESPONSE)).toString('utf8')) as any;
    };
    let openaiData: any[] = [];
    if (config.protocol !== 'gemini') {
      let body: BodyInit;
      let headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
      if (refs.length) {
        const form = new FormData();
        form.append('model', config.modelId);
        form.append('prompt', args.prompt);
        form.append('n', String(args.count));
        for (const ref of refs)
          form.append(
            'image[]',
            new Blob([new Uint8Array(ref.bytes)], { type: ref.mimeType }),
            `reference.${ref.mimeType.split('/')[1]}`
          );
        body = form;
      } else {
        body = JSON.stringify({ model: config.modelId, prompt: args.prompt, n: args.count });
        headers = { ...headers, 'content-type': 'application/json' };
      }
      const result = await jsonRequest(`${base}/images/${refs.length ? 'edits' : 'generations'}`, {
        method: 'POST',
        headers,
        body,
      });
      openaiData = Array.isArray(result.data) ? result.data : [];
    }
    for (let index = 1; index <= args.count; index++) {
      try {
        signal.throwIfAborted();
        let picture: Picture;
        if (config.protocol === 'gemini') {
          const parts = [
            { text: args.prompt },
            ...refs.map((ref) => ({
              inlineData: { mimeType: ref.mimeType, data: ref.bytes.toString('base64') },
            })),
          ];
          const result = await jsonRequest(
            `${base}/models/${encodeURIComponent(config.modelId)}:generateContent`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
              body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
              }),
            }
          );
          const part = result.candidates
            ?.flatMap((c: any) => c?.content?.parts ?? [])
            .find((p: any) => !p.thought && p.inlineData?.data);
          if (typeof part?.inlineData?.mimeType !== 'string')
            throw new ImageFailure(
              'Gemini returned no image; the response may be text-only or safety-blocked'
            );
          picture = decoded(part?.inlineData?.data, part?.inlineData?.mimeType);
        } else {
          const entry = openaiData[index - 1];
          if (entry?.b64_json) picture = decoded(entry.b64_json);
          else if (typeof entry?.url === 'string')
            picture = await download(entry.url, deps, signal);
          else
            throw new ImageFailure(
              'Image API returned fewer images than requested or an unsupported response'
            );
        }
        const file = await save(dir, picture, signal, assertScratch);
        if (!generated.has(dir)) generated.set(dir, new Map());
        const info = await stat(file);
        generated.get(dir)?.set(file, {
          dev: info.dev,
          ino: info.ino,
          size: info.size,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
        });
        items.push({ index, status: 'success', path: file, mimeType: picture.mimeType });
        images.push({
          type: 'image',
          data: picture.bytes.toString('base64'),
          mimeType: picture.mimeType,
        });
      } catch (error) {
        const status = signal.aborted ? 'cancelled' : 'error';
        items.push({ index, status, path: null, mimeType: null });
        diagnostics.push(
          `Image ${index}: ${status === 'cancelled' ? 'cancelled or timed out' : error instanceof HttpFailure ? `image API HTTP ${error.status}` : error instanceof ImageFailure ? error.message : 'generation or save failed'}`
        );
      }
    }
  } catch (error) {
    for (let index = items.length + 1; index <= args.count; index++)
      items.push({
        index,
        status: signal.aborted ? 'cancelled' : 'error',
        path: null,
        mimeType: null,
      });
    diagnostics.push(
      signal.aborted
        ? 'Cancelled or timed out'
        : error instanceof HttpFailure
          ? `Image API HTTP ${error.status}`
          : error instanceof ImageFailure
            ? error.message
            : 'Image generation failed'
    );
  }
  return { items, diagnostics, images };
}
