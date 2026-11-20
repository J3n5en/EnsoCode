import { useMemo, useState } from 'react';
import { useI18n } from '@/i18n';
import { formatBytes } from '@/lib/toolCards/render';
import { parseImageViewFacts, type ToolImage, toolImageSrc } from '@/lib/toolImage';
import { ZoomableImage } from './ZoomableImage';

/** 工具结果的缩略图：只在挂载（展开）时拼 data URL；没有图或加载失败显示文字，不出破图 */
export function ToolImagePreview({
  image,
  path,
  alt,
}: {
  image?: ToolImage;
  path?: string | null;
  alt?: string;
}) {
  const { t } = useI18n();
  const src = useMemo(() => toolImageSrc(image, path, true), [image, path]);
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <p data-slot="tool-image-missing" className="text-xs text-muted-foreground">
        {t('Image unavailable')}
      </p>
    );
  }
  return (
    <ZoomableImage
      src={src}
      alt={alt}
      lazy
      onError={() => setFailed(true)}
      frameClassName="block max-w-full"
      className="block max-h-64 max-w-full rounded-md border border-border/60 bg-muted/40 object-contain"
    />
  );
}

/** 普通会话 image_view 展开后的详情：缩略图 + 路径、像素尺寸、大小 */
export function ImageViewResult({ image, output }: { image?: ToolImage; output: string | null }) {
  const { t } = useI18n();
  const facts = useMemo(() => parseImageViewFacts(output), [output]);
  const rows: [string, string][] = [];
  if (facts?.path) rows.push([t('Path'), facts.path]);
  if (facts?.width && facts.height)
    rows.push([t('Dimensions'), `${facts.width} × ${facts.height}`]);
  if (facts?.size !== null && facts?.size !== undefined)
    rows.push([t('File size'), formatBytes(facts.size)]);
  return (
    <div data-slot="image-view" className="space-y-2 px-3 py-2">
      <ToolImagePreview image={image} path={facts?.path} alt={facts?.path ?? ''} />
      {rows.length > 0 ? (
        <dl className="space-y-0.5 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
