import { Check, Earth } from 'lucide-react';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { useI18n } from '@/i18n';

/** 标签右键「在所有会话中显示」：不预留勾位，勾选后勾放右侧，与选择器类菜单一致 */
export function ShowEverywhereItem({
  checked,
  onClick,
}: {
  checked: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <ContextMenuItem
      data-enso="side-tab-show-everywhere"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
    >
      <span className="min-w-0 flex-1">{t('Show in all sessions')}</span>
      {checked ? <Check className="size-3.5 text-primary" /> : null}
    </ContextMenuItem>
  );
}

/** 标签标题；全局常驻面板在旁边带标记，窄宽度先截断标题、标记不收缩 */
export function SideTabTitle({ title, global }: { title: string; global: boolean }) {
  const { t } = useI18n();
  const label = t('Show in all sessions');
  return (
    <>
      <span className="min-w-0 max-w-32 truncate">{title}</span>
      {global ? (
        <span
          data-enso="side-tab-global"
          role="img"
          aria-label={label}
          title={label}
          className="shrink-0 text-primary"
        >
          <Earth className="h-3 w-3" />
        </span>
      ) : null}
    </>
  );
}
