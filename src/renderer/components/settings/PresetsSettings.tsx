import type { Preset } from '@shared/types';
import { Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

export function PresetsSettings() {
  const { t } = useI18n();
  const presets = useSettingsStore((state) => state.presets);
  const removePreset = useSettingsStore((state) => state.removePreset);
  const [editing, setEditing] = React.useState<Preset | 'new' | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="font-medium text-lg">{t('Presets')}</h3>
          <p className="text-muted-foreground text-sm">
            {t(
              'Injection bundles of skills, MCP servers and instruction files, chosen per conversation'
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t('New preset')}
        </Button>
      </div>

      <div className="space-y-2">
        {/* 默认预设：只读，跟随各条目的 enabled 开关 */}
        <div className="flex items-center gap-3 rounded-md border px-3 py-2.5">
          <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              {t('Default preset')}
              <Badge variant="secondary">{t('Default')}</Badge>
            </p>
            <p className="text-muted-foreground text-xs">
              {t('Follows the enabled switches on the Skills / MCP / Instructions pages')}
            </p>
          </div>
        </div>

        {presets.map((preset) => (
          <div key={preset.id} className="flex items-center gap-3 rounded-md border px-3 py-2.5">
            <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{preset.name}</p>
              <p className="text-muted-foreground text-xs">
                {t('{{skills}} skills · {{mcp}} MCP · {{instruction}} instruction', {
                  skills: preset.skillIds.length,
                  mcp: preset.mcpServerIds.length,
                  instruction: preset.instructionId ? 1 : 0,
                })}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setEditing(preset)}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => removePreset(preset.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {editing !== null && (
        <PresetEditDialog
          preset={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function PresetEditDialog({ preset, onClose }: { preset: Preset | null; onClose: () => void }) {
  const { t } = useI18n();
  const skills = useSettingsStore((state) => state.skills);
  const mcpServers = useSettingsStore((state) => state.mcpServers);
  const instructions = useSettingsStore((state) => state.instructions);
  const addPreset = useSettingsStore((state) => state.addPreset);
  const updatePreset = useSettingsStore((state) => state.updatePreset);

  const [name, setName] = React.useState(preset?.name ?? '');
  const [skillIds, setSkillIds] = React.useState<string[]>(preset?.skillIds ?? []);
  const [mcpServerIds, setMcpServerIds] = React.useState<string[]>(preset?.mcpServerIds ?? []);
  const [instructionId, setInstructionId] = React.useState<string | undefined>(
    preset?.instructionId
  );

  const toggle = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const save = () => {
    const payload = { name: name.trim() || t('Untitled'), skillIds, mcpServerIds, instructionId };
    if (preset) updatePreset(preset.id, payload);
    else addPreset(payload);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{preset ? t('Edit preset') : t('New preset')}</DialogTitle>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <Field>
            <FieldLabel>{t('Name')}</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Section title={t('Skills')}>
            {skills.length === 0 && <Empty text={t('No skills yet')} />}
            {skills.map((skill) => (
              <label key={skill.id} className="flex cursor-pointer items-center gap-2 py-1">
                <Checkbox
                  checked={skillIds.includes(skill.id)}
                  onCheckedChange={() => setSkillIds((list) => toggle(list, skill.id))}
                />
                <span className="truncate text-sm">{skill.name}</span>
              </label>
            ))}
          </Section>

          <Section title={t('MCP Servers')}>
            {mcpServers.length === 0 && <Empty text={t('No MCP servers yet')} />}
            {mcpServers.map((server) => (
              <label key={server.id} className="flex cursor-pointer items-center gap-2 py-1">
                <Checkbox
                  checked={mcpServerIds.includes(server.id)}
                  onCheckedChange={() => setMcpServerIds((list) => toggle(list, server.id))}
                />
                <span className="truncate text-sm">{server.name}</span>
              </label>
            ))}
          </Section>

          <Section title={t('Instruction Files')}>
            <label className="flex cursor-pointer items-center gap-2 py-1">
              <Checkbox
                checked={instructionId === undefined}
                onCheckedChange={() => setInstructionId(undefined)}
              />
              <span className="text-sm text-muted-foreground">{t('None')}</span>
            </label>
            {instructions.map((instruction) => (
              <label key={instruction.id} className="flex cursor-pointer items-center gap-2 py-1">
                <Checkbox
                  checked={instructionId === instruction.id}
                  onCheckedChange={(checked) =>
                    setInstructionId(checked ? instruction.id : undefined)
                  }
                />
                <span className="truncate text-sm">
                  {instruction.name}
                  <span className="ml-1.5 text-xs text-muted-foreground">{instruction.source}</span>
                </span>
              </label>
            ))}
          </Section>
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={save}>{t('Save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      <div className="max-h-40 overflow-y-auto rounded-md border px-3 py-1.5">{children}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-2 text-xs text-muted-foreground">{text}</p>;
}
