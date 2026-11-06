import { computerPermissionGuideKind } from '@shared/computer/permissionGuide';
import type { ComputerCapabilities } from '@shared/computer/types';
import { BUILTIN_TOOLS, EDIT_MODES, type EditMode, isEditMode } from '@shared/types';
import type { AgentMode } from '@shared/types/agent';
import type { BrowserClearKind } from '@shared/types/browser';
import type { DcgStatus } from '@shared/types/dcg';
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
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { IS_MAC } from '@/lib/keybindings';
import { useMaterializedProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { builtinToolsInSection, TOOL_SECTIONS, type ToolSectionId } from './builtinToolSections';
import { ComputerAllowedApps } from './ComputerAllowedApps';
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
    <div className="rounded-md border px-3 py-2.5" data-settings-row={rowId}>
      <div className="flex items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {title}
            {newSession && (
              <NewSessionBadge note={typeof newSession === 'string' ? newSession : undefined} />
            )}
          </p>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
        {control}
      </div>
      {children ? <div className="mt-2 space-y-2 pl-7">{children}</div> : null}
    </div>
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
    <div className="space-y-2" data-settings-row="tools.webSearchChain">
      <p className="text-muted-foreground text-xs">
        {t(
          "Try these models' built-in search in order. Credentials resolve at call time; if all fail, the keyless Exa service is the permanent fallback."
        )}
      </p>
      {chain.length === 0 && (
        <p className="text-muted-foreground text-xs">
          {t(
            "Default: use the current session model's built-in search when available, otherwise Exa."
          )}
        </p>
      )}
      {chain.map((entry, index) => (
        <div
          key={`${entry.providerId}/${entry.modelId}`}
          className="flex items-center gap-2 rounded-md border px-2 py-1.5"
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
        <div className="max-w-xs">
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
      <p className="text-muted-foreground text-xs">
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
    if (!computerEnabled) {
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
    if (!guideOpen) return;
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
          <Select
            items={Object.fromEntries(EDIT_MODES.map((mode) => [mode, t(EDIT_MODE_LABEL[mode])]))}
            value={editMode}
            onValueChange={(value) => {
              if (isEditMode(value)) setEditMode(value);
            }}
          >
            <SelectTrigger className="w-44 shrink-0" aria-label={t('File edit mode')}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {EDIT_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(EDIT_MODE_LABEL[mode])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    ),
    context: (
      <>
        <ToolRow
          icon={FoldVertical}
          newSession
          title={t('Explore fold')}
          description={t(
            'Let the agent mark exploratory reads and keep only a short report in later model context. Timeline stays intact.'
          )}
          control={<Switch checked={exploreFoldEnabled} onCheckedChange={setExploreFoldEnabled} />}
        />
        <ToolRow
          rowId="tools.rtkEnabled"
          newSession
          icon={Shrink}
          title={t('RTK command compression')}
          description={t(
            'Compress supported command output before it enters the model context. Takes effect on new conversations.'
          )}
          control={<Switch checked={rtkEnabled} onCheckedChange={setRtkEnabled} />}
        />
      </>
    ),
    safety: (
      <>
        <ToolRow
          icon={ShieldAlert}
          newSession
          title={t('Protected action confirmation')}
          description={t(
            'Even in full-access mode, ask before external sends, deletions, payments, deployments and secret-file access. Always on for Bot members not set to Full access. Takes effect on new conversations.'
          )}
          control={
            <Switch checked={protectedActionsInCode} onCheckedChange={setProtectedActionsInCode} />
          }
        />
        <DcgGuardRow />
      </>
    ),
  };

  return (
    <div className="space-y-8">
      <div data-settings-row="tools.root">
        <h3 className="font-medium text-lg">
          {t('Built-in tools')}
          <OccupancyEnabledTotal tokens={enabledTokens} />
        </h3>
        <p className="text-muted-foreground text-sm">
          {t('Toggle the built-in tools available to agents.')}
        </p>
      </div>

      {TOOL_SECTIONS.map((section) => (
        <section key={section.id} className="space-y-3">
          <h4 className="border-b pb-2 text-base font-semibold">{t(section.label)}</h4>
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
                  <Switch
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
                <div className="space-y-2" data-settings-row="tools.subagentModes">
                  {(
                    [
                      ['task', 'One-shot task agents'],
                      ['coworker', 'Persistent coworkers'],
                    ] as const
                  ).map(([mode, label]) => (
                    <div key={mode} className="flex items-center justify-between gap-4">
                      <span className="text-sm">{t(label)}</span>
                      <Switch
                        checked={subagentAllowedModes.includes(mode)}
                        disabled={!subagentEnabled}
                        onCheckedChange={(checked) => setMode(mode, checked)}
                      />
                    </div>
                  ))}
                  {!subagentEnabled && (
                    <p className="text-muted-foreground text-xs">
                      {t(
                        'The unified subagent tool is off. Re-enabling it keeps this mode selection.'
                      )}
                    </p>
                  )}
                </div>
              ) : null}
              {tool.id === 'computer' && computerEnabled ? (
                <div className="space-y-2" data-settings-row="tools.computer">
                  {capabilities && computerPermissionGuideKind(capabilities) === 'unsupported' ? (
                    <p className="text-muted-foreground text-xs">
                      {t('This platform cannot operate the desktop yet.')}
                    </p>
                  ) : (
                    <>
                      {capabilities?.platform === 'darwin' && (
                        <p className="text-muted-foreground text-xs">
                          {t(
                            'Computer needs Screen Recording to capture windows and Accessibility to inspect or click them. Grant both to EnsoCode, then restart the app.'
                          )}
                        </p>
                      )}
                      {capabilities && (
                        <p className="text-muted-foreground text-xs">
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
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={() => setGuideOpen(true)}>
                          {t('Show permission guide')}
                        </Button>
                        {capabilities?.platform === 'darwin' && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                void window.electronAPI.computer.openPermissions('screen')
                              }
                            >
                              {t('Open Screen Recording settings')}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                void window.electronAPI.computer.openPermissions('accessibility')
                              }
                            >
                              {t('Open Accessibility settings')}
                            </Button>
                          </>
                        )}
                      </div>
                      {capabilities?.platform === 'darwin' && (
                        <>
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium text-sm">
                                {t('Show the app being operated')}
                              </div>
                              <p className="text-muted-foreground text-xs">
                                {t(
                                  'While the AI works in an app in the background, a small floating window shows that app live. Close it any time.'
                                )}
                              </p>
                            </div>
                            <Switch
                              checked={computerPreview}
                              onCheckedChange={setComputerPreview}
                            />
                          </div>
                          <ComputerAllowedApps />
                        </>
                      )}
                    </>
                  )}
                </div>
              ) : null}
              {tool.id === 'browser' ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-sm">
                        {t('Open chat links in the built-in browser')}
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {t(
                          'Clicking a web link in chat opens it in the side panel browser. {{key}}+Click opens it in the external browser.',
                          { key: IS_MAC ? 'Cmd' : 'Ctrl' }
                        )}
                      </p>
                    </div>
                    <Switch
                      checked={openLinksInBuiltinBrowser}
                      onCheckedChange={setOpenLinksInBuiltinBrowser}
                    />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {t(
                      'Cookies and site storage of the built-in browser, separate from the app itself.'
                    )}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(['cookies', 'cache', 'all'] as const).map((kind) => (
                      <Button
                        key={kind}
                        variant="outline"
                        size="sm"
                        onClick={() => void clear(kind)}
                      >
                        {cleared === kind
                          ? t('Cleared')
                          : kind === 'cookies'
                            ? t('Clear cookies')
                            : kind === 'cache'
                              ? t('Clear cache')
                              : t('Clear all browsing data')}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
            </ToolRow>
          ))}
          {sectionExtras[section.id]}
        </section>
      ))}

      <ComputerPermissionGuideDialog
        open={guideOpen}
        capabilities={capabilities}
        onOpenChange={setGuideOpen}
      />
    </div>
  );
}

