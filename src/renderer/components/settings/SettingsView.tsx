import * as React from 'react';
import { useI18n } from '@/i18n';
import { escapeBlockedBeforeHandlers, shouldEscapeCloseSettings } from '@/lib/settingsEscape';
import { cn } from '@/lib/utils';
import {
  closeSettings,
  setSettingsCategory,
  setSettingsMobileDetail,
  useAppViewStore,
} from '@/stores/appView';
import { showLocalCodeView } from '@/stores/bots/mode';
import { useSessionsStore } from '@/stores/sessions';
import { workbenchActivity } from '@/stores/sessions/pinned';
import { selectSidebarConversations } from '@/stores/sessions/sidebarDirectory';
import { type EmbeddedSettings, SettingsContent } from './SettingsContent';

/** 设置页导航底部：后台还有会话在跑 / 等你处理，点它回到工作区并打开第一个等你处理的会话 */
function WorkbenchActivityStrip() {
  const { t } = useI18n();
  // 拼成字符串比较，会话流式更新时不重渲染
  const key = useSessionsStore((state) => {
    const activity = workbenchActivity(
      state.order,
      selectSidebarConversations(state.conversations)
    );
    return `${activity.running}\n${activity.waitingIds.join('\n')}`;
  });
  const [runningText, ...waitingIds] = key.split('\n').filter((part, i) => i === 0 || part);
  const running = Number(runningText);
  if (running === 0 && waitingIds.length === 0) return null;
  const parts = [
    running > 0 ? t('{{n}} sessions running', { n: running }) : null,
    waitingIds.length > 0 ? t('{{n}} waiting for you', { n: waitingIds.length }) : null,
  ].filter(Boolean);
  return (
    <button
      type="button"
      data-enso="settings-activity"
      onClick={() => {
        closeSettings();
        const target = waitingIds[0];
        if (!target) return;
        showLocalCodeView();
        useSessionsStore.getState().selectConversation(target);
      }}
      className="mx-2 mb-2 flex min-h-9 shrink-0 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground max-md:min-h-11"
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          waitingIds.length > 0 ? 'bg-amber-500' : 'bg-emerald-500'
        )}
      />
      <span className="truncate">{parts.join(' · ')}</span>
    </button>
  );
}

/** 主窗口里的设置页（盖在工作区上，工作区保持挂载只是隐藏） */
export function SettingsView({
  navWidth,
  onNavResize,
  open,
}: {
  navWidth: number;
  onNavResize?: (deltaX: number) => void;
  open: boolean;
}) {
  const route = useAppViewStore((s) => s.settings);
  const initialCategory = useAppViewStore((s) => s.lastCategory);
  const mobileDetail = useAppViewStore((s) => s.mobileDetail);

  // 捕获阶段先记下按下时有没有弹层（弹层处理中会自己关掉），冒泡到窗口时再决定是否返回
  React.useEffect(() => {
    if (!open) return;
    let blocked = false;
    const capture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') blocked = escapeBlockedBeforeHandlers(document);
    };
    const bubble = (event: KeyboardEvent) => {
      if (!shouldEscapeCloseSettings(event, blocked)) return;
      event.preventDefault();
      closeSettings();
    };
    window.addEventListener('keydown', capture, true);
    window.addEventListener('keydown', bubble);
    return () => {
      window.removeEventListener('keydown', capture, true);
      window.removeEventListener('keydown', bubble);
    };
  }, [open]);

  const embedded = React.useMemo<EmbeddedSettings>(
    () => ({
      initialCategory,
      onCategoryChange: setSettingsCategory,
      mobileDetail,
      onMobileDetailChange: setSettingsMobileDetail,
      onBack: closeSettings,
      navWidth,
      onNavResize,
      footer: <WorkbenchActivityStrip />,
    }),
    [initialCategory, mobileDetail, navWidth, onNavResize]
  );

  return (
    <SettingsContent link={route?.link ?? null} linkSeq={route?.linkSeq ?? 0} embedded={embedded} />
  );
}
