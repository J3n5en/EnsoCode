import type { ComposerToolbarItemId } from '@shared/composerToolbar';
import type { ReactNode } from 'react';
import { useSettingsStore } from '@/stores/settings';
import { ComposerToolbarOverflow } from './ComposerToolbarOverflow';

/**
 * 工具行按钮编排：pinned 的按 order 顺序直接渲染在工具行，其余折叠进「更多」popover。
 * 按钮本体（PresetPicker 等）由调用方按 id 建好传入——它们各自耦合会话状态，这里只管 pin/排序。
 */
export function ComposerToolbarItems({
  items,
}: {
  items: Record<ComposerToolbarItemId, ReactNode>;
}) {
  const composerToolbar = useSettingsStore((state) => state.composerToolbar);
  return (
    <>
      {composerToolbar.order
        .filter((id) => composerToolbar.pinned.includes(id))
        .map((id) => (
          <span key={id} className="contents">
            {items[id]}
          </span>
        ))}
      <ComposerToolbarOverflow renderItem={(id) => items[id]} />
    </>
  );
}
