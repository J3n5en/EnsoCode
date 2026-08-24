import type { InstructionEntry } from '@shared/types';
import { CircleAlert, Info, Loader2, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';

interface InstructionEditDialogProps {
  instruction: InstructionEntry | null;
  onClose: () => void;
}

export function InstructionEditDialog({ instruction, onClose }: InstructionEditDialogProps) {
  const { t } = useI18n();
  const updateInstruction = useSettingsStore((state) => state.updateInstruction);

  const [name, setName] = React.useState('');
  const [content, setContent] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  /** 链接态条目保存方式：false = 复制为本地副本，true = 直接改源文件 */
  const [writeToSource, setWriteToSource] = React.useState(false);

  React.useEffect(() => {
    if (!instruction) return;
    setName(instruction.name);
    setDirty(false);
    setError(null);
    setWriteToSource(false);
    setLoading(true);
    void window.electronAPI.instructions
      .read(instruction.id, instruction.local, instruction.sourcePath)
      .then((result) => {
        if (result.ok) {
          setContent(result.content);
        } else {
          setContent('');
          setError(result.error ?? t('Failed to read content'));
        }
      })
      .finally(() => setLoading(false));
  }, [instruction, t]);

  const linked = Boolean(instruction && !instruction.local && instruction.sourcePath);

  const handleSave = async () => {
    if (!instruction || !name.trim()) return;
    setSaving(true);

    if (linked && writeToSource && instruction.sourcePath) {
      // 直接写回源应用的原文件，条目保持链接态
      const result = await window.electronAPI.instructions.writeSource(
        instruction.id,
        instruction.sourcePath,
        content
      );
      setSaving(false);
      if (!result.ok) {
        setError(result.error ?? t('Failed to save'));
        return;
      }
      updateInstruction(instruction.id, { name: name.trim(), bytes: result.bytes });
      onClose();
      return;
    }

    // 复制为本地副本：首次保存即完成 copy-on-write
    const result = await window.electronAPI.instructions.write(instruction.id, content);
    setSaving(false);
    if (!result.ok) {
      setError(t('Failed to save'));
      return;
    }
    updateInstruction(instruction.id, {
      name: name.trim(),
      local: true,
      bytes: result.bytes,
    });
    onClose();
  };

  return (
    <Dialog open={instruction !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Edit Instruction')}</DialogTitle>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          {linked ? (
            <div
              className={cn(
                'w-full rounded-md border px-3 py-2.5 transition-colors',
                writeToSource
                  ? 'border-destructive/32 bg-destructive/8'
                  : 'border-amber-500/32 bg-amber-500/8'
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  {writeToSource ? (
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
                  ) : (
                    <Info className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
                  )}
                  <span className="font-medium text-xs">{t('Write back to original file')}</span>
                </div>
                <Switch checked={writeToSource} onCheckedChange={setWriteToSource} />
              </div>
              <p className="mt-1.5 pl-5.5 text-muted-foreground text-xs leading-relaxed">
                {writeToSource
                  ? t('Saving overwrites {{path}} directly — {{source}} will pick up the change.', {
                      path: instruction?.sourcePath ?? '',
                      source: instruction?.source ?? '',
                    })
                  : t(
                      'Saving creates a local copy — {{path}} is left untouched, and this entry stops following its updates.',
                      { path: instruction?.sourcePath ?? '' }
                    )}
              </p>
            </div>
          ) : (
            <div className="flex w-full items-start gap-2 rounded-md border bg-muted/50 px-3 py-2">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t('Local copy — edits stay in this app.')}
              </p>
            </div>
          )}

          <Field>
            <FieldLabel>{t('Name')}</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field>
            <FieldLabel>{t('Content')}</FieldLabel>
            {loading ? (
              <div className="flex w-full items-center justify-center gap-2 rounded-md border py-12">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground text-xs">{t('Loading...')}</span>
              </div>
            ) : (
              <Textarea
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setDirty(true);
                }}
                rows={16}
                className="font-mono text-xs"
              />
            )}
          </Field>

          {error && (
            <p className="flex items-center gap-1.5 text-destructive text-xs">
              <CircleAlert className="h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            size="sm"
            variant={linked && writeToSource ? 'destructive' : 'default'}
            disabled={!name.trim() || loading || saving}
            onClick={handleSave}
          >
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {linked
              ? writeToSource
                ? t('Overwrite original')
                : dirty
                  ? t('Save as local copy')
                  : t('Save')
              : t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
