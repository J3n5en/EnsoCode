import {
  type ModelPricing,
  type PricingTable,
  parseUsageModelPricing,
} from '@shared/usage/pricing';
import type { UsageModelRow } from '@shared/usage/types';
import { ChevronDown } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';

const EMPTY: ModelPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function toDraft(p: ModelPricing): Record<(typeof FIELDS)[number], string> {
  return {
    input: String(p.input),
    output: String(p.output),
    cacheRead: String(p.cacheRead),
    cacheWrite: String(p.cacheWrite),
  };
}

function fromDraft(draft: Record<(typeof FIELDS)[number], string>): ModelPricing | null {
  const parsed = parseUsageModelPricing({
    id: Object.fromEntries(FIELDS.map((key) => [key, Number(draft[key])])),
  });
  return parsed.id ?? null;
}

function formatRate(value: number | undefined): string {
  return value === undefined ? '—' : String(value);
}

type PriceRow = { model: string; pricing: ModelPricing | null };

function PriceTable({
  rows,
  editing,
  draft,
  overrides,
  onDraft,
  onEdit,
  onSave,
}: {
  rows: PriceRow[];
  editing: string | null;
  draft: Record<(typeof FIELDS)[number], string>;
  overrides: PricingTable;
  onDraft: (next: Record<(typeof FIELDS)[number], string>) => void;
  onEdit: (id: string, pricing: ModelPricing | null) => void;
  onSave: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <th className="pb-2 text-left font-normal">{t('Name')}</th>
          {FIELDS.map((field) => (
            <th key={field} className="pb-2 text-right font-normal">
              {field}
            </th>
          ))}
          <th className="w-14 pb-2" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const isEditing = editing === row.model;
          const custom = row.model in overrides;
          return (
            <tr key={row.model} className="border-t border-border/60">
              <td className="py-1.5 pr-3 align-middle">
                <span className="font-mono text-xs" title={row.model}>
                  {row.model}
                </span>
                {custom && (
                  <span className="ml-1.5 text-[10px] text-muted-foreground">{t('Custom')}</span>
                )}
              </td>
              {FIELDS.map((field) => (
                <td key={field} className="py-1.5 text-right align-middle">
                  {isEditing ? (
                    <Input
                      size="sm"
                      inputMode="decimal"
                      className="ml-auto w-16 [&_input]:text-right"
                      value={draft[field]}
                      onChange={(e) => onDraft({ ...draft, [field]: e.target.value })}
                    />
                  ) : (
                    <span
                      className={cn(
                        'font-mono tabular-nums',
                        row.pricing == null && 'text-muted-foreground'
                      )}
                    >
                      {formatRate(row.pricing?.[field])}
                    </span>
                  )}
                </td>
              ))}
              <td className="py-1.5 text-right align-middle">
                {isEditing ? (
                  <Button
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    onClick={() => onSave(row.model)}
                  >
                    {t('Save')}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    onClick={() => onEdit(row.model, row.pricing)}
                  >
                    {t('Edit')}
                  </Button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function UsagePricingEditor({
  models,
  catalog,
  onChanged,
}: {
  models: UsageModelRow[];
  catalog: PricingTable;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const overrides = useSettingsStore((s) => s.usageModelPricing);
  const providers = useSettingsStore((s) => s.providers);
  const setPricing = useSettingsStore((s) => s.setUsageModelPricing);
  const [open, setOpen] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState(toDraft(EMPTY));
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [newId, setNewId] = React.useState('');
  const [query, setQuery] = React.useState('');

  const usedIds = new Set(models.map((row) => row.model));
  const configuredIds = new Set<string>();
  for (const provider of providers) {
    for (const model of provider.models) configuredIds.add(model.id);
  }
  for (const id of Object.keys(overrides)) configuredIds.add(id);
  const q = query.trim().toLowerCase();
  const usedRows: PriceRow[] = models
    .filter((row) => !q || row.model.toLowerCase().includes(q))
    .map((row) => ({ model: row.model, pricing: row.pricing }));
  const unusedRows: PriceRow[] = [...configuredIds]
    .filter((id) => !usedIds.has(id) && (!q || id.toLowerCase().includes(q)))
    .sort()
    .map((model) => ({ model, pricing: overrides[model] ?? catalog[model] ?? null }));

  const startEdit = (id: string, pricing: ModelPricing | null) => {
    setAdding(false);
    setEditing(id);
    setDraft(toDraft(pricing ?? EMPTY));
    setError(null);
  };

  const save = (id: string): boolean => {
    const next = fromDraft(draft);
    if (!next || !setPricing(id, next)) {
      setError(t('Enter a model id and non-negative rates.'));
      return false;
    }
    setError(null);
    setEditing(null);
    setAdding(false);
    setNewId('');
    onChanged();
    return true;
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t('Unit prices')}</div>
          <p className="text-xs text-muted-foreground">
            {t('Rates used for cost estimates ($/M tokens).')}
          </p>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t px-4 py-3">
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search models')}
          />
          {usedRows.length === 0 && !adding ? (
            <p className="text-xs text-muted-foreground">
              {q ? t('No matching models') : t('No usage in this period')}
            </p>
          ) : (
            <PriceTable
              rows={usedRows}
              editing={editing}
              draft={draft}
              overrides={overrides}
              onDraft={setDraft}
              onEdit={startEdit}
              onSave={save}
            />
          )}

          {unusedRows.length > 0 && (showAll || Boolean(q)) && (
            <PriceTable
              rows={unusedRows}
              editing={editing}
              draft={draft}
              overrides={overrides}
              onDraft={setDraft}
              onEdit={startEdit}
              onSave={save}
            />
          )}

          {adding ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-end gap-2">
                <label className="grid min-w-36 gap-1 text-[11px] text-muted-foreground">
                  {t('Model id')}
                  <Input
                    size="sm"
                    value={newId}
                    onChange={(e) => setNewId(e.target.value)}
                    placeholder="qwen-3.8-27b"
                  />
                </label>
                {FIELDS.map((field) => (
                  <label
                    key={field}
                    className="grid min-w-16 gap-1 text-[11px] text-muted-foreground"
                  >
                    {field}
                    <Input
                      size="sm"
                      inputMode="decimal"
                      value={draft[field]}
                      onChange={(e) => setDraft((cur) => ({ ...cur, [field]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
              <div className="flex gap-2">
                <Button size="sm" className="h-7" onClick={() => save(newId)}>
                  {t('Save')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  onClick={() => {
                    setAdding(false);
                    setNewId('');
                    setError(null);
                  }}
                >
                  {t('Cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              {unusedRows.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-muted-foreground"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {t('Show all')}
                  <ChevronDown
                    className={cn('ml-1 h-3.5 w-3.5 transition-transform', showAll && 'rotate-180')}
                  />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => {
                  setAdding(true);
                  setDraft(toDraft(EMPTY));
                  setError(null);
                }}
              >
                {t('Add')}
              </Button>
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
