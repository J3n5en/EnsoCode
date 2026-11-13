import { chatThreads, filterThreads, menuThreads, type ThreadFilter } from '@shared/bots/threads';
import type { BotChat } from '@shared/types/bot';
import { Check, ChevronDown, List, MessageSquarePlus, Pencil, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu';
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useBotsStore } from '@/stores/bots';
import { chatSummary } from '@/stores/bots/selectors';
import { isUnread } from '@/stores/bots/unread';
import { chatErrorText } from './botText';

export const SWITCHER_BUTTON =
  'flex h-7 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50';

export interface SwitcherEntry {
  id: string;
  title: string;
  preview: string;
  activityAt: number;
  unread: boolean;
  running: boolean;
  canRename?: boolean;
  canDelete?: boolean;
}

/** 群话题切换：下拉列常用话题，其余进「全部话题」弹窗；切走的话题在后台照常运行 */
export function ThreadSwitcher({ group, thread }: { group: BotChat; thread: BotChat }) {
  const { t } = useI18n();
  const chats = useBotsStore((s) => s.chats);
  const sessions = useBotsStore((s) => s.sessions);
  const timelines = useBotsStore((s) => s.timelines);
  const queue = useBotsStore((s) => s.queue);
  const reads = useBotsStore((s) => s.reads);
  const bots = useBotsStore((s) => s.bots);
  const [listOpen, setListOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const archived = group.archivedAt !== undefined;
  const names = useMemo(() => Object.fromEntries(bots.map((bot) => [bot.id, bot.name])), [bots]);
  const label = (chat: BotChat) =>
    chat.threadTitle ?? (chat.parentId ? t('New topic') : t('Main topic'));
  const entries: SwitcherEntry[] = chatThreads(chats, group).map((chat) => {
    const summary = chatSummary(chat, { sessions, timeline: timelines[chat.id], queue, names });
    return {
      id: chat.id,
      title: label(chat),
      preview: summary.preview,
      activityAt: Math.max(summary.activityAt, chat.createdAt),
      unread: chat.id !== thread.id && isUnread(summary.marker, reads[summary.key]),
      running: summary.running,
      canRename: !archived,
      canDelete: Boolean(chat.parentId),
    };
  });
  const shown = menuThreads(entries, { currentId: thread.id, rootId: group.id });
  const hidden = entries.length - shown.length;
  const open = (id: string) => useBotsStore.getState().openThread(group.id, id);

  const create = async () => {
    if (!(await useBotsStore.getState().createThread(group.id)))
      addToast({ type: 'error', title: t('Could not create topic') });
  };
  const remove = async (id: string) => {
    const result = await window.electronAPI.bots.deleteThread(id);
    if (!result.ok) addToast({ type: 'error', title: chatErrorText(result.error, t) });
    void useBotsStore.getState().refreshChats();
  };

  return (
    <>
      <Menu>
        <MenuTrigger
          className={cn(SWITCHER_BUTTON, 'max-w-56 @max-[28rem]:max-w-32 @max-[21rem]:max-w-24')}
        >
          <span className="truncate">{label(thread)}</span>
          {entries.some((entry) => entry.unread) && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-info" />
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-72">
          <MenuGroup>
            <MenuGroupLabel>{t('Topics')}</MenuGroupLabel>
            {shown.map((entry) => (
              <MenuItem key={entry.id} onClick={() => open(entry.id)}>
                <Check className={cn(entry.id !== thread.id && 'invisible')} />
                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                <ThreadMarks entry={entry} />
              </MenuItem>
            ))}
          </MenuGroup>
          <MenuSeparator />
          {hidden > 0 && (
            <MenuItem onClick={() => setListOpen(true)}>
              <List />
              {t('All topics ({{n}})', { n: entries.length })}
            </MenuItem>
          )}
          <MenuItem disabled={archived} onClick={() => void create()}>
            <MessageSquarePlus />
            {t('New topic')}
          </MenuItem>
          <MenuItem
            disabled={archived}
            onClick={() => setRenaming({ id: thread.id, title: label(thread) })}
          >
            <Pencil />
            {t('Rename topic')}
          </MenuItem>
          {thread.parentId && (
            <MenuItem variant="destructive" onClick={() => setDeleting(thread.id)}>
              <Trash2 />
              {t('Delete topic')}
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
      <button
        type="button"
        disabled={archived}
        onClick={() => void create()}
        className={cn(SWITCHER_BUTTON, 'shrink-0')}
        title={t('New topic')}
        aria-label={t('New topic')}
      >
        <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
        <span className="@min-[28rem]:inline hidden">{t('New topic')}</span>
      </button>
      {listOpen && (
        <ThreadsDialog
          heading={t('Topics')}
          placeholder={t('Search topics...')}
          empty={t('No matching topics')}
          filters
          entries={entries}
          currentId={thread.id}
          onClose={() => setListOpen(false)}
          onOpen={(id) => {
            open(id);
            setListOpen(false);
          }}
          onRename={(entry) => setRenaming({ id: entry.id, title: entry.title })}
          onDelete={(entry) => setDeleting(entry.id)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(value) => !value && setDeleting(null)}
        title={t('Delete this topic?')}
        description={t(
          'Its messages and member sessions are removed; replies in progress are stopped. Group notes, memory and the task board stay.'
        )}
        confirmLabel={t('Delete')}
        onConfirm={() => deleting && void remove(deleting)}
        zIndexLevel={listOpen ? 'nested' : 'base'}
      />
      {renaming !== null && (
        <RenameDialog
          initial={renaming.title}
          nested={listOpen}
          onClose={() => setRenaming(null)}
          onSave={async (title) => {
            const result = await window.electronAPI.bots.renameThread(renaming.id, title);
            if (!result.ok) {
              addToast({ type: 'error', title: chatErrorText(result.error, t) });
              return;
            }
            useBotsStore.getState().upsertChat(result.chat);
            setRenaming(null);
          }}
        />
      )}
    </>
  );
}

export function ThreadMarks({ entry }: { entry: SwitcherEntry }) {
  const { locale } = useI18n();
  return (
    <>
      {entry.running && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}
      {entry.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-info" />}
      <span className="shrink-0 text-muted-foreground text-xs">
        {formatRelativeTime(entry.activityAt, locale)}
      </span>
    </>
  );
}

/** 话题 / 私聊对话的全部列表：搜索、可选状态筛选，逐行改名或删除 */
export function ThreadsDialog({
  heading,
  placeholder,
  empty,
  filters = false,
  entries,
  currentId,
  onClose,
  onOpen,
  onRename,
  onDelete,
}: {
  heading: string;
  placeholder: string;
  empty: string;
  /** 显示 全部 / 未读 / 进行中 筛选 */
  filters?: boolean;
  entries: SwitcherEntry[];
  currentId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onRename?: (entry: SwitcherEntry) => void;
  onDelete?: (entry: SwitcherEntry) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ThreadFilter>('all');
  const shown = filterThreads(entries, query, filter);
  const count = (value: ThreadFilter) => filterThreads(entries, '', value).length;
  const action =
    'shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100';
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="h-[min(40rem,85vh)] max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-2">
            {heading}
            <span className="font-sans text-muted-foreground text-sm tabular-nums">
              {entries.length}
            </span>
          </DialogTitle>
          <InputGroup data-size="sm" className="mt-1">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              value={query}
              placeholder={placeholder}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
          {filters && (
            <Tabs value={filter} onValueChange={(value) => setFilter(value as ThreadFilter)}>
              <TabsList>
                <TabsTab value="all">{t('All')}</TabsTab>
                <TabsTab value="unread">
                  {t('Unread')}
                  {count('unread') > 0 && <span className="tabular-nums">{count('unread')}</span>}
                </TabsTab>
                <TabsTab value="running">
                  {t('In progress')}
                  {count('running') > 0 && <span className="tabular-nums">{count('running')}</span>}
                </TabsTab>
              </TabsList>
            </Tabs>
          )}
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-y-0.5 border-t pt-3!">
          {shown.length === 0 && (
            <p className="py-10 text-center text-muted-foreground text-sm">{empty}</p>
          )}
          {shown.map((entry) => (
            <div
              key={entry.id}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
            >
              <button
                type="button"
                onClick={() => onOpen(entry.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Check
                  className={cn('h-3.5 w-3.5 shrink-0', entry.id !== currentId && 'invisible')}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{entry.title}</span>
                  {entry.preview && (
                    <span className="block truncate text-muted-foreground text-xs">
                      {entry.preview}
                    </span>
                  )}
                </span>
                <ThreadMarks entry={entry} />
              </button>
              {onRename && entry.canRename && (
                <button
                  type="button"
                  className={action}
                  onClick={() => onRename(entry)}
                  title={t('Rename topic')}
                  aria-label={t('Rename topic')}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
              {onDelete && entry.canDelete ? (
                <button
                  type="button"
                  className={cn(action, 'hover:text-destructive')}
                  onClick={() => onDelete(entry)}
                  title={t('Delete topic')}
                  aria-label={t('Delete topic')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : onDelete ? (
                <span className="w-5.5 shrink-0" aria-hidden />
              ) : null}
            </div>
          ))}
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  initial,
  nested,
  onClose,
  onSave,
}: {
  initial: string;
  nested: boolean;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(initial);
  const save = () => {
    if (title.trim()) void onSave(title.trim());
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm" zIndexLevel={nested ? 'nested' : 'base'}>
        <DialogHeader>
          <DialogTitle>{t('Rename topic')}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            value={title}
            autoFocus
            maxLength={80}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              // 输入法回车只是确认候选词
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') save();
            }}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={!title.trim()} onClick={save}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
