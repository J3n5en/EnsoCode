import { computerPermissionGuideKind } from '@shared/computer/permissionGuide';
import type { ComputerCapabilities } from '@shared/computer/types';
import { BUILTIN_TOOLS, EDIT_MODES, type EditMode, isEditMode } from '@shared/types';
import type { AgentMode } from '@shared/types/agent';
import type { BrowserClearKind } from '@shared/types/browser';
import {
  Box,
  Brain,
  ClipboardList,
  FilePenLine,
  FoldVertical,
  Globe,
  ListTodo,
  type LucideIcon,
  MessageCircleQuestion,
  Monitor,
  Search,
  ShieldAlert,
  Shrink,
  SquareTerminal,
  TriangleAlert,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
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
import { useSettingsStore } from '@/stores/settings';
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
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  control?: ReactNode;
  children?: ReactNode;
  rowId?: string;
}) {
  return (
    <div className="rounded-md border px-3 py-2.5" data-settings-row={rowId}>
      <div className="flex items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
        {control}
      </div>
      {children ? <div className="mt-2 space-y-2 pl-7">{children}</div> : null}
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

  return (
    <div className="space-y-6">
      <div data-settings-row="tools.root">
        <h3 className="font-medium text-lg">
          {t('Built-in tools')}
          <OccupancyEnabledTotal tokens={enabledTokens} />
        </h3>
        <p className="text-muted-foreground text-sm">
          {t('Toggle the built-in tools available to agents.')}
        </p>
      </div>

      <div className="space-y-2">
        {BUILTIN_TOOLS.map((tool) => (
          <ToolRow
            key={tool.id}
            icon={TOOL_ICON[tool.id] ?? Wrench}
            title={t(tool.name)}
            description={t(tool.description)}
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
                  </>
                )}
              </div>
            ) : null}
            {tool.id === 'browser' ? (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs">
                  {t(
                    'Cookies and site storage of the built-in browser, separate from the app itself.'
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(['cookies', 'cache', 'all'] as const).map((kind) => (
                    <Button key={kind} variant="outline" size="sm" onClick={() => void clear(kind)}>
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

        <ComputerPermissionGuideDialog
          open={guideOpen}
          capabilities={capabilities}
          onOpenChange={setGuideOpen}
        />

        <ToolRow
          icon={FoldVertical}
          title={t('Explore fold')}
          description={t(
            'Let the agent mark exploratory reads and keep only a short report in later model context. Timeline stays intact.'
          )}
          control={<Switch checked={exploreFoldEnabled} onCheckedChange={setExploreFoldEnabled} />}
        />

        <ToolRow
          rowId="tools.rtkEnabled"
          icon={Shrink}
          title={t('RTK command compression')}
          description={t(
            'Compress supported command output before it enters the model context. Takes effect on new conversations.'
          )}
          control={<Switch checked={rtkEnabled} onCheckedChange={setRtkEnabled} />}
        />

        <ToolRow
          icon={ShieldAlert}
          title={t('Protected action confirmation')}
          description={t(
            'Even in full-access mode, ask before external sends, deletions, payments, deployments and secret-file access. Always on for Bot members not set to Full access. Takes effect on new conversations.'
          )}
          control={
            <Switch checked={protectedActionsInCode} onCheckedChange={setProtectedActionsInCode} />
          }
        />

        <ToolRow
          rowId="tools.editMode"
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
      </div>
    </div>
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
                ? t('Computer is ready. Start a new session to use it.')
                : t(
                    'The agent can screenshot windows and control the mouse and keyboard. Grant Screen Recording and Accessibility to EnsoCode, then restart. Only new sessions pick up the tool.'
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
