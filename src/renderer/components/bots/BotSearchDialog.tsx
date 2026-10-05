import type { BotSearchHit } from '@shared/types/botIpc';
import { Search } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from 'react';
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from '@/components/ui/command';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { useI18n } from '@/i18n';
import { effectiveKeybindings, formatBinding } from '@/lib/keybindings';
import { formatRelativeTime } from '@/lib/time';
import { useBotsStore } from '@/stores/bots';
import { snippetParts } from '@/stores/bots/focus';
import { useSettingsStore } from '@/stores/settings';
import { BotAvatar, GroupAvatar } from './BotAvatar';
import { chatTitle } from './botText';

const hitKey = (hit: BotSearchHit) =>
  hit.locator.kind === 'timeline'
    ? `${hit.chatId}:${hit.locator.seq}`
    : `${hit.chatId}:${hit.locator.conversationId}:${hit.locator.messageIndex}`;

/** 侧栏搜索入口；快捷键与 Code 模式「搜索」同一绑定 */
export function BotSearchButton({ className }: { className: string }) {
  const { t } = useI18n();
  const keybindings = useSettingsStore((s) => s.keybindings);
  const binding = effectiveKeybindings(keybindings)['search-workspace'];
  const label = t('Search messages');
  return (
    <button
      type="button"
      className={className}
      onClick={() => useBotsStore.getState().setSearchOpen(true)}
      title={binding ? `${label} (${formatBinding(binding)})` : label}
    >
      <Search className="h-4 w-4" />
    </button>
  );
}

/** Bot 模式 ⌘K：搜群时间线与私聊（含历史会话）正文，选中跳到对应消息 */
export function BotSearchDialog() {
  const { t, locale } = useI18n();
  const open = useBotsStore((s) => s.searchOpen);
  const setOpen = useBotsStore((s) => s.setSearchOpen);
  const bots = useBotsStore((s) => s.bots);
  const chats = useBotsStore((s) => s.chats);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ key: string; hits: BotSearchHit[]; truncated: boolean }>();
  const trimmed = query.trim();
  const byId = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const chatById = useMemo(() => new Map(chats.map((chat) => [chat.id, chat])), [chats]);
  const current = result?.key === trimmed ? result : undefined;

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResult(undefined);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !trimmed) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.electronAPI.bots
        .search({ query: trimmed })
        .then((response) => {
          if (cancelled) return;
          setResult(
            response.ok
              ? { key: trimmed, hits: response.hits, truncated: response.truncated }
              : { key: trimmed, hits: [], truncated: false }
          );
        })
        .catch(() => {
          if (!cancelled) setResult({ key: trimmed, hits: [], truncated: false });
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, trimmed]);

  const closeOnEscape = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };
  const now = Date.now();

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup
        className="max-h-[min(36rem,calc(100vh-6rem))] max-w-2xl"
        onKeyDown={closeOnEscape}
      >
        <Command>
          <CommandInput
            placeholder={t('Search group and direct messages…')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              closeOnEscape(event);
              // 结果异步到达时列表不会自动高亮首项：无高亮项时回车直接打开第一条
              const first = current?.hits[0];
              if (
                event.key === 'Enter' &&
                !event.nativeEvent.isComposing &&
                first &&
                !document.querySelector('[data-slot="command-dialog-popup"] [data-highlighted]')
              ) {
                event.preventDefault();
                useBotsStore.getState().focusHit(first, trimmed);
              }
            }}
          />
          <CommandPanel>
            {trimmed && current && current.hits.length === 0 && (
              <CommandEmpty>{t('No matching messages')}</CommandEmpty>
            )}
            <CommandList>
              {current?.hits.map((hit) => {
                const chat = chatById.get(hit.chatId);
                const members = (chat?.members ?? [])
                  .map((id) => byId.get(id))
                  .filter((bot) => bot !== undefined);
                const speaker =
                  hit.speaker.kind === 'human'
                    ? t('You')
                    : (byId.get(hit.speaker.botId)?.name ?? t('Deleted member'));
                const history =
                  hit.locator.kind === 'session' && !hit.locator.current
                    ? ` · ${t('History')}`
                    : '';
                return (
                  <CommandItem
                    key={hitKey(hit)}
                    value={hitKey(hit)}
                    className="items-start gap-2.5"
                    onClick={() => useBotsStore.getState().focusHit(hit, trimmed)}
                  >
                    <span className="mt-0.5 shrink-0">
                      {hit.chatKind === 'direct' ? (
                        <BotAvatar bot={members[0]} />
                      ) : (
                        <GroupAvatar bots={members} />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5 text-xs">
                        <span className="truncate font-medium">
                          {chat ? chatTitle(chat, bots, t) : t('Deleted chat')}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {speaker}
                          {history}
                        </span>
                      </div>
                      <p className="line-clamp-2 break-words text-muted-foreground text-xs">
                        {snippetParts(hit.snippet, hit.ranges).map((part, index) =>
                          part.match ? (
                            // biome-ignore lint/suspicious/noArrayIndexKey: 片段按位置稳定
                            <mark key={index} className="rounded-[3px] bg-brand/14 text-foreground">
                              {part.text}
                            </mark>
                          ) : (
                            // biome-ignore lint/suspicious/noArrayIndexKey: 片段按位置稳定
                            <span key={index}>{part.text}</span>
                          )
                        )}
                      </p>
                    </div>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {hit.at ? formatRelativeTime(hit.at, locale, now) : ''}
                    </span>
                  </CommandItem>
                );
              })}
              {current?.truncated && (
                <p className="px-2 py-1.5 text-center text-muted-foreground text-xs">
                  {t('Showing the latest {{n}} matches', { n: current.hits.length })}
                </p>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <KbdGroup>
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                </KbdGroup>
                {t('Navigate')}
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                {t('Open')}
              </span>
            </div>
            <span className="flex items-center gap-1.5">
              <Kbd>esc</Kbd>
              {t('Close')}
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
