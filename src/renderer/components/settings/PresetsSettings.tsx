import type { InstructionEntry, Preset } from '@shared/types';
import { Eye, Layers, Pencil, Plus, Trash2 } from 'lucide-react';
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

export function PresetEditDialog({
  preset,
  onClose,
}: {
  preset: Preset | null;
  onClose: () => void;
}) {
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
      <DialogContent className="max-w-xl" disableNestedTransform>
        <DialogHeader>
          <DialogTitle>{preset ? t('Edit preset') : t('New preset')}</DialogTitle>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <Field>
            <FieldLabel>{t('Name')}</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <PickList
            title={t('Skills')}
            emptyText={t('No skills yet')}
            items={skills}
            getName={(s) => s.name}
            getSource={(s) => s.source}
            isChecked={(s) => skillIds.includes(s.id)}
            onToggle={(s) => setSkillIds((list) => toggle(list, s.id))}
            renderDetail={(s) => (
              <DetailRows
                rows={[
                  [t('Source'), s.source],
                  [t('Path'), s.path],
                  [t('Description'), s.description],
                ]}
              />
            )}
          />

          <PickList
            title={t('MCP Servers')}
            emptyText={t('No MCP servers yet')}
            items={mcpServers}
            getName={(m) => m.name}
            getSource={(m) => m.source}
            isChecked={(m) => mcpServerIds.includes(m.id)}
            onToggle={(m) => setMcpServerIds((list) => toggle(list, m.id))}
            renderDetail={(m) => (
              <DetailRows
                rows={[
                  [t('Source'), m.source],
                  ['Transport', m.transport],
                  ['Command', [m.command, ...(m.args ?? [])].filter(Boolean).join(' ')],
                  ['URL', m.url],
                ]}
              />
            )}
          />

          <PickList
            title={t('Instruction Files')}
            emptyText={t('No instruction files yet')}
            items={instructions}
            getName={(i) => i.name}
            getSource={(i) => i.source}
            isChecked={(i) => instructionId === i.id}
            onToggle={(i) => setInstructionId((cur) => (cur === i.id ? undefined : i.id))}
            leading={
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5">
                <Checkbox
                  checked={instructionId === undefined}
                  onCheckedChange={() => setInstructionId(undefined)}
                />
                <span className="text-sm text-muted-foreground">{t('None')}</span>
              </label>
            }
            renderDetail={(i) => <InstructionDetail instruction={i} />}
          />
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

/** 带搜索的可勾选列表：每项 checkbox + 名字 + 来源角标 + 眼睛（居中 detail 弹窗） */
function PickList<T extends { id: string }>({
  title,
  emptyText,
  items,
  getName,
  getSource,
  isChecked,
  onToggle,
  renderDetail,
  leading,
}: {
  title: string;
  emptyText: string;
  items: T[];
  getName: (item: T) => string;
  getSource?: (item: T) => string;
  isChecked: (item: T) => boolean;
  onToggle: (item: T) => void;
  renderDetail: (item: T) => React.ReactNode;
  leading?: React.ReactNode;
}) {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const [detail, setDetail] = React.useState<T | null>(null);
  const filtered = query
    ? items.filter((item) => getName(item).toLowerCase().includes(query.toLowerCase()))
    : items;

  return (
    <div>
      <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      <div className="rounded-md border">
        {items.length > 0 && (
          <div className="border-b p-1.5">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('Search')}
              className="h-7 text-xs"
            />
          </div>
        )}
        <div className="max-h-40 overflow-y-auto p-1.5">
          {leading}
          {items.length === 0 && <Empty text={emptyText} />}
          {items.length > 0 && filtered.length === 0 && <Empty text={t('No results')} />}
          {filtered.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted"
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <Checkbox checked={isChecked(item)} onCheckedChange={() => onToggle(item)} />
                <span className="min-w-0 flex-1 truncate text-sm">{getName(item)}</span>
                {getSource && (
                  <Badge variant="secondary" className="shrink-0 text-[11px]">
                    {getSource(item)}
                  </Badge>
                )}
              </label>
              <button
                type="button"
                onClick={() => setDetail(item)}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-lg" zIndexLevel="nested">
          <DialogHeader>
            <DialogTitle>{detail ? getName(detail) : ''}</DialogTitle>
          </DialogHeader>
          <DialogPanel>{detail && renderDetail(detail)}</DialogPanel>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailRows({ rows }: { rows: [string, string | undefined][] }) {
  return (
    <div className="space-y-2 text-xs">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label}>
            <p className="font-semibold text-muted-foreground">{label}</p>
            <p className="mt-0.5 break-words whitespace-pre-wrap">{value}</p>
          </div>
        ))}
    </div>
  );
}

/** 指令文件 detail：元信息 + 内容预览（异步读取） */
function InstructionDetail({ instruction }: { instruction: InstructionEntry }) {
  const { t } = useI18n();
  const [content, setContent] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    window.electronAPI.instructions
      .read(instruction.id, instruction.local, instruction.sourcePath)
      .then((r) => {
        if (alive) setContent(r.ok ? r.content : (r.error ?? ''));
      });
    return () => {
      alive = false;
    };
  }, [instruction]);

  return (
    <div className="space-y-2 text-xs">
      <DetailRows
        rows={[
          [t('Source'), instruction.source],
          [t('Path'), instruction.sourcePath ?? (instruction.local ? t('Local copy') : '')],
        ]}
      />
      <div>
        <p className="font-semibold text-muted-foreground">{t('Content')}</p>
        <pre className="mt-0.5 max-h-60 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {content ?? `${t('Loading...')}`}
        </pre>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-2 text-xs text-muted-foreground">{text}</p>;
}
