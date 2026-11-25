import type { InstructionEntry } from '@shared/types';
import { FileText, HardDriveDownload, Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { InstructionEditDialog } from './InstructionEditDialog';
import {
  SettingsButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  TOUCH_TARGET,
} from './kit';
import { LocalAssetImportDialog } from './LocalAssetImportDialog';
import { NewSessionBadge } from './NewSessionBadge';
import {
  enabledOccupancyTotal,
  OccupancyEnabledTotal,
  OccupancyMark,
  useOccupancyRows,
} from './OccupancyMark';

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

export function InstructionsSettings() {
  const { t } = useI18n();
  const instructions = useSettingsStore((state) => state.instructions);
  const updateInstruction = useSettingsStore((state) => state.updateInstruction);
  const removeInstruction = useSettingsStore((state) => state.removeInstruction);
  const [importOpen, setImportOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<InstructionEntry | 'new' | null>(null);
  const instructionIds = instructions.map((instruction) => instruction.id);
  const occupancy = useOccupancyRows(instructionIds, (ids) =>
    window.electronAPI.assets.instructionOccupancy(ids)
  );
  const enabledTokens = enabledOccupancyTotal(
    instructions.filter((instruction) => instruction.enabled).map((instruction) => instruction.id),
    occupancy.rows
  );

  return (
    <SettingsPage
      rowId="instructions.root"
      title={
        <>
          {t('Instruction Files')}
          <OccupancyEnabledTotal tokens={enabledTokens} />
          <NewSessionBadge />
        </>
      }
      description={t('Global CLAUDE.md / AGENTS.md style files from local AI tools')}
      actions={
        <>
          <SettingsButton onClick={() => setImportOpen(true)}>
            <HardDriveDownload className="h-4 w-4" />
            {t('Import from local apps')}
          </SettingsButton>
          <SettingsButton onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" />
            {t('Add instruction')}
          </SettingsButton>
        </>
      }
    >
      <p className="mt-1 text-[12px] text-muted-foreground">
        {t('Only one file is active at a time; enabling one disables the others')}
      </p>

      <SettingsSection>
        {instructions.length === 0 ? (
          <div className="border-border border-b py-8 text-center">
            <FileText className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-3 font-medium text-[13px]">{t('No instruction files yet')}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              {t('Import instruction files from local apps or add one manually to get started')}
            </p>
          </div>
        ) : (
          instructions.map((instruction) => (
            <SettingsRow
              key={instruction.id}
              rowId={`instructions.${instruction.id}`}
              label={
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className={cn(!instruction.enabled && 'text-muted-foreground line-through')}
                  >
                    {instruction.name}
                  </span>
                  <Badge variant="secondary" className="text-[11px]">
                    {instruction.source}
                  </Badge>
                  {!instruction.local && (
                    <Badge variant="outline" className="gap-1 text-[11px]">
                      <Link2 className="h-3 w-3" />
                      {t('Linked')}
                    </Badge>
                  )}
                </span>
              }
              description={
                <span className="block truncate">
                  {instruction.local
                    ? `${t('Local copy')} · ${formatBytes(instruction.bytes)}`
                    : `${instruction.sourcePath} · ${formatBytes(instruction.bytes)}`}
                </span>
              }
              status={
                <OccupancyMark
                  row={occupancy.rows[instruction.id]}
                  pending={occupancy.pending && !occupancy.rows[instruction.id]}
                />
              }
            >
              <SettingsSwitch
                checked={instruction.enabled}
                onCheckedChange={(enabled) => updateInstruction(instruction.id, { enabled })}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('Edit')}
                className={cn('text-muted-foreground', TOUCH_TARGET)}
                onClick={() => setEditing(instruction)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('Delete')}
                className={cn('text-muted-foreground hover:text-destructive-text', TOUCH_TARGET)}
                onClick={() => removeInstruction(instruction.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </SettingsRow>
          ))
        )}
      </SettingsSection>

      <LocalAssetImportDialog kind="instruction" open={importOpen} onOpenChange={setImportOpen} />
      <InstructionEditDialog instruction={editing} onClose={() => setEditing(null)} />
    </SettingsPage>
  );
}
