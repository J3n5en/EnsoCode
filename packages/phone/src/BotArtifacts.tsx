import type { PairBotArtifact, PairBotArtifactTarget, PairBotMedia } from '@enso/pair';
import { FileText, ImageOff, Loader2, X } from 'lucide-react';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import {
  artifactKey,
  type BotArtifactsPort,
  type ImageRef,
  type ImageResult,
} from './botArtifactsPort';

export const BotArtifactsContext = createContext<{
  port: BotArtifactsPort;
  online: boolean;
} | null>(null);

const LABEL: Record<PairBotMedia['source'], string> = {
  web: '网页截图',
  desktop: '桌面截图',
  file: '工作区',
  upload: '',
};

const sizeText = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;

interface Preview {
  ref: ImageRef;
  title: string;
  source?: PairBotMedia['source'];
  thumb?: string;
}

/** 一条回复的 send_image 图 + 产物卡片：缩略图走中继，点开再拉 ≤700KB 大图 */
export function BotArtifacts({ target }: { target: PairBotArtifactTarget }) {
  const context = useContext(BotArtifactsContext);
  const key = artifactKey(target);
  const port = context?.port;
  const found = useSyncExternalStore(
    (listener) => port?.subscribe(listener) ?? (() => {}),
    () => port?.get(target)
  );
  const online = context?.online ?? false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 是 target 的稳定身份
  useEffect(() => {
    if (online) port?.request(target);
  }, [port, key, online]);
  const [preview, setPreview] = useState<Preview | null>(null);
  if (!port || !found || (found.media.length === 0 && found.artifacts.length === 0)) return null;
  const desktop = found.media.some((item) => item.ok && item.source === 'desktop');
  return (
    <div className="mt-1.5">
      {found.media.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {found.media.map((item, index) =>
            item.ok ? (
              <button
                key={item.mediaId}
                type="button"
                onClick={() =>
                  setPreview({
                    ref: { mediaId: item.mediaId },
                    title: item.caption ?? item.name ?? LABEL[item.source],
                    source: item.source,
                    thumb: item.thumb,
                  })
                }
                className="relative h-20 w-28 overflow-hidden rounded-lg border bg-muted"
              >
                {item.thumb ? (
                  <img src={item.thumb} alt="" className="h-full w-full object-cover" />
                ) : (
                  <ImageOff className="m-auto h-4 w-4 text-muted-foreground" />
                )}
                {LABEL[item.source] && (
                  <span
                    className={cn(
                      'absolute top-1 left-1 rounded px-1 text-[10px] leading-4',
                      item.source === 'desktop'
                        ? 'bg-warning text-warning-foreground'
                        : 'bg-black/60 text-white'
                    )}
                  >
                    {LABEL[item.source]}
                  </span>
                )}
                {(item.caption || item.name) && (
                  <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1.5 pt-3 pb-0.5 text-left text-[10px] text-white">
                    {item.caption ?? item.name}
                  </span>
                )}
              </button>
            ) : (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: 失败项没有 mediaId，顺序即身份
                key={`failed-${index}`}
                className="flex w-32 flex-col gap-0.5 rounded-lg border border-destructive/60 border-dashed p-2 text-destructive text-xs"
              >
                <span className="truncate font-medium">{item.name ?? LABEL[item.source]}</span>
                <span>
                  {item.error === 'quota'
                    ? '群图片空间已满，没收下'
                    : '压缩后仍超过 10MiB，没发出去'}
                </span>
              </div>
            )
          )}
        </div>
      )}
      {desktop && (
        <p className="mt-1 text-warning text-xs">桌面截图可能拍到别的窗口里的敏感内容。</p>
      )}
      {found.artifacts.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {found.artifacts.map((artifact) => (
            <ArtifactChip
              key={artifact.rel}
              artifact={artifact}
              onOpen={() => setPreview({ ref: { rel: artifact.rel }, title: artifact.name })}
            />
          ))}
        </div>
      )}
      {preview && (
        <ImagePreview
          preview={preview}
          load={() => port.image(target, preview.ref)}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function ArtifactChip({ artifact, onOpen }: { artifact: PairBotArtifact; onOpen: () => void }) {
  const image = artifact.kind === 'image';
  return (
    <button
      type="button"
      disabled={!image}
      onClick={onOpen}
      title={artifact.rel}
      className="flex max-w-60 items-center gap-1.5 rounded-lg border bg-card px-2 py-1 text-left text-xs disabled:cursor-default"
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{artifact.name}</span>
      <span className="shrink-0 text-muted-foreground">{sizeText(artifact.size)}</span>
    </button>
  );
}

function ImagePreview({
  preview,
  load,
  onClose,
}: {
  preview: Preview;
  load: () => Promise<ImageResult>;
  onClose: () => void;
}) {
  const [result, setResult] = useState<ImageResult | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 打开一次拉一次
  useEffect(() => {
    let alive = true;
    void load().then((next) => alive && setResult(next));
    return () => {
      alive = false;
    };
  }, []);
  const src = result && 'dataUrl' in result ? result.dataUrl : preview.thumb;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white">
      <div className="flex items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),0.75rem)] pb-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{preview.title}</span>
        {preview.source && (
          <span className="shrink-0 text-white/70 text-xs">{LABEL[preview.source]}</span>
        )}
        <button type="button" onClick={onClose} aria-label="关闭" className="rounded p-1.5">
          <X className="h-5 w-5" />
        </button>
      </div>
      {preview.source === 'desktop' && (
        <p className="px-3 text-warning text-xs">这是整桌面截图，可能拍到其他窗口里的敏感内容。</p>
      )}
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-3">
        {src && (
          <img src={src} alt={preview.title} className="max-h-full max-w-full object-contain" />
        )}
        {!result && <Loader2 className="absolute h-5 w-5 animate-spin" />}
        {result && 'error' in result && (
          <p className="absolute bottom-4 rounded bg-black/70 px-2 py-1 text-xs">
            {result.error === 'too-large' ? '图片太大，手机上看不了' : '大图没拉下来'}
          </p>
        )}
      </div>
    </div>
  );
}