function DcgGuardRow() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.dcgEnabled);
  const setEnabled = useSettingsStore((state) => state.setDcgEnabled);
  const [status, setStatus] = useState<DcgStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.dcg.status().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const run = async (action: 'install' | 'uninstall') => {
    setConfirmOpen(false);
    setBusy(true);
    setError(null);
    const result = await window.electronAPI.dcg[action]();
    setStatus(result.status);
    if (!result.ok) setError(result.error ?? t('Operation failed'));
    else setEnabled(action === 'install');
    setBusy(false);
  };
  const installed = status?.installed === true;

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
        <Switch checked={enabled && installed} disabled={!installed} onCheckedChange={setEnabled} />
      }
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          {!status
            ? t('Loading…')
            : !status.supported
              ? t('Not available on this platform')
              : installed
                ? t('Installed v{{version}}', { version: status.version })
                : t('Not installed')}
        </span>
        {status?.supported &&
          (installed ? (
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => void run('uninstall')}
            >
              {t('Uninstall')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => setConfirmOpen(true)}
            >
              {busy ? t('Installing…') : t('Install')}
            </Button>
          ))}
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
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
            <div className="flex gap-2 rounded-md border border-destructive/32 bg-destructive/8 p-3 text-sm">
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
            <div className="flex gap-2 rounded-md border border-destructive/32 bg-destructive/8 p-3 text-sm">
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
