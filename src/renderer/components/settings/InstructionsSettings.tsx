import type { InstructionEntry } from '@shared/types';
import { FileText, HardDriveDownload, Link2, Pencil, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { InstructionEditDialog } from './InstructionEditDialog';
import { LocalAssetImportDialog } from './LocalAssetImportDialog';

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

export function InstructionsSettings() {
  const { t } = useI18n();
  const instructions = useSettingsStore((state) => state.instructions);
  const updateInstruction = useSettingsStore((state) => state.updateInstruction);
  const removeInstruction = useSettingsStore((state) => state.removeInstruction);
  const [importOpen, setImportOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<InstructionEntry | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="font-medium text-lg">{t('Instruction Files')}</h3>
          <p className="text-muted-foreground text-sm">
            {t('Global CLAUDE.md / AGENTS.md style files from local AI tools')}
          </p>
          <p className="text-muted-foreground text-xs">
            {t('Only one file is active at a time; enabling one disables the others')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          <HardDriveDownload className="mr-1.5 h-4 w-4" />
          {t('Import from local apps')}
        </Button>
      </div>

      {instructions.length === 0 ? (
        <div className="rounded-md border border-dashed px-3 py-8 text-center">
          <FileText className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 font-medium text-sm">{t('No instruction files yet')}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            {t('Import global instruction files configured in local AI tools')}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {instructions.map((instruction) => (
            <div
              key={instruction.id}
              className="group flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/50"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'shrink-0 font-medium text-sm',
                    !instruction.enabled && 'text-muted-foreground line-through'
                  )}
                >
                  {instruction.name}
                </span>
                <Badge variant="secondary" className="shrink-0 text-[11px]">
                  {instruction.source}
                </Badge>
                {!instruction.local && (
                  <Badge variant="outline" className="shrink-0 gap-1 text-[11px]">
                    <Link2 className="h-3 w-3" />
                    {t('Linked')}
                  </Badge>
                )}
                <span className="min-w-0 truncate text-muted-foreground text-xs">
                  {instruction.local
                    ? `${t('Local copy')} · ${formatBytes(instruction.bytes)}`
                    : `${instruction.sourcePath} · ${formatBytes(instruction.bytes)}`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Switch
                  checked={instruction.enabled}
                  onCheckedChange={(enabled) => updateInstruction(instruction.id, { enabled })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => setEditing(instruction)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  onClick={() => removeInstruction(instruction.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <LocalAssetImportDialog kind="instruction" open={importOpen} onOpenChange={setImportOpen} />
      <InstructionEditDialog instruction={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
