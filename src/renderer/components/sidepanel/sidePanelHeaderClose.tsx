import { MoreHorizontal, PanelRight, X } from 'lucide-react';
import { useI18n } from '@/i18n';

/**
 * 顶栏行右上角把 + 与全屏收纳进「…」，hover / 键盘聚焦 / 菜单撑开时才展开。
 * 触屏没有 hover（iOS 还会把首击当 hover 吞掉 click），pointer-coarse 下直接常显。
 */
export const SIDE_ACTIONS_EXTRA_CLASS =
  'hidden group-focus-within/side-actions:flex group-hover/side-actions:flex group-data-[expanded]/side-actions:flex pointer-coarse:flex';

/** 顶栏行右上角的收起按钮：平时是「…」，展开时换成面板图标；触屏始终是面板图标，点一次就收起 */
export function SidePanelCollapseButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="ml-1 flex h-8 w-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted"
      onClick={onClick}
      aria-label={t('Toggle side panel')}
      title={t('Toggle side panel')}
    >
      <MoreHorizontal
        aria-hidden
        className="h-4 w-4 group-focus-within/side-actions:hidden group-hover/side-actions:hidden group-data-[expanded]/side-actions:hidden pointer-coarse:hidden"
      />
      <PanelRight
        aria-hidden
        className="hidden h-4 w-4 group-focus-within/side-actions:block group-hover/side-actions:block group-data-[expanded]/side-actions:block pointer-coarse:block"
      />
    </button>
  );
}

/** 窄屏右侧面板全屏盖住工作区：标题行右端给一个明确的关闭入口 */
export function SidePanelCloseButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted"
      onClick={onClick}
      aria-label={t('Close side panel')}
      title={t('Close side panel')}
    >
      <X aria-hidden className="h-4 w-4" />
    </button>
  );
}
