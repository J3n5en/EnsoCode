import type {
  HostToPhone,
  PairBotArtifact,
  PairBotArtifactTarget,
  PairBotMedia,
  PhoneToHost,
} from '@enso/pair';
import { isMediaId, SEND_IMAGE_PER_REPLY } from '@shared/bots/sendImage';

type ArtifactsFrame = Extract<HostToPhone, { type: 'bot-artifacts' }>;
type ImageFrame = Extract<HostToPhone, { type: 'bot-artifact-image' }>;
export type ImageResult = { dataUrl: string } | { error: string };
export type ImageRef = { mediaId: string } | { rel: string };

export interface TurnArtifacts {
  artifacts: PairBotArtifact[];
  media: PairBotMedia[];
}

const KINDS = new Set(['image', 'markdown', 'html', 'pdf', 'text', 'other']);
const SOURCES = new Set(['file', 'web', 'desktop', 'upload']);
const IMAGE_TIMEOUT_MS = 30_000;

export const artifactKey = (target: PairBotArtifactTarget): string =>
  'entryId' in target
    ? `${target.chatId}|e|${target.entryId}`
    : `${target.chatId}|c|${target.conversationId}|${target.messageIndex}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const optional = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const isImageUrl = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|bmp|avif|x-icon);base64,/.test(value);

function artifactOf(value: unknown): PairBotArtifact | null {
  if (!isRecord(value)) return null;
  const { rel, name, size, kind } = value;
  return typeof rel === 'string' &&
    typeof name === 'string' &&
    typeof size === 'number' &&
    typeof kind === 'string' &&
    KINDS.has(kind)
    ? { rel, name, size, kind: kind as PairBotArtifact['kind'] }
    : null;
}

function mediaOf(value: unknown): PairBotMedia | null {
  if (!isRecord(value) || typeof value.source !== 'string' || !SOURCES.has(value.source))
    return null;
  const source = value.source as PairBotMedia['source'];
  const name = optional(value.name);
  const caption = optional(value.caption);
  const extra = { source, ...(name ? { name } : {}), ...(caption ? { caption } : {}) };
  if (value.ok === true && isMediaId(value.mediaId))
    return {
      ok: true,
      mediaId: value.mediaId,
      ...(isImageUrl(value.thumb) ? { thumb: value.thumb } : {}),
      ...extra,
    };
  if (value.ok === false && (value.error === 'too-large' || value.error === 'quota'))
    return { ok: false, error: value.error, ...extra };
  return null;
}

/** 手机端产物 / 发图缓存：按回复去重请求，大图按 requestId 对号入座 */
export class BotArtifactsPort {
  private readonly cache = new Map<string, TurnArtifacts>();
  private readonly inflight = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly images = new Map<string, (result: ImageResult) => void>();
  private seq = 0;

  constructor(private readonly send: (command: PhoneToHost) => unknown) {}

  get(target: PairBotArtifactTarget): TurnArtifacts | undefined {
    return this.cache.get(artifactKey(target));
  }

  /** 非空结果缓存；空结果（文件可能还没落盘）下次挂载再问 */
  request(target: PairBotArtifactTarget): void {
    const key = artifactKey(target);
    const hit = this.cache.get(key);
    if (this.inflight.has(key) || (hit && (hit.artifacts.length > 0 || hit.media.length > 0)))
      return;
    this.inflight.add(key);
    this.send({ type: 'bot-artifacts', target });
  }

  receive(frame: ArtifactsFrame): void {
    if (!isRecord(frame.target)) return;
    const key = artifactKey(frame.target);
    this.inflight.delete(key);
    const artifacts = (Array.isArray(frame.artifacts) ? frame.artifacts : [])
      .map(artifactOf)
      .filter((item): item is PairBotArtifact => item !== null);
    const seen = new Set<string>();
    const media = (Array.isArray(frame.media) ? frame.media : [])
      .map(mediaOf)
      .filter((item): item is PairBotMedia => {
        if (!item?.ok) return item !== null;
        if (seen.has(item.mediaId)) return false;
        seen.add(item.mediaId);
        return true;
      })
      .slice(0, SEND_IMAGE_PER_REPLY);
    this.cache.set(key, { artifacts, media });
    for (const listener of this.listeners) listener();
  }

  image(target: PairBotArtifactTarget, ref: ImageRef): Promise<ImageResult> {
    const requestId = `img-${Date.now().toString(36)}-${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.settle(requestId, { error: 'timeout' }),
        IMAGE_TIMEOUT_MS
      );
      this.images.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.send({ type: 'bot-artifact-image', requestId, target, ...ref });
    });
  }

  receiveImage(frame: ImageFrame): void {
    this.settle(
      frame.requestId,
      isImageUrl(frame.dataUrl) ? { dataUrl: frame.dataUrl } : { error: frame.error ?? 'invalid' }
    );
  }

  /** 断线：在途请求全部失败，下次挂载重新请求 */
  reset(): void {
    this.inflight.clear();
    for (const id of [...this.images.keys()]) this.settle(id, { error: 'offline' });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private settle(requestId: string, result: ImageResult): void {
    const done = this.images.get(requestId);
    if (!done) return;
    this.images.delete(requestId);
    done(result);
  }
}
