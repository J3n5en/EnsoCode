import type {
  SessionWorktree,
  WorkspaceBranch,
  WorkspaceBranches,
  WorktreeStatus,
} from '@shared/types/worktree';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  House,
  Loader2,
  MessageSquarePlus,
  Pencil,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { DIRTY_MAIN_TREE, worktreeHasPendingWork } from '@/stores/sessions/worktree';
import { useSettingsStore } from '@/stores/settings';
import { WorkspaceBranchDialog } from './WorkspaceBranchDialog';
import { WorkspaceBranchList } from './WorkspaceBranchList';
import { worktreeHoverText } from './WorktreeBadge';
import { WorktreeRenameDialog } from './WorktreeRenameDialog';
import { workspaceBranchFeedback } from './workspaceBranchFeedback';
import { canAttachWorktree, existingProjectWorktrees, worktreeDisplayName } from './worktreeUi';

/**
 * composer 工具行的工作区选择（紧跟预设选择器）：本地工作区 / 隔离 worktree。
 * fresh 会话直接绑定；已开聊会话走完整迁移语义（主树干净检查 + release + 迁移提醒）；
 * 切回本地 = 清理 worktree，有未落地成果时弹确认（分支保留）。
 */
export function WorktreePicker({
  conversationId,
  onBranchChange,
}: {
  conversationId: string;
  /** 当前分支（未知/非 git/加载中为 undefined），供会话头展示，避免重复拉取 */
  onBranchChange?: (branch: string | undefined) => void;
}) {
  const { t } = useI18n();
  const conversation = useSessionsStore((state) => state.conversations[conversationId]);
  const moveConversationToWorktree = useSessionsStore((state) => state.moveConversationToWorktree);
  const cleanupWorktree = useSessionsStore((state) => state.cleanupWorktree);
  const refreshWorktreeStatuses = useSessionsStore((state) => state.refreshWorktreeStatuses);
  const conversations = useSessionsStore((state) => state.conversations);
  const statuses = useSessionsStore((state) => state.worktreeStatuses);
  const attachConversationToWorktree = useSessionsStore(
    (state) => state.attachConversationToWorktree
  );
  const newConversation = useSessionsStore((state) => state.newConversation);
  const switchWorkspaceBranch = useSessionsStore((state) => state.switchWorkspaceBranch);
  const workspaceRevision = useSessionsStore(
    (state) => state.workspaceRevisionByConversation[conversationId] ?? 0
  );
  const [renameEntity, setRenameEntity] = useState<{
    conversationId: string;
    worktree: SessionWorktree;
  } | null>(null);
  const candidates = useMemo(
    () => existingProjectWorktrees(conversations, conversation?.projectId ?? '', statuses),
    [conversations, conversation?.projectId, statuses]
  );
  const [open, setOpen] = useState(false);
  const [branchView, setBranchView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingCleanup, setPendingCleanup] = useState<WorktreeStatus | null>(null);
  const [dirtyConfirm, setDirtyConfirm] = useState(false);

  const project = useSettingsStore((state) =>
    conversation ? state.projects.find((p) => p.id === conversation.projectId) : undefined
  );
  const enabled = Boolean(
    conversation &&
      !conversation.parentId &&
      !conversation.child &&
      project?.kind !== 'ssh' &&
      project?.kind !== 'scratch' &&
      project?.kind !== 'secretary'
  );
  const workspaceKey = `${conversationId}\0${conversation?.worktree?.path ?? project?.path ?? ''}`;
  const currentKeyRef = useRef(workspaceKey);
  currentKeyRef.current = workspaceKey;
  const requestRef = useRef(0);
  const actionRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) (branchView ? searchRef : workspaceRef).current?.focus();
  }, [open, branchView]);
  const [branchSnapshot, setBranchSnapshot] = useState<{
    key: string;
    data: WorkspaceBranches;
  } | null>(null);
  const branchData = branchSnapshot?.key === workspaceKey ? branchSnapshot.data : null;
  const reportedBranch = branchData?.currentBranch ?? undefined;
  useEffect(() => {
    onBranchChange?.(reportedBranch);
  }, [onBranchChange, reportedBranch]);
  const [branchLoading, setBranchLoading] = useState(true);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [createFor, setCreateFor] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const createOpen = createFor === workspaceKey;
  useEffect(() => {
    void workspaceKey;
    setOpen(false);
    setBranchView(false);
    setQuery('');
    setCreateFor(null);
    setSwitchError(null);
  }, [workspaceKey]);
  const refreshBranches = useCallback(
    async (notify = false) => {
      if (!enabled) return;
      const request = ++requestRef.current;
      setBranchLoading(true);
      setBranchError(null);
      try {
        const result = await window.electronAPI.worktree.branches(conversationId);
        if (request !== requestRef.current || currentKeyRef.current !== workspaceKey) return;
        if (result.ok) setBranchSnapshot({ key: workspaceKey, data: result.value });
        else {
          const description = workspaceBranchFeedback(result.code, t);
          setBranchError(description);
          if (notify) addToast({ type: 'error', title: t('Failed to load branches'), description });
        }
      } catch (error) {
        if (request !== requestRef.current || currentKeyRef.current !== workspaceKey) return;
        setBranchError(t('Failed to load branches'));
        if (notify)
          addToast({
            type: 'error',
            title: t('Failed to load branches'),
            description: String(error),
          });
      } finally {
        if (request === requestRef.current && currentKeyRef.current === workspaceKey)
          setBranchLoading(false);
      }
    },
    [conversationId, enabled, t, workspaceKey]
  );
  useEffect(() => {
    void workspaceRevision;
    void refreshBranches();
    const onFocus = () => {
      if (!actionRef.current) void refreshBranches();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      requestRef.current += 1;
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshBranches, workspaceRevision]);
  if (!conversation || conversation.parentId || conversation.child) return null;
  // ssh 远程项目没有本机 git worktree可用,main 也会拒绝——入口直接隐藏
  if (project?.kind === 'ssh') return null;
  const isolated = Boolean(conversation.worktree);
  const disabled =
    busy ||
    conversation.spawning ||
    conversation.status === 'running' ||
    Boolean(conversation.workspaceMigrating || conversation.reloading);
  const missing = conversation.worktreeMissing || statuses[conversationId]?.exists === false;
  const canAttach = canAttachWorktree(conversation);

  const currentBranch = branchData ? branchData.currentBranch : conversation.worktree?.branch;
  const branchLabel = currentBranch ?? (branchData?.headCommit ? t('Detached HEAD') : '');
  const workspaceName = conversation.worktree
    ? worktreeDisplayName(conversation.worktree)
    : t('Local');
  const pickerLabel =
    branchLabel &&
    branchLabel !== workspaceName &&
    (!branchData?.defaultBranch || currentBranch !== branchData.defaultBranch)
      ? `${workspaceName} · ${branchLabel}`
      : workspaceName;
  const branchDisabled =
    disabled ||
    missing ||
    branchLoading ||
    Boolean(branchError) ||
    !branchData ||
    Boolean(branchData.blockedReason);
  const runBranchAction = async (branch: string, create = false, sourceId?: string) => {
    if (branchDisabled || actionRef.current) return;
    actionRef.current = true;
    requestRef.current += 1;
    setBusy(true);
    setSwitchError(null);
    const title = sourceId ? t('Failed to create conversation') : t('Failed to switch branch');
    try {
      if (sourceId) {
        if (
          !(await newConversation(conversation.projectId, { worktreeFromConversationId: sourceId }))
        ) {
          addToast({ type: 'error', title });
        } else if (currentKeyRef.current === workspaceKey) setOpen(false);
        return;
      }
      const result = await switchWorkspaceBranch(conversationId, branch, create);
      if (currentKeyRef.current !== workspaceKey) return;
      if (!result.ok) {
        const description = workspaceBranchFeedback(result.code, t);
        setSwitchError(description);
        addToast({
          type: 'error',
          title,
          description:
            result.code === 'git-error' ? `${description}\n${result.error}` : description,
        });
        void refreshBranches();
      } else {
        setBranchSnapshot({ key: workspaceKey, data: result.value });
        setBranchError(null);
        setCreateFor(null);
        setOpen(false);
      }
    } catch (error) {
      if (currentKeyRef.current !== workspaceKey) return;
      setSwitchError(String(error));
      addToast({ type: 'error', title, description: String(error) });
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  };
  const selectBranch = (branch: WorkspaceBranch) => {
    if (
      branch.name === branchData?.currentBranch ||
      (branch.occupied && !branch.worktreeConversationId)
    )
      return;
    void runBranchAction(
      branch.name,
      false,
      branch.occupied ? branch.worktreeConversationId : undefined
    );
  };
  const handleWorktreeAction = async (sourceId?: string) => {
    if (disabled) return;
    setBusy(true);
    const title = sourceId ? t('Failed to use worktree') : t('Failed to create conversation');
    try {
      if (sourceId) {
        const error = await attachConversationToWorktree(conversationId, sourceId);
        if (error) addToast({ type: 'error', title, description: error });
      } else if (
        !(await newConversation(conversation.projectId, {
          worktreeFromConversationId: conversationId,
        }))
      ) {
        addToast({ type: 'error', title });
      }
    } catch (error) {
      addToast({ type: 'error', title, description: String(error) });
    } finally {
      setBusy(false);
    }
  };

  const runCleanup = async () => {
    setBusy(true);
    try {
      const error = await cleanupWorktree(conversationId);
      if (error) {
        addToast({ type: 'error', title: t('Failed to clean up worktree'), description: error });
      } else {
        void refreshWorktreeStatuses();
      }
    } catch (error) {
      addToast({
        type: 'error',
        title: t('Failed to clean up worktree'),
        description: String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleIsolate = async (allowDirtyMainTree = false) => {
    setBusy(true);
    try {
      const error = await moveConversationToWorktree(conversationId, { allowDirtyMainTree });
      if (error === DIRTY_MAIN_TREE) {
        setDirtyConfirm(true);
      } else if (error) {
        addToast({ type: 'error', title: t('Failed to move to worktree'), description: error });
      } else {
        void refreshWorktreeStatuses();
      }
    } catch (error) {
      addToast({
        type: 'error',
        title: t('Failed to move to worktree'),
        description: String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleLocal = async () => {
    setBusy(true);
    try {
      const status = await window.electronAPI.worktree.status(conversationId);
      if (status.ok && worktreeHasPendingWork(status.value)) {
        setPendingCleanup(status.value);
        return;
      }
      await runCleanup();
    } catch (error) {
      addToast({
        type: 'error',
        title: t('Failed to clean up worktree'),
        description: String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const options = [
    {
      id: 'local',
      selected: !isolated,
      icon: <House className="h-3.5 w-3.5 shrink-0" />,
      name: t('Local workspace'),
      hint: t('Work directly in the main working tree'),
      onSelect: () => {
        if (isolated) void handleLocal();
      },
    },
    {
      id: 'worktree',
      selected: isolated,
      icon: <GitBranch className="h-3.5 w-3.5 shrink-0" />,
      name: conversation.worktree
        ? worktreeDisplayName(conversation.worktree)
        : t('New isolated worktree'),
      hint: isolated
        ? conversation.worktree?.branch
        : t('Run this session on its own git worktree'),
      onSelect: () => {
        if (!isolated) void handleIsolate();
      },
    },
  ];

  const dirtyDialog = (
    <ConfirmDialog
      open={dirtyConfirm}
      onOpenChange={setDirtyConfirm}
      title={t('Main working tree has uncommitted changes')}
      description={t(
        'The new worktree branches off HEAD, so those changes stay in the main working tree and will not follow this session.'
      )}
      confirmLabel={t('Move anyway')}
      onConfirm={() => {
        setDirtyConfirm(false);
        void handleIsolate(true);
      }}
    />
  );

  const cleanupWarning = (): string => {
    const parts: string[] = [];
    if (pendingCleanup?.dirty) parts.push(t('Uncommitted changes'));
    if (pendingCleanup && pendingCleanup.ahead > 0)
      parts.push(t('{{n}} unmerged commits (branch is kept)', { n: pendingCleanup.ahead }));
    return parts.join('; ');
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          if (busy) return;
          setOpen(nextOpen);
          if (nextOpen) {
            setBranchView(false);
            setQuery('');
            void refreshBranches();
          }
        }}
      >
        <PopoverTrigger
          ref={triggerRef}
          disabled={disabled}
          className="flex h-7 min-w-0 max-w-52 shrink items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          title={
            conversation.worktree
              ? `${pickerLabel}\n${worktreeHoverText(conversation.worktree, statuses[conversationId], t)}`
              : pickerLabel
          }
        >
          {busy ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          ) : isolated ? (
            <GitBranch className="h-3 w-3 shrink-0" />
          ) : (
            <House className="h-3 w-3 shrink-0" />
          )}
          <span className="min-w-0 truncate">{pickerLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="start"
          className="w-72 [&_[data-slot=popover-viewport]]:p-1"
          initialFocus={workspaceRef}
          finalFocus={createOpen || renameEntity !== null ? false : triggerRef}
        >
          {branchView ? (
            <>
              <button
                type="button"
                onClick={() => setBranchView(false)}
                aria-label={t('Back to workspaces')}
                className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
                {t('Local branches')}
              </button>
              <WorkspaceBranchList
                data={branchData}
                loading={branchLoading}
                error={branchError}
                disabled={disabled || missing}
                query={query}
                searchRef={searchRef}
                onQueryChange={setQuery}
                onSelect={selectBranch}
                onRetry={() => void refreshBranches(true)}
                onCreate={() => {
                  if (branchDisabled || !branchData?.headCommit) return;
                  setSwitchError(null);
                  setCreateFor(workspaceKey);
                  setOpen(false);
                }}
              />
            </>
          ) : (
            <>
              {options.map((option) => (
                <button
                  key={option.id}
                  ref={option.id === 'local' ? workspaceRef : undefined}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    option.onSelect();
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    option.selected
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  {option.icon}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.name}</span>
                    {option.hint && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {option.hint}
                      </span>
                    )}
                  </span>
                  {option.selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
              ))}
              {canAttach && candidates.length > 0 && (
                <div className="mt-1 border-t pt-1">
                  <p className="px-2 py-1 text-[11px] text-muted-foreground">
                    {t('Existing worktrees')}
                  </p>
                  <div className="max-h-56 overflow-y-auto">
                    {candidates.map(({ conversationId: sourceId, worktree }) => (
                      <button
                        key={worktree.path}
                        type="button"
                        disabled={disabled}
                        title={worktreeHoverText(worktree, statuses[sourceId], t)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        onClick={() => {
                          setOpen(false);
                          void handleWorktreeAction(sourceId);
                        }}
                      >
                        <GitBranch className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{worktreeDisplayName(worktree)}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {worktree.path}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {conversation.worktree && (
                <div className="mt-1 border-t pt-1">
                  <button
                    type="button"
                    disabled={disabled || missing}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
                    onClick={() => {
                      setOpen(false);
                      void handleWorktreeAction();
                    }}
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                    {t('New conversation in this worktree')}
                  </button>
                  <button
                    type="button"
                    disabled={disabled || missing}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
                    onClick={() => {
                      setOpen(false);
                      if (conversation.worktree)
                        setRenameEntity({ conversationId, worktree: conversation.worktree });
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    {t('Rename worktree')}
                  </button>
                </div>
              )}
              <div className="mt-1 border-t pt-1">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setBranchView(true)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  <GitBranch className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">{t('Switch branch')}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                </button>
              </div>
            </>
          )}
        </PopoverPopup>
      </Popover>
      <ConfirmDialog
        open={pendingCleanup !== null}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setPendingCleanup(null);
        }}
        title={t('Clean up worktree?')}
        description={t(
          'Pending work: {{warning}}. This session returns to the main working tree. The worktree directory and uncommitted changes are removed only when no other sessions use it. The branch is kept.',
          { warning: cleanupWarning() }
        )}
        confirmLabel={t('Clean up')}
        onConfirm={() => {
          setPendingCleanup(null);
          void runCleanup();
        }}
      />
      {createOpen && (
        <WorkspaceBranchDialog
          key={workspaceKey}
          initialName={query.trim()}
          data={branchData}
          busy={busy}
          disabled={branchDisabled}
          error={switchError}
          returnFocus={triggerRef}
          onSubmit={(name) => void runBranchAction(name, true)}
          onClose={() => setCreateFor(null)}
        />
      )}
      {dirtyDialog}
      <WorktreeRenameDialog entity={renameEntity} onClose={() => setRenameEntity(null)} />
    </>
  );
}
