import type { AssetCandidate, LocalAssetScanResult } from '@shared/types';
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

interface LocalAssetImportDialogProps {
  kind: 'skill' | 'mcp' | 'instruction';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

export function LocalAssetImportDialog({ kind, open, onOpenChange }: LocalAssetImportDialogProps) {
  const { t } = useI18n();
  const addSkills = useSettingsStore((state) => state.addSkills);
  const addMcpServers = useSettingsStore((state) => state.addMcpServers);
  const addInstructions = useSettingsStore((state) => state.addInstructions);

  const [phase, setPhase] = React.useState<Phase>('scanning');
  const [scan, setScan] = React.useState<LocalAssetScanResult | null>(null);
  const [checked, setChecked] = React.useState<Set<string>>(new Set());
  const [importedCount, setImportedCount] = React.useState(0);

  const runScan = React.useCallback(async () => {
    setPhase('scanning');
    setScan(null);
    try {
      const result = await window.electronAPI.assets.scanLocal();
      setScan(result);
      setChecked(
        new Set(
          result.candidates
            .filter((candidate) => candidate.kind === kind && !candidate.duplicated)
            .map((candidate) => candidate.id)
        )
      );
      setPhase('select');
    } catch {
      setPhase('error');
    }
  }, [kind]);

  React.useEffect(() => {
    if (open) void runScan();
  }, [open, runScan]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleImport = async () => {
    if (!scan || checked.size === 0) return;
    const collected = await window.electronAPI.assets.collectImport(scan.scanId, [...checked]);

    let added = 0;
    if (kind === 'skill') {
      added = addSkills(
        collected
          .filter((item) => item.kind === 'skill')
          .map(({ candidateId: _candidateId, kind: _kind, ...skill }) => ({
            ...skill,
            id: crypto.randomUUID(),
            enabled: true,
          }))
      );
    } else if (kind === 'mcp') {
      added = addMcpServers(
        collected
          .filter((item) => item.kind === 'mcp')
          .map(({ candidateId: _candidateId, kind: _kind, ...server }) => ({
            ...server,
            id: crypto.randomUUID(),
            enabled: true,
          }))
      );
    } else {
      const entries: import('@shared/types').InstructionEntry[] = [];
      for (const item of collected) {
        if (item.kind !== 'instruction') continue;
        const id = crypto.randomUUID();
        // 有源文件的先保持链接；无文件来源立即写成本地副本
        const local = !item.sourcePath;
        if (local && item.content) {
          await window.electronAPI.instructions.write(id, item.content);
        }
        entries.push({
          id,
          name: item.name,
          source: item.source,
          sourcePath: item.sourcePath,
          local,
          bytes: item.bytes,
          enabled: true,
        });
      }
      added = addInstructions(entries);
    }
    setImportedCount(added);
    setPhase('done');
  };

  const candidates = React.useMemo(
    () => (scan?.candidates ?? []).filter((candidate) => candidate.kind === kind),
    [scan, kind]
  );

  const byGroup = React.useMemo(() => {
    const groups = new Map<string, AssetCandidate[]>();
    for (const candidate of candidates) {
      const list = groups.get(candidate.groupName) ?? [];
      list.push(candidate);
      groups.set(candidate.groupName, list);
    }
    return groups;
  }, [candidates]);

  const foundSources = scan?.sources.filter((source) => source.status !== 'not-found') ?? [];
  const title =
    kind === 'skill'
      ? t('Import skills from local apps')
      : kind === 'mcp'
        ? t('Import MCP servers')
        : t('Import instruction files');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t('Scan local AI apps and register the entries you want to reuse.')}
          </DialogDescription>
        </DialogHeader>

        {phase === 'scanning' && (
          <DialogPanel>
            <div className="flex flex-col items-center gap-3 py-12">
              <Spinner className="size-5" />
              <p className="text-muted-foreground text-sm">{t('Scanning local apps...')}</p>
            </div>
          </DialogPanel>
        )}

        {phase === 'error' && (
          <DialogPanel>
            <div className="flex flex-col items-center gap-3 py-12">
              <CircleAlert className="h-5 w-5 text-destructive" />
              <p className="text-muted-foreground text-sm">{t('Scan failed')}</p>
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
              {foundSources.length === 0 && (
                <div className="rounded-md border border-dashed px-3 py-6 text-center">
                  <p className="font-medium text-sm">{t('No local apps detected')}</p>
                </div>
              )}

              {[...byGroup.entries()].map(([groupName, items]) => (
                <div key={groupName}>
                  <div className="mb-1 px-1">
                    <span className="font-medium text-muted-foreground text-xs">{groupName}</span>
                  </div>
                  <div className="space-y-0.5">
                    {items.map((candidate) => (
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
                          <span className="shrink-0 font-medium text-sm">{candidate.name}</span>
                          {candidate.kind === 'mcp' && (
                            <Badge variant="outline" className="shrink-0 text-[11px]">
                              {candidate.transport}
                            </Badge>
                          )}
                          {candidate.duplicated && (
                            <Badge variant="secondary" className="shrink-0 text-[11px]">
                              {candidate.duplicateReason === 'same-content'
                                ? t('Same content')
                                : candidate.duplicateReason === 'same-name'
                                  ? t('Same name')
                                  : t('Already exists')}
                            </Badge>
                          )}
                          <span className="min-w-0 flex-1 truncate text-right text-muted-foreground text-xs">
                            {candidate.kind === 'skill'
                              ? candidate.description || candidate.path
                              : candidate.kind === 'instruction'
                                ? `${candidate.location} · ${formatBytes(candidate.bytes)}`
                                : [
                                    candidate.summary,
                                    candidate.envKeys.length > 0
                                      ? t('{{count}} env vars', { count: candidate.envKeys.length })
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

              {foundSources.length > 0 && candidates.length === 0 && (
                <p className="py-6 text-center text-muted-foreground text-sm">
                  {t('Nothing importable found')}
                </p>
              )}
            </DialogPanel>

            <DialogFooter className="sm:justify-between">
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={runScan}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  {t('Rescan')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setChecked(new Set(candidates.map((c) => c.id)))}
                >
                  {t('Select all')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setChecked(new Set())}>
                  {t('Deselect all')}
                </Button>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground text-xs">
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
              <p className="font-medium text-sm">
                {t('Imported {{count}} entries', { count: importedCount })}
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
