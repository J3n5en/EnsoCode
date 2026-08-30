import { mergeFetchedModels } from '@shared/modelEntry';
import type { ModelEntry, ModelMeta, ModelProvider } from '@shared/types';
import { MODEL_API_KINDS } from '@shared/types';
import {
  CircleCheck,
  CircleX,
  Eye,
  EyeOff,
  ListPlus,
  Loader2,
  Plus,
  Search,
  Zap,
} from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { DialogFooter, DialogPanel } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { API_KIND_LABELS } from './constants';
import { ProviderModelRow } from './ProviderModelRow';

export interface ProviderApiFormValue {
  name: string;
  api: ModelProvider['api'];
  apiKey: string;
  baseUrl: string;
  models: ModelEntry[];
}

interface ProviderApiFormProps {
  initialValue: ProviderApiFormValue;
  oauth: boolean;
  onCancel: () => void;
  onSave: (value: ProviderApiFormValue) => void;
}

const isEnabled = (model: ModelEntry) => model.enabled !== false;

/** 编辑与统一向导共用的 API/模型表单，Fetch/Test 只有这一份实现。 */
export function ProviderApiForm({ initialValue, oauth, onCancel, onSave }: ProviderApiFormProps) {
  const { t } = useI18n();
  const [name, setName] = React.useState(initialValue.name);
  const [api, setApi] = React.useState(initialValue.api);
  const [apiKey, setApiKey] = React.useState(initialValue.apiKey);
  const [baseUrl, setBaseUrl] = React.useState(initialValue.baseUrl);
  const [models, setModels] = React.useState<ModelEntry[]>(initialValue.models);
  const [newModel, setNewModel] = React.useState('');
  const [filter, setFilter] = React.useState('');
  const [testModel, setTestModel] = React.useState(
    initialValue.models.find(isEnabled)?.id ?? initialValue.models[0]?.id ?? ''
  );
  const [showKey, setShowKey] = React.useState(false);
  const [busy, setBusy] = React.useState<'fetch' | 'test' | null>(null);
  const [status, setStatus] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [catalogMeta, setCatalogMeta] = React.useState<Record<string, ModelMeta>>({});

  const modelIdKey = models.map((model) => model.id).join('\0');
  React.useEffect(() => {
    if (oauth || !modelIdKey) return;
    const queryMeta = window.electronAPI.providers.modelMeta;
    if (typeof queryMeta !== 'function') return;
    const modelIds = modelIdKey.split('\0');
    let cancelled = false;
    void queryMeta({ modelIds })
      .then((result) => {
        if (cancelled || !result.ok) return;
        const next: Record<string, ModelMeta> = {};
        for (const meta of result.models) next[meta.modelId] = meta;
        setCatalogMeta(next);
      })
      .catch(() => {
        /* catalog 查询失败不挡手动编辑 */
      });
    return () => {
      cancelled = true;
    };
  }, [oauth, modelIdKey]);

  const visibleModels = React.useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    return keyword ? models.filter((model) => model.id.toLowerCase().includes(keyword)) : models;
  }, [filter, models]);
  const enabledCount = models.filter(isEnabled).length;

  const apiConfig = { api, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() };

  const handleFetchModels = async () => {
    setBusy('fetch');
    setStatus(null);
    const result = await window.electronAPI.providers.listModels(apiConfig);
    setBusy(null);
    if (!result.ok) {
      setStatus({ ok: false, text: result.error ?? 'Failed' });
      return;
    }
    setModels((current) => mergeFetchedModels(current, result.models));
    setStatus({ ok: true, text: t('Fetched {{count}} models', { count: result.models.length }) });
  };

  const handleTest = async () => {
    setBusy('test');
    setStatus(null);
    const target = testModel || models.find(isEnabled)?.id;
    const result = await window.electronAPI.providers.test(apiConfig, target);
    setBusy(null);
    setStatus({
      ok: result.ok,
      text: result.ok ? t('Connected ({{ms}}ms)', { ms: result.latencyMs }) : result.message,
    });
  };

  const addModel = (id: string) => {
    const value = id.trim();
    if (!value) return;
    setModels((current) =>
      current.some((model) => model.id === value)
        ? current
        : [...current, { id: value, enabled: true }]
    );
    setTestModel((current) => current || value);
    setNewModel('');
  };

  return (
    <>
      <DialogPanel className="space-y-4">
        <Field>
          <FieldLabel>{t('Name')}</FieldLabel>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        {!oauth && (
          <>
            <Field>
              <FieldLabel>{t('API Type')}</FieldLabel>
              <Select
                items={API_KIND_LABELS}
                value={api}
                onValueChange={(value) => setApi(value as ModelProvider['api'])}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                  {MODEL_API_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {API_KIND_LABELS[kind]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <Field>
              <FieldLabel>{t('Base URL')}</FieldLabel>
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://..."
              />
            </Field>

            <Field>
              <FieldLabel>{t('API Key')}</FieldLabel>
              <div className="relative w-full">
                <Input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="[&_input]:pr-10"
                />
                <button
                  type="button"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowKey((visible) => !visible)}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
          </>
        )}

        <Field>
          <div className="flex w-full items-center justify-between">
            <FieldLabel>
              {t('Models')}
              {models.length > 0 && (
                <span className="font-normal text-muted-foreground text-xs">
                  {t('{{enabled}}/{{total}} enabled', {
                    enabled: enabledCount,
                    total: models.length,
                  })}
                </span>
              )}
            </FieldLabel>
            {!oauth && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                disabled={busy !== null}
                onClick={handleFetchModels}
              >
                {busy === 'fetch' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ListPlus className="h-3.5 w-3.5" />
                )}
                {busy === 'fetch' ? t('Fetching') : t('Fetch models')}
              </Button>
            )}
          </div>

          {models.length > 0 && (
            <>
              <div className="flex w-full items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder={t('Filter models...')}
                    className="h-8 text-xs [&_input]:pl-8"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 px-2 text-xs"
                  disabled={visibleModels.length === 0}
                  onClick={() => {
                    const ids = new Set(visibleModels.map((model) => model.id));
                    setModels((current) =>
                      current.map((model) =>
                        ids.has(model.id) ? { ...model, enabled: true } : model
                      )
                    );
                  }}
                >
                  {t('Enable all')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 px-2 text-xs"
                  disabled={visibleModels.length === 0}
                  onClick={() => {
                    const ids = new Set(visibleModels.map((model) => model.id));
                    setModels((current) =>
                      current.map((model) =>
                        ids.has(model.id) ? { ...model, enabled: false } : model
                      )
                    );
                  }}
                >
                  {t('Disable all')}
                </Button>
              </div>

              <div className="max-h-72 w-full space-y-0.5 overflow-y-auto rounded-md border p-1">
                {visibleModels.map((model) => (
                  <ProviderModelRow
                    key={model.id}
                    model={model}
                    expanded={expandedId === model.id}
                    canOverride={!oauth}
                    catalogMeta={catalogMeta[model.id]}
                    onToggleExpand={() =>
                      setExpandedId((current) => (current === model.id ? null : model.id))
                    }
                    onToggleEnabled={() =>
                      setModels((current) =>
                        current.map((entry) =>
                          entry.id === model.id ? { ...entry, enabled: !isEnabled(entry) } : entry
                        )
                      )
                    }
                    onRemove={() => {
                      setModels((current) => current.filter((entry) => entry.id !== model.id));
                      setTestModel((current) => (current === model.id ? '' : current));
                      setExpandedId((current) => (current === model.id ? null : current));
                    }}
                    onChange={(next) =>
                      setModels((current) =>
                        current.map((entry) => (entry.id === model.id ? next : entry))
                      )
                    }
                  />
                ))}
                {visibleModels.length === 0 && (
                  <p className="py-4 text-center text-muted-foreground text-xs">
                    {t('No models match')}
                  </p>
                )}
              </div>
            </>
          )}

          <div className="flex w-full items-center gap-2">
            <Input
              value={newModel}
              onChange={(event) => setNewModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.key !== 'Enter') return;
                event.preventDefault();
                addModel(newModel);
              }}
              placeholder={t('Add a model id')}
              className="h-8 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              disabled={!newModel.trim()}
              onClick={() => addModel(newModel)}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </Field>
      </DialogPanel>

      <DialogFooter className="sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          {!oauth && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={handleTest}
            >
              {busy === 'test' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="mr-1.5 h-3.5 w-3.5" />
              )}
              {busy === 'test' ? t('Testing') : t('Test connection')}
            </Button>
          )}
          {!oauth && models.length > 0 && (
            <Select
              items={models.map((model) => ({
                value: model.id,
                label: model.label ?? model.id,
              }))}
              value={testModel}
              onValueChange={(value) => setTestModel(value ?? '')}
            >
              <SelectTrigger className="h-8 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label ?? model.id}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          {status && (
            <span
              className={cn(
                'flex min-w-0 items-center gap-1 text-xs',
                status.ok ? 'text-emerald-600 dark:text-emerald-500' : 'text-destructive'
              )}
            >
              {status.ok ? (
                <CircleCheck className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <CircleX className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">{status.text}</span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!name.trim()}
            onClick={() =>
              onSave({
                name: name.trim(),
                api,
                apiKey: apiKey.trim(),
                baseUrl: baseUrl.trim(),
                models,
              })
            }
          >
            {t('Save')}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
