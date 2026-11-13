import type { ConfigSyncMode, ConfigSyncOpenResult, ConfigSyncSummary } from '@shared/types';
import {
  CircleAlert,
  CircleCheck,
  Download,
  FileArchive,
  Info,
  Loader2,
  LockKeyhole,
  ShieldAlert,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import * as React from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Radio, RadioGroup } from '@/components/ui/radio-group';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

type ImportPhase = 'password' | 'preview' | 'success';

const CATEGORIES: Array<{ category: ConfigSyncSummary['category']; label: string }> = [
  { category: 'providers', label: 'Model Providers' },
  { category: 'presets', label: 'Presets' },
  { category: 'agentTypes', label: 'Agent types' },
  { category: 'skills', label: 'Skills' },
  { category: 'mcpServers', label: 'MCP Servers' },
  { category: 'instructions', label: 'Instruction Files' },
  { category: 'subagentModels', label: 'Subagent Models' },
  { category: 'settings', label: 'Scalar settings' },
];

export function ConfigSyncSettings() {
  const { t } = useI18n();
  const [exportOpen, setExportOpen] = React.useState(false);
  const [openingImport, setOpeningImport] = React.useState(false);
  const [openImportMessage, setOpenImportMessage] = React.useState<{
    kind: 'cancelled' | 'error';
    text: string;
  } | null>(null);
  const [importFile, setImportFile] = React.useState<Extract<
    ConfigSyncOpenResult,
    { ok: true }
  > | null>(null);

  const startExport = () => {
    setOpenImportMessage(null);
    setExportOpen(true);
  };

  const startImport = async () => {
    setOpeningImport(true);
    setOpenImportMessage(null);
    try {
      const result = await window.electronAPI.configSync.openImport();
      if (!result.ok) {
        setOpenImportMessage({
          kind: result.cancelled ? 'cancelled' : 'error',
          text: result.cancelled ? t('Import cancelled.') : t(result.error),
        });
        return;
      }
      setImportFile(result);
    } catch {
      setOpenImportMessage({ kind: 'error', text: t('Could not open configuration package.') });
    } finally {
      setOpeningImport(false);
    }
  };

  return (
    <section className="space-y-3" data-settings-row="general.configSync">
      <div>
        <h4 className="text-sm font-medium">{t('Configuration transfer')}</h4>
        <p className="text-xs text-muted-foreground">
          {t(
            'Move models, presets, agent types, skills, MCP servers and instruction files between devices.'
          )}
        </p>
      </div>

      <div className="rounded-md border px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <FileArchive className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{t('Portable Enso configuration')}</p>
              <p className="text-xs text-muted-foreground">
                {t('Export a package or preview one before importing it.')}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" disabled={openingImport} onClick={startImport}>
              {openingImport ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {t('Import configuration')}
            </Button>
            <Button size="sm" disabled={openingImport} onClick={startExport}>
              <Upload className="h-3.5 w-3.5" />
              {t('Export configuration')}
            </Button>
          </div>
        </div>
        <div className="mt-3 flex items-start gap-2 border-t pt-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            {t(
              'OAuth login sessions are never transferred. Skill, instruction, and system prompt contents require an encrypted export.'
            )}
          </p>
        </div>
        {openImportMessage && (
          <p
            className={
              openImportMessage.kind === 'error'
                ? 'mt-2 text-xs text-destructive'
                : 'mt-2 text-xs text-muted-foreground'
            }
            role={openImportMessage.kind === 'error' ? 'alert' : 'status'}
          >
            {openImportMessage.text}
          </p>
        )}
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      {importFile && <ImportDialog file={importFile} onClose={() => setImportFile(null)} />}
    </section>
  );
}

