import { botBrowserKey } from '@shared/bots/browser';
import { Globe, Plus, X } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { type BrowserSurface, BrowserView } from '@/components/sidepanel/BrowserView';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';

/** 聊天共享浏览器：私聊成员、群里所有成员及其委派子会话共用同一组标签 */
export function BotBrowserPanel({ chatId, visible }: { chatId: string; visible: boolean }) {
  const { t } = useI18n();
  const state = useBotsStore((s) => s.browserTabs[chatId]);
  const titles = useBotsStore((s) => s.browserTitles);
  const holders = useBotsStore((s) => s.browserHolders);
  const { openBrowserTab, selectBrowserTab, closeBrowserTab, setBrowserTitle } =
    useBotsStore.getState();
  const active = state?.active;

  // 切到浏览器页却还没有标签：开一个空白页
  useEffect(() => {
    if (!active) openBrowserTab(chatId);
  }, [active, chatId, openBrowserTab]);

  const surface = useMemo<BrowserSurface | null>(
    () =>
      active
        ? {
            id: active,
            isActive: true,
            isVisible: true,
            setTitle: (title) => setBrowserTitle(active, title),
            getParameters: () => undefined,
            updateParameters: () => {},
          }
        : null,
    [active, setBrowserTitle]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5">
        {state?.tabs.map((tabId) => {
          const holder = holders[tabId];
          const title = titles[tabId] || t('Browser');
          return (
            <div
              key={tabId}
              className={cn(
                'flex h-6 min-w-0 max-w-44 shrink items-center rounded-md text-xs',
                tabId === active
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              <button
                type="button"
                title={
                  holder
                    ? `${title}\n${t('{{name}} is using this tab', { name: holder.name })}`
                    : title
                }
                onClick={() => selectBrowserTab(chatId, tabId)}
                className="flex h-full min-w-0 items-center gap-1.5 pl-2"
              >
                <Globe className="h-3 w-3 shrink-0" />
                <span className="truncate">{title}</span>
                {holder && (
                  <span className="max-w-16 shrink-0 truncate text-muted-foreground">
                    · {holder.name}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={t('Close')}
                title={t('Close')}
                onClick={() => void closeBrowserTab(chatId, tabId)}
                className="mx-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-60 hover:bg-foreground/10 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          aria-label={t('New tab')}
          title={t('New tab')}
          onClick={() => openBrowserTab(chatId)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {surface && (
        <BrowserView
          key={surface.id}
          conversationId={botBrowserKey(chatId)}
          panelApi={surface}
          active={visible}
        />
      )}
    </div>
  );
}
