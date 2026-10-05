import type { BotMediaItem } from '@shared/bots/sendImage';
import type {
  BotArtifact,
  BotArtifactOpenAction,
  BotArtifactReadResult,
  BotArtifactTarget,
} from '@shared/types/botIpc';
import { ExternalLink, FolderOpen, ImageOff, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/chat/Markdown';
import { ReadFileView } from '@/components/chat/ReadFileView';
import { fileTypeIcon, fileTypeIconClass } from '@/components/sidepanel/fileIcons';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface TurnArtifacts {
  artifacts: BotArtifact[];
  media: BotMediaItem[];
}
const EMPTY: TurnArtifacts = { artifacts: [], media: [] };

/** 只缓存非空结果：轮次刚结束时文件可能还没落盘，空结果下次挂载再问 */
const cache = new Map<string, TurnArtifacts>();
/** send_image 缩略图（内容哈希命名，不会变） */
const thumbs = new Map<string, string>();
const PREVIEWABLE = new Set<BotArtifact['kind']>(['image', 'markdown', 'html', 'text']);

const sizeText = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;

function useArtifacts(target: BotArtifactTarget): TurnArtifacts {
  const key = JSON.stringify(target);
  const [artifacts, setArtifacts] = useState<TurnArtifacts>(() => cache.get(key) ?? EMPTY);
  useEffect(() => {
    if (cache.has(key)) return;
    let alive = true;
    void window.electronAPI.bots.artifacts
      .list(JSON.parse(key) as BotArtifactTarget)
      .then((result) => {
        if (!alive || !result.ok) return;
        const found = { artifacts: result.artifacts, media: result.media ?? [] };
        if (found.artifacts.length > 0 || found.media.length > 0) cache.set(key, found);
        setArtifacts(found);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]);
  return artifacts;
}

function useOpenArtifact(target: BotArtifactTarget) {
  const { t } = useI18n();
  return (artifact: BotArtifact, action: BotArtifactOpenAction) =>
    void window.electronAPI.bots.artifacts
      .open({ ...target, rel: artifact.rel, action })
      .then((result) => {
        if (result.ok) return;
        addToast({
          type: 'error',
          title:
            result.error === 'not-openable'
              ? t('This file type is only shown in Finder')
              : t('Could not open the file'),
        });
      });
}

/** 该轮产生或提到、且位于聊天工作区内的文件；路径由 Main 推导，这里只传标识 */
export function ArtifactCards({ target }: { target: BotArtifactTarget }) {
  const { artifacts, media } = useArtifacts(target);
  return (
    <>
      {media.length > 0 && <MediaStrip target={target} media={media} />}
      {artifacts.length > 0 && <FileCards target={target} artifacts={artifacts} />}
    </>
  );
}

function useMediaLabel() {
  const { t } = useI18n();
  return ({ source, name }: BotMediaItem) =>
    source === 'upload'
      ? ''
      : source === 'web'
        ? t('Web screenshot')
        : source === 'desktop'
          ? t('Desktop screenshot')
          : name && /^(?:\/|[A-Za-z]:[\\/])/.test(name)
            ? t('This computer')
            : t('Workspace image');
}

function useMediaImage(
  target: BotArtifactTarget,
  mediaId: string | null,
  variant: 'thumb' | 'full'
): BotArtifactReadResult | null {
  const key = JSON.stringify(target);
  const cached = mediaId && variant === 'thumb' ? thumbs.get(mediaId) : undefined;
  const [content, setContent] = useState<BotArtifactReadResult | null>(
    cached ? { ok: true, kind: 'image', dataUrl: cached } : null
  );
  useEffect(() => {
    const hit = mediaId && variant === 'thumb' ? thumbs.get(mediaId) : undefined;
    setContent(hit ? { ok: true, kind: 'image', dataUrl: hit } : null);
    if (!mediaId || hit) return;
    let alive = true;
    void window.electronAPI.bots.artifacts
      .read({ ...(JSON.parse(key) as BotArtifactTarget), mediaId, variant })
      .then((result) => {
        if (variant === 'thumb' && result.ok && result.kind === 'image')
          thumbs.set(mediaId, result.dataUrl);
        if (alive) setContent(result);
      })
      .catch(() => alive && setContent({ ok: false, error: 'unavailable' }));
    return () => {
      alive = false;
    };
  }, [key, mediaId, variant]);
  return content;
}

type SentMedia = Extract<BotMediaItem, { ok: true }>;

/** send_image 发出的图：缩略图 + 来源标签，点开看大图；失败项只显示原因 */
function MediaStrip({ target, media }: { target: BotArtifactTarget; media: BotMediaItem[] }) {
  const { t } = useI18n();
  const label = useMediaLabel();
  const [preview, setPreview] = useState<SentMedia | null>(null);
  const desktop = media.some((item) => item.ok && item.source === 'desktop');
  return (
    <div className="mt-2" data-bot-media="">
      <div className="flex flex-wrap gap-1.5">
        {media.map((item, index) =>
          item.ok ? (
            <MediaThumb
              key={item.mediaId}
              target={target}
              item={item}
              label={label(item)}
              onOpen={() => setPreview(item)}
            />
          ) : (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 失败项没有 mediaId，顺序即身份
              key={`failed-${index}`}
              className="flex w-40 flex-col gap-1 rounded-lg border border-destructive/60 border-dashed p-2 text-destructive text-xs"
            >
              <span className="flex items-center gap-1 font-medium">
                <ImageOff className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{item.name ?? label(item)}</span>
              </span>
              <span>
                {item.error === 'quota'
                  ? t('Chat image storage is full (200 MiB); not saved')
                  : t('Not sent: still over 10 MiB after compression')}
              </span>
            </div>
          )
        )}
      </div>
      {desktop && (
        <p className="mt-1 text-warning text-xs">
          {t('Desktop screenshots may capture sensitive content from other windows.')}
        </p>
      )}
      <MediaPreviewDialog
        target={target}
        item={preview}
        label={preview ? label(preview) : ''}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}

function MediaThumb({
  target,
  item,
  label,
  onOpen,
}: {
  target: BotArtifactTarget;
  item: SentMedia;
  label: string;
  onOpen: () => void;
}) {
  const content = useMediaImage(target, item.mediaId, 'thumb');
  const title = item.caption ?? item.name ?? label;
  return (
    <button
      type="button"
      title={title}
      onClick={onOpen}
      className="relative h-24 w-36 overflow-hidden rounded-lg border bg-muted"
    >
      {content?.ok && content.kind === 'image' ? (
        <img src={content.dataUrl} alt={title} className="h-full w-full object-cover" />
      ) : content ? (
        <ImageOff className="m-auto h-4 w-4 text-muted-foreground" />
      ) : (
        <Loader2 className="m-auto h-4 w-4 animate-spin text-muted-foreground" />
      )}
      {label && (
        <span
          className={cn(
            'absolute top-1 left-1 rounded px-1 text-[10px] leading-4',
            item.source === 'desktop'
              ? 'bg-warning text-warning-foreground'
              : 'bg-black/60 text-white'
          )}
        >
          {label}
        </span>
      )}
      {(item.caption || item.name) && (
        <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1.5 pt-3 pb-0.5 text-left text-[10px] text-white">
          {item.caption ?? item.name}
        </span>
      )}
    </button>
  );
}

function MediaPreviewDialog({
  target,
  item,
  label,
  onClose,
}: {
  target: BotArtifactTarget;
  item: SentMedia | null;
  label: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const content = useMediaImage(target, item?.mediaId ?? null, 'full');
  const title = item?.caption ?? item?.name ?? label;
  return (
    <Dialog open={item !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
            <span className="truncate">{title}</span>
            <span className="shrink-0 font-normal text-muted-foreground text-xs">{label}</span>
          </DialogTitle>
        </DialogHeader>
        {item?.source === 'desktop' && (
          <p className="text-warning text-xs">
            {t('Desktop screenshots may capture sensitive content from other windows.')}
          </p>
        )}
        {item?.source === 'file' && (
          <p className="text-muted-foreground text-xs">
            {t(
              'Copied into this chat: later edits or deletion of the original do not change it. Deleted together with the chat.'
            )}
          </p>
        )}
        <PreviewBody name={title} content={content} />
      </DialogContent>
    </Dialog>
  );
}

function FileCards({ target, artifacts }: { target: BotArtifactTarget; artifacts: BotArtifact[] }) {
  const { t } = useI18n();
  const open = useOpenArtifact(target);
  const [preview, setPreview] = useState<BotArtifact | null>(null);
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" data-bot-artifacts="">
      {artifacts.map((artifact) => {
        const Icon = fileTypeIcon(artifact.name, false);
        const canPreview = PREVIEWABLE.has(artifact.kind) || artifact.kind === 'pdf';
        return (
          <div
            key={artifact.rel}
            className="group/artifact flex max-w-64 items-center gap-1 rounded-lg border bg-card py-1 pr-1 pl-2 text-xs"
          >
            <button
              type="button"
              title={artifact.rel}
              disabled={!canPreview}
              onClick={() =>
                artifact.kind === 'pdf' ? open(artifact, 'preview') : setPreview(artifact)
              }
              className="flex min-w-0 items-center gap-1.5 text-left enabled:hover:underline disabled:cursor-default"
            >
              <Icon
                className={cn('h-3.5 w-3.5 shrink-0', fileTypeIconClass(artifact.name, false))}
              />
              <span className="truncate">{artifact.name}</span>
              <span className="shrink-0 text-muted-foreground">{sizeText(artifact.size)}</span>
            </button>
            <button
              type="button"
              title={t('Show in Finder')}
              onClick={() => open(artifact, 'reveal')}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title={t('Open with default app')}
              onClick={() => open(artifact, 'open')}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <ArtifactPreviewDialog
        target={target}
        artifact={preview}
        onOpen={open}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}

function ArtifactPreviewDialog({
  target,
  artifact,
  onOpen,
  onClose,
}: {
  target: BotArtifactTarget;
  artifact: BotArtifact | null;
  onOpen: (artifact: BotArtifact, action: BotArtifactOpenAction) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [content, setContent] = useState<BotArtifactReadResult | null>(null);
  const rel = artifact?.rel;
  const key = JSON.stringify(target);
  useEffect(() => {
    setContent(null);
    if (!rel) return;
    let alive = true;
    void window.electronAPI.bots.artifacts
      .read({ ...(JSON.parse(key) as BotArtifactTarget), rel })
      .then((result) => alive && setContent(result))
      .catch(() => alive && setContent({ ok: false, error: 'unavailable' }));
    return () => {
      alive = false;
    };
  }, [key, rel]);

  return (
    <Dialog open={artifact !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
            <span className="truncate">{artifact?.name}</span>
            <span className="truncate font-normal text-muted-foreground text-xs">
              {artifact?.rel}
            </span>
            <span className="flex-1" />
            {artifact && (
              <>
                <button
                  type="button"
                  title={t('Show in Finder')}
                  onClick={() => onOpen(artifact, 'reveal')}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <FolderOpen className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title={t('Open with default app')}
                  onClick={() => onOpen(artifact, 'open')}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <ExternalLink className="h-4 w-4" />
                </button>
              </>
            )}
          </DialogTitle>
        </DialogHeader>
        <PreviewBody name={artifact?.name ?? ''} content={content} />
      </DialogContent>
    </Dialog>
  );
}

/** 预览正文：整宽滚动区（图片 / Markdown / 沙箱 HTML / 纯文本） */
function PreviewBody({ name, content }: { name: string; content: BotArtifactReadResult | null }) {
  const { t } = useI18n();
  return (
    <div className="min-h-0 flex-1 select-text overflow-auto border-t" data-bot-artifact-preview="">
      {!content && (
        <div className="flex justify-center p-6 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}
      {content && !content.ok && (
        <p className="p-6 text-muted-foreground text-sm">
          {content.error === 'too-large'
            ? t('The file is too large to preview')
            : t('Could not open the file')}
        </p>
      )}
      {content?.ok && content.kind === 'image' && (
        <img
          src={content.dataUrl}
          alt={name}
          className="mx-auto max-h-full max-w-full object-contain p-4"
        />
      )}
      {content?.ok && content.kind === 'markdown' && (
        <div className="px-6 py-4 text-sm">
          <Markdown text={content.text} />
        </div>
      )}
      {content?.ok && content.kind === 'html' && (
        // 不给 allow-scripts / allow-same-origin：脚本不执行，也拿不到宿主
        <iframe title={name} sandbox="" srcDoc={content.text} className="h-full w-full bg-white" />
      )}
      {content?.ok && content.kind === 'text' && (
        <div className="p-2 text-xs">
          <ReadFileView path={name} contents={content.text} />
        </div>
      )}
    </div>
  );
}
