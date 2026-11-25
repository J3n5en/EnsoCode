import { projectIconUrl } from '@shared/localImage';
import { projectIconColor, projectIconInitial } from '@shared/projectIcon';
import { memo, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useProjectIconsStore } from '@/stores/projectIcons';

/**
 * 项目图标。扫描到或用户上传的 logo 用原图，不裁圆角（品牌保真）。
 * 没有图时用色块，圆角为 size×0.25；颜色按 projectId 取，改名不换色。
 */
export const ProjectIcon = memo(function ProjectIcon({
  projectId,
  displayName,
  size,
  className,
}: {
  projectId: string;
  displayName: string;
  size: number;
  className?: string;
}) {
  const info = useProjectIconsStore((state) => state.icons[projectId]);
  const ensure = useProjectIconsStore((state) => state.ensure);
  const imageKey = `${projectId}\0${info?.kind ?? ''}\0${info?.revision ?? ''}`;
  const [failedKey, setFailedKey] = useState('');
  useEffect(() => {
    ensure(projectId);
  }, [ensure, projectId]);

  const hasImage =
    (info?.kind === 'scanned' || info?.kind === 'custom') &&
    !!info.revision &&
    failedKey !== imageKey;

  if (hasImage && info) {
    return (
      <img
        data-enso="project-icon"
        data-kind="image"
        alt=""
        src={projectIconUrl(projectId, info.revision)}
        width={size}
        height={size}
        draggable={false}
        className={cn('shrink-0', className)}
        style={{ width: size, height: size, objectFit: 'contain' }}
        onError={() => setFailedKey(imageKey)}
      />
    );
  }

  return (
    <span
      data-enso="project-icon"
      data-kind="fallback"
      className={cn('inline-flex shrink-0 items-center justify-center font-medium', className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.25),
        backgroundColor: projectIconColor(projectId),
        color: '#fff',
        fontSize: Math.round(size * 0.5),
        lineHeight: 1,
      }}
    >
      {projectIconInitial(displayName)}
    </span>
  );
});