function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [includeSecrets, setIncludeSecrets] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [cancelled, setCancelled] = React.useState(false);
  const [filePath, setFilePath] = React.useState<string | null>(null);
  const [skippedInstructions, setSkippedInstructions] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!open) return;
    setIncludeSecrets(false);
    setPassword('');
    setConfirmation('');
    setBusy(false);
    setError(null);
    setCancelled(false);
    setFilePath(null);
    setSkippedInstructions([]);
  }, [open]);

  const close = () => {
    if (busy) return;
    setPassword('');
    setConfirmation('');
    onOpenChange(false);
  };

  const exportConfig = async () => {
    if (includeSecrets && password.length < 8) {
      setError(t('Password must be at least 8 characters.'));
      return;
    }
    if (includeSecrets && password !== confirmation) {
      setError(t('Passwords do not match.'));
      return;
    }

    setBusy(true);
    setError(null);
    setCancelled(false);
    try {
      const result = await window.electronAPI.configSync.exportConfig({
        includeSecrets,
        ...(includeSecrets ? { password } : {}),
      });
      setPassword('');
      setConfirmation('');
      if (!result.ok) {
        if (result.cancelled) setCancelled(true);
        else setError(t(result.error));
        return;
      }
      setFilePath(result.filePath);
      setSkippedInstructions(result.skippedInstructions ?? []);
    } catch {
      setPassword('');
      setConfirmation('');
      setError(t('Could not export configuration.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t('Export configuration')}</DialogTitle>
          <DialogDescription>
            {t('Create a portable .enso-config package for another device.')}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="max-h-[55vh] space-y-4">
          {filePath ? (
            <>
              <Alert variant="success">
                <CircleCheck />
                <AlertTitle>{t('Configuration exported')}</AlertTitle>
                <AlertDescription>
                  <p>{t('Saved package:')}</p>
                  <p className="break-all font-mono text-xs text-foreground">{filePath}</p>
                </AlertDescription>
              </Alert>
              {skippedInstructions.length > 0 && (
                <Alert variant="warning">
                  <TriangleAlert />
                  <AlertDescription>
                    <p>
                      {t(
                        'These instructions were skipped because their source files are missing or unreadable:'
                      )}
                    </p>
                    <p className="break-all text-foreground">{skippedInstructions.join(', ')}</p>
                  </AlertDescription>
                </Alert>
              )}
            </>
          ) : (
            <>
              <Alert variant="warning">
                <ShieldAlert />
                <AlertTitle>{t('File contents can be private')}</AlertTitle>
                <AlertDescription>
                  {t(
                    'Skill and instruction file contents may contain private data, so configurations containing them can only be exported with encryption.'
                  )}
                </AlertDescription>
              </Alert>

              <label className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5">
                <Checkbox
                  checked={includeSecrets}
                  onCheckedChange={(checked) => {
                    const next = checked === true;
                    setIncludeSecrets(next);
                    setError(null);
                    if (!next) {
                      setPassword('');
                      setConfirmation('');
                    }
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {t('Include sensitive configuration')}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t(
                      'Encrypt the entire package with a password. OAuth login sessions are still excluded.'
                    )}
                  </span>
                </span>
              </label>

              {!includeSecrets && (
                <Alert variant="info">
                  <Info />
                  <AlertDescription>
                    {t(
                      'API keys, provider account links, MCP arguments and environment values, plus credentials and private URL parts in MCP endpoints, will be omitted. Configurations containing skill or instruction files require encryption.'
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {includeSecrets && (
                <div className="space-y-3 rounded-md border px-3 py-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <LockKeyhole className="h-4 w-4 text-muted-foreground" />
                    {t('Encryption password')}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="config-export-password">{t('Password')}</Label>
                      <Input
                        id="config-export-password"
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        aria-invalid={Boolean(error && password.length < 8)}
                        onChange={(event) => {
                          setPassword(event.target.value);
                          setError(null);
                        }}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="config-export-confirmation">{t('Confirm password')}</Label>
                      <Input
                        id="config-export-confirmation"
                        type="password"
                        autoComplete="new-password"
                        value={confirmation}
                        aria-invalid={Boolean(error && confirmation !== password)}
                        onChange={(event) => {
                          setConfirmation(event.target.value);
                          setError(null);
                        }}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('Use at least 8 characters. This password cannot be recovered.')}
                  </p>
                </div>
              )}

              {cancelled && (
                <p className="text-xs text-muted-foreground" role="status">
                  {t('Export cancelled.')}
                </p>
              )}
              {error && (
                <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
                  <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                  {error}
                </p>
              )}
            </>
          )}
        </DialogPanel>

        <DialogFooter>
          {filePath ? (
            <Button size="sm" onClick={close}>
              {t('Done')}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={close}>
                {t('Cancel')}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void exportConfig()}>
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {busy ? t('Exporting…') : t('Export')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  file,
  onClose,
}: {
  file: Extract<ConfigSyncOpenResult, { ok: true }>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = React.useState<ImportPhase>(file.encrypted ? 'password' : 'preview');
  const [password, setPassword] = React.useState('');
  const [mode, setMode] = React.useState<ConfigSyncMode>('merge');
  const [summary, setSummary] = React.useState<ConfigSyncSummary[] | null>(null);
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [backupPath, setBackupPath] = React.useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = React.useState(false);
  const [busy, setBusy] = React.useState<'preview' | 'commit' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmationOpen, setConfirmationOpen] = React.useState(false);
  const requestId = React.useRef(0);

  const preview = React.useCallback(
    async (nextMode: ConfigSyncMode, initialPassword?: string) => {
      const currentRequest = ++requestId.current;
      setBusy('preview');
      setError(null);
      setSummary(null);
      setWarnings([]);
      try {
        const result = await window.electronAPI.configSync.previewImport({
          token: file.token,
          mode: nextMode,
          ...(initialPassword ? { password: initialPassword } : {}),
        });
        if (currentRequest !== requestId.current) return;
        setPassword('');
        if (!result.ok) {
          setError(t(result.error));
          return;
        }
        setMode(result.mode);
        setSummary(result.summary);
        setWarnings(result.warnings);
        setPhase('preview');
      } catch {
        if (currentRequest === requestId.current) {
          setPassword('');
          setError(t('Could not preview configuration package.'));
        }
      } finally {
        if (currentRequest === requestId.current) setBusy(null);
      }
    },
    [file.token, t]
  );

  React.useEffect(() => {
    if (!file.encrypted) void preview('merge');
  }, [file.encrypted, preview]);

  const close = () => {
    if (busy) return;
    requestId.current += 1;
    setConfirmationOpen(false);
    setPassword('');
    void window.electronAPI.configSync.cancelImport(file.token).catch(() => undefined);
    onClose();
  };

  const changeMode = (nextMode: ConfigSyncMode) => {
    if (nextMode === mode || busy) return;
    setMode(nextMode);
    void preview(nextMode);
  };

  const hasImportedExecutableResources = Boolean(
    summary?.some(
      (item) =>
        (item.category === 'skills' || item.category === 'mcpServers') &&
        item.added + item.updated + item.skipped > 0
    )
  );
  // 任何包都可能改动可迁移偏好，因此每次导入都需要显式的信任确认。
  const requiresFinalConfirmation = summary !== null;

  const commit = async () => {
    if (!summary) return;
    setBusy('commit');
    setError(null);
    try {
      const result = await window.electronAPI.configSync.commitImport({ token: file.token, mode });
      if (!result.ok) {
        setSummary(null);
        setWarnings([]);
        setError(t(result.error));
        return;
      }
      setPassword('');
      try {
        await useSettingsStore.persist.rehydrate();
      } catch {
        setRefreshFailed(true);
      }
      setWarnings(result.warnings);
      setBackupPath(result.backupPath);
      setPhase('success');
    } catch {
      setSummary(null);
      setWarnings([]);
      setError(t('Could not import configuration.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-2xl" showCloseButton={busy === null}>
        <DialogHeader>
          <DialogTitle>
            {phase === 'success' ? t('Configuration imported') : t('Import configuration')}
          </DialogTitle>
          <DialogDescription>
            {phase === 'success'
              ? refreshFailed
                ? t('Configuration was imported, but this window could not refresh automatically.')
                : t('This window has been refreshed with the imported settings.')
              : t('Review {{fileName}} before changing this device.', { fileName: file.fileName })}
          </DialogDescription>
        </DialogHeader>

        {phase === 'password' && (
          <DialogPanel className="space-y-4">
            <Alert variant="info">
              <LockKeyhole />
              <AlertTitle>{t('Encrypted configuration package')}</AlertTitle>
              <AlertDescription>
                {t('Enter the export password to decrypt and preview this package.')}
              </AlertDescription>
            </Alert>
            <div className="space-y-1.5">
              <Label htmlFor="config-import-password">{t('Password')}</Label>
              <Input
                id="config-import-password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && password.length > 0 && !busy) {
                    void preview('merge', password);
                  }
                }}
              />
            </div>
            {error && (
              <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
                <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                {error}
              </p>
            )}
          </DialogPanel>
        )}

        {phase === 'preview' && (
          <DialogPanel className="max-h-[58vh] space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('Import mode')}</p>
              <RadioGroup
                value={mode}
                onValueChange={(value) => changeMode(value as ConfigSyncMode)}
                className="grid gap-2 sm:grid-cols-2"
                aria-label={t('Import mode')}
              >
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5">
                  <Radio value="merge" disabled={busy !== null} />
                  <span>
                    <span className="block text-sm font-medium">{t('Merge')}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t('Add and update matching items while keeping items only on this device.')}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5">
                  <Radio value="replace" disabled={busy !== null} />
                  <span>
                    <span className="block text-sm font-medium">{t('Replace')}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t('Replace transferred item categories, removing local-only items in them.')}
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </div>

            {busy === 'preview' && (
              <div className="flex items-center justify-center gap-2 rounded-md border border-dashed py-10">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{t('Preparing preview…')}</span>
              </div>
            )}

            {!busy && summary && (
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        {t('Category')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        {t('Added')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        {t('Updated')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        {t('Skipped')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        {t('Removed')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {CATEGORIES.map(({ category, label }) => {
                      const row = summary.find((item) => item.category === category);
                      return (
                        <tr key={category} className="border-t first:border-t-0">
                          <th scope="row" className="px-3 py-2 text-left font-medium">
                            {t(label)}
                          </th>
                          <td className="px-3 py-2 text-right tabular-nums">{row?.added ?? 0}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{row?.updated ?? 0}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{row?.skipped ?? 0}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{row?.removed ?? 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!busy && summary?.find((item) => item.category === 'settings')?.fields?.length ? (
              <p className="text-xs text-muted-foreground">
                {t('Portable settings changed:')}{' '}
                {summary.find((item) => item.category === 'settings')?.fields?.join(', ')}
              </p>
            ) : null}

            {mode === 'replace' && summary && !busy && (
              <Alert variant="error">
                <TriangleAlert />
                <AlertTitle>{t('Local-only configuration will be deleted')}</AlertTitle>
                <AlertDescription>
                  {t(
                    'Items in transferred collections that exist only on this device will be removed. Removed counts are shown above. Included portable preferences are overwritten. A complete backup is created first.'
                  )}
                </AlertDescription>
              </Alert>
            )}

            {warnings.map((warning) => (
              <Alert key={warning} variant="warning">
                <TriangleAlert />
                <AlertDescription>{t(warning)}</AlertDescription>
              </Alert>
            ))}

            {summary && !busy && (
              <Alert variant="warning">
                <ShieldAlert />
                <AlertTitle>{t('Only import packages you trust')}</AlertTitle>
                <AlertDescription>
                  {t(
                    'An imported package can change portable preferences and configuration. Skills and MCP servers may also run commands later when you use them. Previewing does not execute them; continue only if you trust the package.'
                  )}
                </AlertDescription>
              </Alert>
            )}

            {error && (
              <Alert variant="error">
                <CircleAlert />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </DialogPanel>
        )}

        {phase === 'success' && backupPath && (
          <DialogPanel className="space-y-4">
            <Alert variant="success">
              <CircleCheck />
              <AlertTitle>{t('Import complete')}</AlertTitle>
              <AlertDescription>
                <p>{t('Backup of previous settings:')}</p>
                <p className="break-all font-mono text-xs text-foreground">{backupPath}</p>
              </AlertDescription>
            </Alert>
            {refreshFailed && (
              <Alert variant="warning">
                <TriangleAlert />
                <AlertDescription>
                  {t('Reopen Settings to load the imported configuration in this window.')}
                </AlertDescription>
              </Alert>
            )}
            {warnings.map((warning) => (
              <Alert key={warning} variant="warning">
                <TriangleAlert />
                <AlertDescription>{t(warning)}</AlertDescription>
              </Alert>
            ))}
          </DialogPanel>
        )}

        <DialogFooter>
          {phase === 'password' && (
            <>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={close}>
                {t('Cancel')}
              </Button>
              <Button
                size="sm"
                disabled={busy !== null || password.length === 0}
                onClick={() => void preview('merge', password)}
              >
                {busy === 'preview' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('Preview')}
              </Button>
            </>
          )}
          {phase === 'preview' && (
            <>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={close}>
                {t('Cancel')}
              </Button>
              {error && !summary ? (
                <Button size="sm" disabled={busy !== null} onClick={() => void preview(mode)}>
                  {t('Refresh preview')}
                </Button>
              ) : (
                <Button
                  variant={mode === 'replace' ? 'destructive' : 'default'}
                  size="sm"
                  disabled={busy !== null || !summary}
                  onClick={() => {
                    if (!summary) return;
                    if (requiresFinalConfirmation) setConfirmationOpen(true);
                    else void commit();
                  }}
                >
                  {busy === 'commit' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {busy === 'commit' ? t('Importing…') : t('Import')}
                </Button>
              )}
            </>
          )}
          {phase === 'success' && (
            <Button size="sm" onClick={close}>
              {t('Done')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      <ImportConfirmationDialog
        open={confirmationOpen}
        mode={mode}
        hasImportedExecutableResources={hasImportedExecutableResources}
        onOpenChange={setConfirmationOpen}
        onConfirm={() => void commit()}
      />
    </Dialog>
  );
}

function ImportConfirmationDialog({
  open,
  mode,
  hasImportedExecutableResources,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  mode: ConfigSyncMode;
  hasImportedExecutableResources: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup className="sm:max-w-md" zIndexLevel="nested">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-start gap-2 text-base">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            {t('Confirm configuration import')}
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              {t(
                'This package can change portable preferences and configuration. Continue only if you trust this package.'
              )}
            </span>
            {hasImportedExecutableResources && (
              <span className="block">
                {t(
                  'It includes skills or MCP servers that may execute commands when you use them.'
                )}
              </span>
            )}
            {mode === 'replace' && (
              <span className="block">
                {t(
                  'Replace mode removes local-only items from transferred collections and overwrites included portable preferences. A complete backup will be created first.'
                )}
              </span>
            )}
            <span className="block">{t('Do you want to continue with this import?')}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter variant="bare">
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            {t('Cancel')}
          </AlertDialogClose>
          <Button
            variant={mode === 'replace' ? 'destructive' : 'default'}
            size="sm"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {t('Confirm import')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
