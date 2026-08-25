import type { CollectedProvider, LocalProviderScanResult, ScanCandidate } from '@shared/types';
import { CircleAlert, Download, RefreshCw } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
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
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';

type Phase = 'scanning' | 'select' | 'error' | 'done';

interface LocalImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LocalImportDialog({ open, onOpenChange }: LocalImportDialogProps) {
  const { t } = useI18n();
  const addProviders = useSettingsStore((state) => state.addProviders);

  const [phase, setPhase] = React.useState<Phase>('scanning');
  const [scan, setScan] = React.useState<LocalProviderScanResult | null>(null);
  const [checked, setChecked] = React.useState<Set<string>>(new Set());
  const [importedCount, setImportedCount] = React.useState(0);

  const runScan = React.useCallback(async () => {
    setPhase('scanning');
    setScan(null);
    try {
      const result = await window.electronAPI.providers.scanLocal();
      setScan(result);
      // 默认勾选未重复的候选
      setChecked(new Set(result.candidates.filter((c) => !c.duplicated).map((c) => c.id)));
      setPhase('select');
    } catch {
      setPhase('error');
    }
  }, []);

  React.useEffect(() => {
    if (open) {
      void runScan();
    }
  }, [open, runScan]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleImport = async () => {
    if (!scan || checked.size === 0) return;
    const collected: CollectedProvider[] = await window.electronAPI.providers.collectImport(
      scan.scanId,
      [...checked]
    );
    const toAdd = collected.map(({ candidateId: _candidateId, ...provider }) => ({
      ...provider,
      id: crypto.randomUUID(),
      enabled: true,
    }));
    const added = addProviders(toAdd);
    setImportedCount(added);
    setPhase('done');

    // 导入的 provider 常无模型列表（中转配置只存默认模型名）——对真正入库且无模型的后台拉取补全
    const store = useSettingsStore.getState();
    for (const provider of toAdd) {
      if (provider.models.length > 0) continue;
      if (!store.providers.some((p) => p.id === provider.id)) continue; // 被去重的跳过
      void window.electronAPI.providers
        .listModels({ api: provider.api, apiKey: provider.apiKey, baseUrl: provider.baseUrl })
        .then((result) => {
          if (result.ok && result.models.length > 0) {
            useSettingsStore.getState().updateProvider(provider.id, {
              models: result.models.map((id) => ({ id, enabled: true })),
            });
          }
        })
        .catch(() => {});
    }
  };

  const foundApps = scan?.apps.filter((app) => app.status !== 'not-found') ?? [];
  const candidatesByApp = React.useMemo(() => {
    const groups = new Map<string, ScanCandidate[]>();
    for (const candidate of scan?.candidates ?? []) {
      const list = groups.get(candidate.appName) ?? [];
      list.push(candidate);
      groups.set(candidate.appName, list);
    }
    return groups;
  }, [scan]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Import from local apps')}</DialogTitle>
          <DialogDescription>
            {t('Scan providers configured in local AI apps and import them.')}
          </DialogDescription>
        </DialogHeader>

        {phase === 'scanning' && (
          <DialogPanel>
            <div className="flex flex-col items-center gap-3 py-12">
              <Spinner className="size-5" />
              <p className="text-sm text-muted-foreground">{t('Scanning local apps...')}</p>
            </div>
          </DialogPanel>
        )}

        {phase === 'error' && (
          <DialogPanel>
            <div className="flex flex-col items-center gap-3 py-12">
              <CircleAlert className="h-5 w-5 text-destructive" />
              <p className="text-sm text-muted-foreground">{t('Scan failed')}</p>
              <Button variant="outline" size="sm" onClick={runScan}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('Rescan')}
              </Button>
            </div>
          </DialogPanel>
        )}

        {phase === 'select' && scan && (
          <>
            <DialogPanel className="max-h-[50vh] space-y-4">
              {foundApps.length === 0 && (
                <div className="rounded-md border border-dashed px-3 py-6 text-center">
                  <p className="text-sm font-medium">{t('No local apps detected')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(
                      'Supported: Claude Code, Codex, CC Switch, Alma, Cherry Studio, Hermes, OpenClaw, Grok CLI, Cursor'
                    )}
                  </p>
                </div>
              )}

              {[...candidatesByApp.entries()].map(([appName, candidates]) => (
                <div key={appName}>
                  <div className="mb-1 flex items-baseline gap-2 px-1">
                    <span className="text-xs font-medium text-muted-foreground">{appName}</span>
                    <span className="truncate text-[11px] text-muted-foreground/60">
                      {scan.apps.find((app) => app.appName === appName)?.configPath}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {candidates.map((candidate) => (
                      <label
                        key={candidate.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50',
                          candidate.duplicated && 'opacity-60'
                        )}
                      >
                        <Checkbox
                          checked={checked.has(candidate.id)}
                          onCheckedChange={() => toggle(candidate.id)}
                        />
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="shrink-0 text-sm font-medium">{candidate.name}</span>
                          <Badge variant="outline" className="shrink-0 text-[11px]">
                            {candidate.api}
                          </Badge>
                          {candidate.duplicated && (
                            <Badge variant="secondary" className="shrink-0 text-[11px]">
                              {t('Already exists')}
                            </Badge>
                          )}
                          <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                            {[
                              candidate.baseUrl,
                              candidate.apiKeyMasked,
                              candidate.modelIds.length > 0
                                ? t('{{count}} models', { count: candidate.modelIds.length })
                                : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              {foundApps.length > 0 && scan.candidates.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t('No importable providers found')}
                </p>
              )}
            </DialogPanel>

            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" size="sm" onClick={runScan}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('Rescan')}
              </Button>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {t('{{count}} selected', { count: checked.size })}
                </span>
                <Button size="sm" disabled={checked.size === 0} onClick={handleImport}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {t('Import selected')}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}

        {phase === 'done' && (
          <DialogPanel>
            <div className="flex flex-col items-center gap-3 py-12">
              <p className="text-sm font-medium">
                {t('Imported {{count}} providers', { count: importedCount })}
              </p>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                {t('Done')}
              </Button>
            </div>
          </DialogPanel>
        )}
      </DialogContent>
    </Dialog>
  );
}
