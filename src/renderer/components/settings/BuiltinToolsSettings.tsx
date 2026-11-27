import { computerPermissionGuideKind } from '@shared/computer/permissionGuide';
import type { ComputerCapabilities } from '@shared/computer/types';
import { explainDcgGuard } from '@shared/dcgRuleHints';
import type { EditMode } from '@shared/types';
import type { AgentMode } from '@shared/types/agent';
import type { BrowserClearKind } from '@shared/types/browser';
import { BUILTIN_TOOLS } from '@shared/types/builtinTools';
import type { DcgRuleExemption, DcgStatus, DcgUpdateCheck } from '@shared/types/dcg';
import { EDIT_MODES, isEditMode } from '@shared/types/editMode';
import {
  WEB_SEARCH_CHAIN_MAX,
  type WebSearchChainEntry,
  webSearchCandidateProviders,
} from '@shared/webSearchChain';
import {
  Box,
  Brain,
  ClipboardList,
  FilePenLine,
  FoldVertical,
  Globe,
  GripVertical,
  ListTodo,
  type LucideIcon,
  MessageCircleQuestion,
  Monitor,
  Search,
  ShieldAlert,
  ShieldX,
  Shrink,
  SkipForward,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { IS_MAC } from '@/lib/keybindings';
import { isRemoteClient } from '@/lib/remoteClient';
import { useMaterializedProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { builtinToolsInSection, TOOL_SECTIONS, type ToolSectionId } from './builtinToolSections';
import { ComputerAllowedApps } from './ComputerAllowedApps';
import {
  SettingsButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSubRow,
  SettingsSwitch,
} from './kit';
import { NewSessionBadge } from './NewSessionBadge';
import {
  enabledOccupancyTotal,
  OccupancyEnabledTotal,
  OccupancyMark,
  useOccupancyRows,
} from './OccupancyMark';

const EDIT_MODE_LABEL: Record<EditMode, string> = {
  replace: 'Text replacement',
  apply_patch: 'Apply patch (default)',
};

/** dcg 版本都是严格 x.y.z；非法或不等长都按「不满足」处理（返回 -1） */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return -1;
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

const TOOL_ICON: Record<string, LucideIcon> = {
  subagent: Users,
  workflow: Workflow,
  todo: ListTodo,
  plan: ClipboardList,
  ask_user: MessageCircleQuestion,
  browser: Globe,
  web: Search,
  background_tasks: SquareTerminal,
  memory: Brain,
  isolated_sandbox: Box,
  computer: Monitor,
  turn_discard: SkipForward,
};

function ToolRow({
  icon: Icon,
  title,
  description,
  control,
  children,
  rowId,
  newSession,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  control?: ReactNode;
  children?: ReactNode;
  rowId?: string;
  /** 只对新会话生效；字符串为徽标说明 */
  newSession?: boolean | string;
}) {
  return (
    <>
      <SettingsRow
        rowId={rowId}
        leading={<Icon className="size-4 shrink-0 text-muted-foreground" />}
        label={
          <>
            {title}
            {newSession && (
              <NewSessionBadge note={typeof newSession === 'string' ? newSession : undefined} />
            )}
          </>
        }
        description={description}
      >
        {control}
      </SettingsRow>
      {children}
    </>
  );
}

/** web_search 候选链编辑器：按序尝试各模型的原生搜索，全部失败落 Exa（固定兜底）。 */
function WebSearchChainEditor({ disabled }: { disabled: boolean }) {
  const { t } = useI18n();
  const chain = useSettingsStore((state) => state.webSearchChain);
  const setChain = useSettingsStore((state) => state.setWebSearchChain);
  const materialized = useMaterializedProviders();
  const candidates = useMemo(() => webSearchCandidateProviders(materialized), [materialized]);
  const [dragging, setDragging] = useState<number | null>(null);

  const update = (index: number, next: Partial<WebSearchChainEntry>) => {
    setChain(chain.map((entry, i) => (i === index ? { ...entry, ...next } : entry)));
  };
  const remove = (index: number) => setChain(chain.filter((_, i) => i !== index));
  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...chain];
    const [entry] = next.splice(from, 1);
    if (!entry) return;
    next.splice(to, 0, entry);
    setChain(next);
  };

  return (
    <div data-settings-row="tools.webSearchChain">
      <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pr-3 max-sm:pl-7">
        {t(
          "Try these models' built-in search in order. Credentials resolve at call time; if all fail, the keyless Exa service is the permanent fallback."
        )}
      </p>
      {chain.length === 0 && (
        <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pr-3 max-sm:pl-7">
          {t(
            "Default: use the current session model's built-in search when available, otherwise Exa."
          )}
        </p>
      )}
      {chain.map((entry, index) => (
        <div
          key={`${entry.providerId}/${entry.modelId}`}
          className="flex min-h-11 items-center gap-2 px-4 py-2 pl-10 max-sm:pr-3 max-sm:pl-7"
          draggable={!disabled}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            setDragging(index);
          }}
          onDragEnd={() => setDragging(null)}
          onDragOver={(event) => {
            if (dragging !== null && dragging !== index) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragging !== null) move(dragging, index);
            setDragging(null);
          }}
        >
          <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground" />
          <span className="w-4 shrink-0 text-center text-muted-foreground text-xs">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <ModelPicker
              providers={candidates}
              providerId={entry.providerId}
              modelId={entry.modelId}
              reasoningEnabled={false}
              thinkingLevel="medium"
              showReasoningControls={false}
              onSelect={(providerId, modelId) => update(index, { providerId, modelId })}
              onReasoningChange={() => undefined}
              onThinkingChange={() => undefined}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0"
            disabled={disabled}
            onClick={() => remove(index)}
            aria-label={t('Remove')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {chain.length < WEB_SEARCH_CHAIN_MAX && (
        <div className="max-w-xs px-4 py-2 pl-10 max-sm:pr-3 max-sm:pl-7">
          <ModelPicker
            providers={candidates}
            providerId=""
            modelId=""
            reasoningEnabled={false}
            thinkingLevel="medium"
            showReasoningControls={false}
            triggerLabel={`+ ${t('Add candidate')}`}
            onSelect={(providerId, modelId) => setChain([...chain, { providerId, modelId }])}
            onReasoningChange={() => undefined}
            onThinkingChange={() => undefined}
          />
        </div>
      )}
      <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pr-3 max-sm:pl-7">
        {t('Final fallback: Exa (keyless hosted search). Not a chain entry; always last.')}
      </p>
    </div>
  );
}

export function BuiltinToolsSettings() {
  const { t } = useI18n();
  const disabled = useSettingsStore((state) => state.disabledBuiltinTools);
  const toggle = useSettingsStore((state) => state.toggleBuiltinTool);
  const subagentAllowedModes = useSettingsStore((state) => state.subagentAllowedModes);
  const setSubagentAllowedModes = useSettingsStore((state) => state.setSubagentAllowedModes);
  const exploreFoldEnabled = useSettingsStore((state) => state.exploreFoldEnabled);
  const setExploreFoldEnabled = useSettingsStore((state) => state.setExploreFoldEnabled);
  const rtkEnabled = useSettingsStore((state) => state.rtkEnabled);
  const computerPreview = useSettingsStore((state) => state.computerPreview);
  const setComputerPreview = useSettingsStore((state) => state.setComputerPreview);
  const openLinksInBuiltinBrowser = useSettingsStore((state) => state.openLinksInBuiltinBrowser);
  const setOpenLinksInBuiltinBrowser = useSettingsStore(
    (state) => state.setOpenLinksInBuiltinBrowser
  );
  const setRtkEnabled = useSettingsStore((state) => state.setRtkEnabled);
  const protectedActionsInCode = useSettingsStore((state) => state.protectedActionsInCode);
  const setProtectedActionsInCode = useSettingsStore((state) => state.setProtectedActionsInCode);
  const editMode = useSettingsStore((state) => state.editMode);
  const setEditMode = useSettingsStore((state) => state.setEditMode);
  const occupancy = useOccupancyRows(
    BUILTIN_TOOLS.map((tool) => tool.id),
    () => window.electronAPI.assets.builtinToolOccupancy()
  );
  const enabledTokens = enabledOccupancyTotal(
    BUILTIN_TOOLS.filter((tool) => !disabled.includes(tool.id)).map((tool) => tool.id),
    occupancy.rows
  );
  const [cleared, setCleared] = useState<BrowserClearKind | null>(null);
  const [pendingClear, setPendingClear] = useState<BrowserClearKind | null>(null);
  const subagentEnabled = !disabled.includes('subagent');
  const setMode = (mode: AgentMode, enabled: boolean) => {
    setSubagentAllowedModes(
      enabled
        ? [...new Set([...subagentAllowedModes, mode])]
        : subagentAllowedModes.filter((item) => item !== mode)
    );
  };
  const clear = async (kind: BrowserClearKind) => {
    await window.electronAPI.browser.clearData(kind);
    setCleared(kind);
    setTimeout(() => setCleared(null), 2000);
  };
  const computerEnabled = !disabled.includes('computer');
  const [capabilities, setCapabilities] = useState<ComputerCapabilities | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  useEffect(() => {
    // computer:capabilities 只对宿主开放，远程拿不到探测结果
    if (!computerEnabled || isRemoteClient()) {
      setCapabilities(null);
      return;
    }
    let cancelled = false;
    void window.electronAPI.computer.capabilities().then((result) => {
      if (!cancelled && result.ok) setCapabilities(result.capabilities);
    });
    return () => {
      cancelled = true;
    };
  }, [computerEnabled]);
  useEffect(() => {
    if (!guideOpen || isRemoteClient()) return;
    let cancelled = false;
    const load = () => {
      void window.electronAPI.computer.capabilities().then((result) => {
        if (!cancelled && result.ok) setCapabilities(result.capabilities);
      });
    };
    load();
    const id = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [guideOpen]);

  const sectionExtras: Record<ToolSectionId, ReactNode> = {
    collaboration: null,
    web: null,
    execution: (
      <ToolRow
        rowId="tools.editMode"
        newSession
        icon={FilePenLine}
        title={t('File edit mode')}
        description={t(
          'Choose how files are modified. Apply patch is the default. New and cold-restored sessions use this mode; already warm sessions keep their current mode.'
        )}
        control={
          <SettingsSelect
            aria-label={t('File edit mode')}
            value={editMode}
            options={EDIT_MODES.map((mode) => ({ value: mode, label: t(EDIT_MODE_LABEL[mode]) }))}
            onValueChange={(value) => {
              if (isEditMode(value)) setEditMode(value);
            }}
          />
        }
      />
    ),
    context: (
      <>
        <ToolRow
          rowId="tools.explore-fold"
          icon={FoldVertical}
          newSession
          title={t('Explore fold')}
          description={t(
            'Let the agent mark exploratory reads and keep only a short report in later model context. Timeline stays intact.'
          )}
          control={
            <SettingsSwitch checked={exploreFoldEnabled} onCheckedChange={setExploreFoldEnabled} />
          }
        />
        <ToolRow
          rowId="tools.rtkEnabled"
          newSession
          icon={Shrink}
          title={t('RTK command compression')}
          description={t(
            'Compress supported command output before it enters the model context. Takes effect on new conversations.'
          )}
          control={<SettingsSwitch checked={rtkEnabled} onCheckedChange={setRtkEnabled} />}
        />
      </>
    ),
    safety: (
      <>
        <ToolRow
          rowId="tools.protected-action-confirmation"
          icon={ShieldAlert}
          newSession
          title={t('Protected action confirmation')}
          description={t(
            'Even in full-access mode, ask before external sends, deletions, payments, deployments and secret-file access. Always on for Bot members not set to Full access. Takes effect on new conversations.'
          )}
          control={
            <SettingsSwitch
              checked={protectedActionsInCode}
              onCheckedChange={setProtectedActionsInCode}
            />
          }
        />
        <DcgGuardRow />
      </>
    ),
  };

  return (
    <SettingsPage
      rowId="tools.root"
      title={
        <>
          {t('Built-in tools')}
          <OccupancyEnabledTotal tokens={enabledTokens} />
        </>
      }
      description={t('Toggle the built-in tools available to agents.')}
    >
      {TOOL_SECTIONS.map((section) => (
        <SettingsSection key={section.id} title={t(section.label)}>
          {builtinToolsInSection(BUILTIN_TOOLS, section.id).map((tool) => (
            <ToolRow
              key={tool.id}
              icon={TOOL_ICON[tool.id] ?? Wrench}
              title={t(tool.name)}
              description={t(tool.description)}
              newSession={
                tool.id === 'isolated_sandbox'
                  ? t(
                      'Isolated sandbox switches between script and tool-search mode, so open sessions keep the mode they started with.'
                    )
                  : undefined
              }
              control={
                <>
                  <OccupancyMark
                    row={occupancy.rows[tool.id]}
                    pending={occupancy.pending && !occupancy.rows[tool.id]}
                  />
                  <SettingsSwitch
                    checked={!disabled.includes(tool.id)}
                    onCheckedChange={(checked) => {
                      toggle(tool.id, checked);
                      if (tool.id === 'computer' && checked) setGuideOpen(true);
                    }}
                  />
                </>
              }
            >
              {tool.id === 'web' ? (
                <WebSearchChainEditor disabled={disabled.includes('web')} />
              ) : null}
              {tool.id === 'subagent' ? (
                <div data-settings-row="tools.subagentModes">
                  {(
                    [
                      ['task', 'One-shot task agents'],
                      ['coworker', 'Persistent coworkers'],
                    ] as const
                  ).map(([mode, label]) => (
                    <SettingsSubRow key={mode} label={t(label)}>
                      <SettingsSwitch
                        checked={subagentAllowedModes.includes(mode)}
                        disabled={!subagentEnabled}
                        onCheckedChange={(checked) => setMode(mode, checked)}
                      />
                    </SettingsSubRow>
                  ))}
                  {!subagentEnabled && (
                    <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pr-3 max-sm:pl-7">
                      {t(
                        'The unified subagent tool is off. Re-enabling it keeps this mode selection.'
                      )}
                    </p>
                  )}
                </div>
              ) : null}
              {tool.id === 'computer' && computerEnabled ? (
                <div data-settings-row="tools.computer">
                  {capabilities && computerPermissionGuideKind(capabilities) === 'unsupported' ? (
                    <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pr-3 max-sm:pl-7">
                      {t('This platform cannot operate the desktop yet.')}
                    </p>
                  ) : (
                    <>
                      {capabilities?.platform === 'darwin' && (
                        <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pr-3 max-sm:pl-7">
                          {t(
                            'Computer needs Screen Recording to capture windows and Accessibility to inspect or click them. Grant both to EnsoCode, then restart the app.'
                          )}
                        </p>
                      )}
                      {capabilities && (
                        <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pr-3 max-sm:pl-7">
                          {t(
                            capabilities.capturePermission === 'granted'
                              ? 'Capture: granted'
                              : 'Capture: denied'
                          )}
                          {capabilities.axPermission !== 'unsupported' && (
                            <>
                              {' · '}
                              {t(
                                capabilities.axPermission === 'granted'
                                  ? 'Input/AX: granted'
                                  : 'Input/AX: denied'
                              )}
                            </>
                          )}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2 px-4 py-2.5 pl-10 max-sm:pr-3 max-sm:pl-7">
                        <SettingsButton onClick={() => setGuideOpen(true)}>
                          {t('Show permission guide')}
                        </SettingsButton>
                        {capabilities?.platform === 'darwin' && (
                          <>
                            <SettingsButton
                              onClick={() =>
                                void window.electronAPI.computer.openPermissions('screen')
                              }
                            >
                              {t('Open Screen Recording settings')}
                            </SettingsButton>
                            <SettingsButton
                              onClick={() =>
                                void window.electronAPI.computer.openPermissions('accessibility')
                              }
                            >
                              {t('Open Accessibility settings')}
                            </SettingsButton>
                          </>
                        )}
                      </div>
                      {capabilities?.platform === 'darwin' && (
                        <>
                          <SettingsSubRow
                            rowId="tools.show-the-app-being-operated"
                            label={t('Show the app being operated')}
                            description={t(
                              'While the AI works in an app in the background, a small floating window shows that app live. Close it any time.'
                            )}
                          >
                            <SettingsSwitch
                              checked={computerPreview}
                              onCheckedChange={setComputerPreview}
                            />
                          </SettingsSubRow>
                          <ComputerAllowedApps />
                        </>
                      )}
                    </>
                  )}
                </div>
              ) : null}
              {tool.id === 'browser' ? (
                <div>
                  <SettingsSubRow
                    rowId="tools.open-chat-links-in-the-built-in-browser"
                    label={t('Open chat links in the built-in browser')}
                    description={t(
                      'Clicking a web link in chat opens it in the side panel browser. {{key}}+Click opens it in the external browser.',
                      { key: IS_MAC ? 'Cmd' : 'Ctrl' }
                    )}
                  >
                    <SettingsSwitch
                      checked={openLinksInBuiltinBrowser}
                      onCheckedChange={setOpenLinksInBuiltinBrowser}
                    />
                  </SettingsSubRow>
                  <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pr-3 max-sm:pl-7">
                    {t(
                      'Cookies and site storage of the built-in browser, separate from the app itself.'
                    )}
                  </p>
                  <div className="flex flex-wrap gap-2 px-4 py-2.5 pl-10 max-sm:pr-3 max-sm:pl-7">
                    {(['cookies', 'cache', 'all'] as const).map((kind) => (
                      <SettingsButton key={kind} onClick={() => setPendingClear(kind)}>
                        {cleared === kind
                          ? t('Cleared')
                          : kind === 'cookies'
                            ? t('Clear cookies')
                            : kind === 'cache'
                              ? t('Clear cache')
                              : t('Clear all browsing data')}
                      </SettingsButton>
                    ))}
                  </div>
                </div>
              ) : null}
            </ToolRow>
          ))}
          {sectionExtras[section.id]}
        </SettingsSection>
      ))}

      <ComputerPermissionGuideDialog
        open={guideOpen}
        capabilities={capabilities}
        onOpenChange={setGuideOpen}
      />
      <ConfirmDialog
        open={pendingClear !== null}
        onOpenChange={(open) => {
          if (!open) setPendingClear(null);
        }}
        title={
          pendingClear === 'cookies'
            ? t('Clear cookies?')
            : pendingClear === 'cache'
              ? t('Clear cache?')
              : t('Clear all browsing data?')
        }
        description={t(
          'Cookies and site storage of the built-in browser, separate from the app itself.'
        )}
        confirmLabel={
          pendingClear === 'cookies'
            ? t('Clear cookies')
            : pendingClear === 'cache'
              ? t('Clear cache')
              : t('Clear all browsing data')
        }
        onConfirm={() => {
          if (pendingClear) void clear(pendingClear);
        }}
      />
    </SettingsPage>
  );
}

function DcgGuardRow() {
  const { t, locale } = useI18n();
  const enabled = useSettingsStore((state) => state.dcgEnabled);
  const setEnabled = useSettingsStore((state) => state.setDcgEnabled);
  const processGuard = useSettingsStore((state) => state.dcgProcessGuard);
  const setProcessGuard = useSettingsStore((state) => state.setDcgProcessGuard);
  const [status, setStatus] = useState<DcgStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmClearExemptions, setConfirmClearExemptions] = useState(false);
  const [update, setUpdate] = useState<DcgUpdateCheck | 'checking' | null>(null);
  const [cleared, setCleared] = useState<boolean | null>(null);
  const [exemptions, setExemptions] = useState<DcgRuleExemption[]>([]);
  const refreshExemptions = async () => {
    try {
      setExemptions(await window.electronAPI.dcg.listExemptions());
    } catch {
      /* 读不到就保持旧列表，不阻断主流程 */
    }
  };
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.dcg.status().then((next) => {
      if (!cancelled) setStatus(next);
    });
    void window.electronAPI.dcg
      .listExemptions()
      .then((list) => {
        if (!cancelled) setExemptions(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const run = async (action: 'install' | 'uninstall' | 'upgrade') => {
    setConfirmOpen(false);
    setBusy(true);
    if (action === 'upgrade') setUpgrading(true);
    setError(null);
    const result = await window.electronAPI.dcg[action === 'upgrade' ? 'install' : action]();
    setStatus(result.status);
    if (!result.ok) setError(result.error ?? t('Operation failed'));
    else {
      if (action !== 'uninstall') setEnabled(true);
      // 生效版本可能已变：按新版本重新拉豁免，避免展示旧版本的过时列表
      await refreshExemptions();
    }
    setBusy(false);
    setUpgrading(false);
  };
  const installed = status?.installed === true;
  // 升级前旧版兜底在跑：提示可升级到内置目标版本
  const upgradeAvailable =
    installed && status?.installedVersion != null && status.installedVersion !== status.version;
  // system.processes pack 只有 0.17.2+ 二进制认识；旧版传了会静默放行，干脆禁用开关
  const processGuardSupported =
    installed &&
    status?.installedVersion != null &&
    compareVersions(status.installedVersion, '0.17.2') >= 0;
  // 只在用户点击时请求 GitHub，不在加载时自动检查
  const checkUpdate = async () => {
    setUpdate('checking');
    try {
      setUpdate(await window.electronAPI.dcg.checkUpdate());
    } catch {
      setUpdate({ status: 'failed', current: status?.version ?? '', reason: 'network' });
    }
  };
  const clearExemptions = async () => {
    try {
      const ok = await window.electronAPI.dcg.clearExemptions();
      setCleared(ok);
      if (ok) setExemptions([]);
    } catch {
      setCleared(false);
    }
  };
  const revokeExemption = async (ruleId: string) => {
    setCleared(null);
    try {
      const next = await window.electronAPI.dcg.ruleRevoke(ruleId);
      if (next) setExemptions(next);
    } catch {
      setError(t('Operation failed'));
    }
  };
  const updateText =
    !update || update === 'checking'
      ? null
      : update.status === 'latest'
        ? t('Up to date (latest v{{latest}})', { latest: update.latest })
        : update.status === 'available'
          ? t(
              'dcg v{{latest}} is available (built-in v{{current}}). It can be installed after an EnsoCode update ships its checksum.',
              { latest: update.latest, current: update.current }
            )
          : update.reason === 'rate-limited'
            ? t('GitHub rate limit reached. Try again in an hour.')
            : update.reason === 'invalid'
              ? t('Could not read the latest dcg release.')
              : t('Could not reach GitHub. Check your network.');

  return (
    <ToolRow
      rowId="tools.dcgEnabled"
      newSession
      icon={ShieldX}
      title={t('Destructive command guard (dcg)')}
      description={t(
        'Check bash and PowerShell commands with dcg before running. Matches such as git reset --hard or recursive deletes always require your confirmation, even in full-access mode. Takes effect on new conversations.'
      )}
      control={
        <SettingsSwitch
          checked={enabled && installed}
          disabled={!installed}
          onCheckedChange={setEnabled}
        />
      }
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 pl-10 text-xs max-sm:pr-3 max-sm:pl-7">
        <span className="text-muted-foreground">
          {!status
            ? t('Loading…')
            : !status.supported
              ? t('Not available on this platform')
              : upgradeAvailable
                ? t('Installed v{{installed}} (v{{version}} available)', {
                    installed: status?.installedVersion ?? '',
                    version: status?.version ?? '',
                  })
                : installed
                  ? t('Installed v{{version}}', {
                      version: status?.installedVersion ?? status.version,
                    })
                  : t('Not installed')}
        </span>
        {status?.supported &&
          (installed ? (
            <>
              {upgradeAvailable && (
                <SettingsButton disabled={busy} onClick={() => void run('upgrade')}>
                  {upgrading
                    ? t('Upgrading…')
                    : t('Upgrade to v{{version}}', { version: status?.version ?? '' })}
                </SettingsButton>
              )}
              <SettingsButton disabled={busy} onClick={() => void run('uninstall')}>
                {t('Uninstall')}
              </SettingsButton>
            </>
          ) : (
            <SettingsButton disabled={busy} onClick={() => setConfirmOpen(true)}>
              {busy ? t('Installing…') : t('Install')}
            </SettingsButton>
          ))}
        {status?.supported && (
          <SettingsButton disabled={update === 'checking'} onClick={() => void checkUpdate()}>
            {update === 'checking' ? t('Checking for updates…') : t('Check for updates')}
          </SettingsButton>
        )}
        {updateText && <span className="text-muted-foreground">{updateText}</span>}
        {installed && (
          <SettingsButton onClick={() => setConfirmClearExemptions(true)}>
            {t('Clear rule exemptions')}
          </SettingsButton>
        )}
      </div>
      {installed && (
        <>
          <SettingsSubRow
            rowId="tools.dcgProcessGuard"
            label={t('Block mass process kills (system.processes)')}
            description={t(
              'Also check commands like pkill, killall and kill -1 that signal processes by pattern. New conversations only. Requires dcg v0.17.2 or later.'
            )}
          >
            <SettingsSwitch
              checked={processGuard && processGuardSupported}
              disabled={!processGuardSupported}
              onCheckedChange={setProcessGuard}
            />
          </SettingsSubRow>
          {!processGuardSupported && (
            <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pr-3 max-sm:pl-7">
              {t('Upgrade dcg to v0.17.2 or later to enable this.')}
            </p>
          )}
        </>
      )}
      {installed && (
        <div className="px-4 py-2.5 pl-10 text-xs max-sm:pr-3 max-sm:pl-7">
          <p className="font-medium">
            {t('Exempted rules')} ({exemptions.length})
          </p>
          {exemptions.length === 0 ? (
            <p className="text-muted-foreground">{t('No rule exemptions.')}</p>
          ) : (
            <ul className="mt-1.5">
              {exemptions.map((item) => {
                const label =
                  locale === 'zh'
                    ? explainDcgGuard({ ruleId: item.ruleId, reason: item.ruleId }).what
                    : item.ruleId;
                return (
                  <li key={item.ruleId} className="flex items-center justify-between gap-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-foreground">{label}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {item.ruleId} · {new Date(item.at).toLocaleString()}
                      </p>
                    </div>
                    <SettingsButton onClick={() => void revokeExemption(item.ruleId)}>
                      {t('Revoke')}
                    </SettingsButton>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {cleared !== null && (
        <p className="px-4 py-2.5 pl-10 text-muted-foreground text-xs max-sm:pr-3 max-sm:pl-7">
          {cleared ? t('Rule exemptions cleared.') : t('Operation failed')}
        </p>
      )}
      {error && (
        <p className="px-4 py-2.5 pl-10 text-destructive text-xs max-sm:pr-3 max-sm:pl-7">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmClearExemptions}
        onOpenChange={setConfirmClearExemptions}
        title={t('Clear rule exemptions?')}
        description={t('All exempted dcg rules will require confirmation again.')}
        confirmLabel={t('Clear rule exemptions')}
        onConfirm={() => void clearExemptions()}
      />
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md" zIndexLevel="nested">
          <DialogHeader>
            <DialogTitle>{t('Install dcg')}</DialogTitle>
            <DialogDescription>
              {t(
                'Downloads dcg v{{version}} from its GitHub release and verifies the checksum. dcg is a third-party tool, not part of EnsoCode.',
                { version: status?.version ?? '' }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex gap-2 rounded-md bg-destructive/8 p-3 text-sm ring-1 ring-destructive/32">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p>
                {t(
                  'dcg is licensed under MIT with an additional rider: no rights are granted to OpenAI, Anthropic, their affiliates, or anyone acting on their behalf. Install only if this restriction does not apply to you.'
                )}
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button size="sm" onClick={() => void run('install')}>
              {t('Agree and install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ToolRow>
  );
}

function ComputerPermissionGuideDialog({
  open,
  capabilities,
  onOpenChange,
}: {
  open: boolean;
  capabilities: ComputerCapabilities | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const kind = capabilities ? computerPermissionGuideKind(capabilities) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" zIndexLevel="nested">
        <DialogHeader>
          <DialogTitle>{t('Grant Computer permissions')}</DialogTitle>
          <DialogDescription>
            {kind === 'unsupported'
              ? t('This platform cannot operate the desktop yet.')
              : kind === 'ready'
                ? t('Computer is ready. Open sessions can use it from their next step.')
                : t(
                    'The agent can screenshot windows and control the mouse and keyboard. Grant Screen Recording and Accessibility to EnsoCode, then restart.'
                  )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {!capabilities && <p className="text-muted-foreground text-sm">{t('Loading…')}</p>}
          {kind === 'needs-permission' && (
            <div className="flex gap-2 rounded-md bg-destructive/8 p-3 text-sm ring-1 ring-destructive/32">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p>
                {t(
                  'Computer needs Screen Recording to capture windows and Accessibility to inspect or click them. Grant both to EnsoCode, then restart the app.'
                )}
              </p>
            </div>
          )}
          {capabilities?.platform === 'darwin' && kind !== 'unsupported' && (
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs">
                {t(
                  capabilities.capturePermission === 'granted'
                    ? 'Capture: granted'
                    : 'Capture: denied'
                )}
                {' · '}
                {t(
                  capabilities.axPermission === 'granted' ? 'Input/AX: granted' : 'Input/AX: denied'
                )}
                {capabilities.detail ? ` · ${capabilities.detail}` : ''}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void window.electronAPI.computer.openPermissions('screen')}
                >
                  {t('Open Screen Recording settings')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void window.electronAPI.computer.openPermissions('accessibility')}
                >
                  {t('Open Accessibility settings')}
                </Button>
              </div>
            </div>
          )}
        </DialogPanel>
        <DialogFooter className="sm:justify-end">
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t('Done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
