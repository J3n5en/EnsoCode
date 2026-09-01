import { BUILTIN_AGENT_TYPES } from '@shared/types/assets';
import { Bot, Pencil, Plus, X } from 'lucide-react';
import * as React from 'react';
import { ConversationTitleEdit } from '@/components/chat/ConversationTitleEdit';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { type Conversation, useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

/**
 * 聊天区顶部 tab 条：主会话 + 每个 coworker 一个 tab。
 * tab 只能切换,不能关闭;「解雇」是显式销毁动作(hover 出 X,带确认),避免幽灵态。
 */
export function CoworkerTabs({
  parent,
  displayedId,
  trailing,
}: {
  parent: Conversation;
  displayedId: string;
  trailing?: React.ReactNode;
}) {
  const { t } = useI18n();
  const conversations = useSessionsStore((state) => state.conversations);
  const [hiring, setHiring] = React.useState(false);
  const coworkers = (parent.coworkerIds ?? [])
    .map((id) => conversations[id])
    .filter((c): c is Conversation => Boolean(c));

  const tabClass = (active: boolean) =>
    cn(
      'flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
      active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'
    );

  return (
    <div className="flex items-center gap-1 border-b px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <RenameableTab
          id={parent.id}
          label={parent.title || t('New conversation')}
          className={tabClass(displayedId === parent.id)}
          onSelect={() => useSessionsStore.getState().selectTab(parent.id, undefined)}
        />
        {coworkers.map((coworker) => {
          const needsAttention =
            (coworker.pendingApprovals ?? []).length > 0 ||
            (coworker.pendingAsks ?? []).length > 0 ||
            (coworker.pendingCapabilityAsks ?? []).length > 0;
          return (
            <div key={coworker.id} className="group/tab relative shrink-0">
              <RenameableTab
                id={coworker.id}
                label={
                  coworker.title ||
                  coworker.child?.agentInstanceName ||
                  coworker.coworkerName ||
                  coworker.id
                }
                className={cn(
                  tabClass(displayedId === coworker.id),
                  'group-hover/tab:pr-6',
                  displayedId !== coworker.id && 'group-hover/tab:bg-muted/50'
                )}
                leading={<Bot className="h-3 w-3 shrink-0" />}
                trailing={
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      needsAttention
                        ? 'bg-destructive animate-pulse'
                        : coworker.status === 'running' || coworker.spawning
                          ? 'animate-pulse bg-blue-500'
                          : coworker.status === 'failed'
                            ? 'bg-destructive'
                            : 'bg-muted-foreground/30'
                    )}
                  />
                }
                onSelect={() => useSessionsStore.getState().selectTab(parent.id, coworker.id)}
              />
              {/* 关闭钉在 tab 内右端(hover 现身,button 让出留白),避免游离在 tab 外 */}
              <button
                type="button"
                title={t('Dismiss coworker')}
                className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-destructive group-hover/tab:block"
                onClick={() => {
                  if (window.confirm(t('Dismiss this coworker? Its session will be closed.'))) {
                    void useSessionsStore.getState().dismissCoworkerFromUI(parent.id, coworker.id);
                  }
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          title={t('Hire coworker')}
          disabled={!parent.started}
          onClick={() => setHiring(true)}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {trailing}
      {hiring && <HireCoworkerDialog parentId={parent.id} onClose={() => setHiring(false)} />}
    </div>
  );
}

function RenameableTab({
  id,
  label,
  className,
  leading,
  trailing,
  onSelect,
}: {
  id: string;
  label: string;
  className: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const [renaming, setRenaming] = React.useState(false);
  const tab = (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (!renaming) onSelect();
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setRenaming(true);
      }}
    >
      {leading}
      {renaming ? (
        <ConversationTitleEdit
          title={label}
          className="max-w-48 text-xs"
          onCommit={(title) => {
            useSessionsStore.getState().renameConversation(id, title);
            setRenaming(false);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <span className="max-w-48 truncate">{label}</span>
      )}
      {trailing}
    </button>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger render={tab as React.ReactElement<Record<string, unknown>>} />
      <ContextMenuPopup className="min-w-36">
        <ContextMenuItem onClick={() => setRenaming(true)}>
          <Pencil />
          {t('Rename')}
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

/** 手动雇佣弹窗：名字 + agent 类型;主 agent 经 worker 通知感知新同事 */
function HireCoworkerDialog({ parentId, onClose }: { parentId: string; onClose: () => void }) {
  const { t } = useI18n();
  const agentTypes = useSettingsStore((state) => state.agentTypes);
  const disabledBuiltins = useSettingsStore((state) => state.disabledBuiltinAgentTypes);
  const [name, setName] = React.useState('');
  const [agentType, setAgentType] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  // 与 main 下发口径一致：内置(过滤已关闭)+ 自定义(同名覆盖内置，trim+小写同口径)
  const customNames = new Set(agentTypes.map((entry) => entry.name.trim().toLowerCase()));
  const typeNames = [
    ...BUILTIN_AGENT_TYPES.filter(
      (type) => !disabledBuiltins.includes(type.name) && !customNames.has(type.name)
    ).map((type) => type.name),
    ...agentTypes.map((entry) => entry.name),
  ];

  const hire = async () => {
    const failed = await useSessionsStore
      .getState()
      .hireCoworker(parentId, name.trim(), agentType || undefined);
    if (failed) setError(failed);
    else onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('Hire coworker')}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <Field>
            <FieldLabel>{t('Name (slug)')}</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="reviewer"
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel>{t('Agent type')}</FieldLabel>
            <select
              value={agentType}
              onChange={(e) => setAgentType(e.target.value)}
              className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none"
            >
              <option value="">general</option>
              {typeNames.map((typeName) => (
                <option key={typeName} value={typeName}>
                  {typeName}
                </option>
              ))}
            </select>
          </Field>
          {error && <p className="text-destructive text-xs">{error}</p>}
          <div className="h-1" />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => void hire()} disabled={!name.trim()}>
            {t('Hire')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
