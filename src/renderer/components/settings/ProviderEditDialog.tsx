import type { ModelEntry, ModelProvider } from '@shared/types';
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
  Trash2,
  Zap,
} from 'lucide-react';
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { useSettingsStore } from '@/stores/settings';

interface ProviderEditDialogProps {
  provider: ModelProvider | null;
  onClose: () => void;
}

const isEnabled = (model: ModelEntry) => model.enabled !== false;

export function ProviderEditDialog({ provider, onClose }: ProviderEditDialogProps) {
  const { t } = useI18n();
  const updateProvider = useSettingsStore((state) => state.updateProvider);

  const [name, setName] = React.useState('');
  const [api, setApi] = React.useState<ModelProvider['api']>('openai-completions');
  const [apiKey, setApiKey] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [models, setModels] = React.useState<ModelEntry[]>([]);
  const [newModel, setNewModel] = React.useState('');
  const [filter, setFilter] = React.useState('');
  const [testModel, setTestModel] = React.useState('');
  const [showKey, setShowKey] = React.useState(false);
  const [busy, setBusy] = React.useState<'fetch' | 'test' | null>(null);
  const [status, setStatus] = React.useState<{ ok: boolean; text: string } | null>(null);

  React.useEffect(() => {
    if (provider) {
      setName(provider.name);
      setApi(provider.api);
      setApiKey(provider.apiKey);
      setBaseUrl(provider.baseUrl);
      setModels(provider.models);
      setNewModel('');
      setFilter('');
      setTestModel(provider.models.find(isEnabled)?.id ?? provider.models[0]?.id ?? '');
      setShowKey(false);
      setStatus(null);
    }
  }, [provider]);

  const apiConfig = () => ({ api, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() });

  const toggleModel = (id: string) => {
    setModels((prev) =>
      prev.map((model) => (model.id === id ? { ...model, enabled: !isEnabled(model) } : model))
    );
  };

  const visibleModels = React.useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return models;
    return models.filter((model) => model.id.toLowerCase().includes(keyword));
  }, [models, filter]);

  /** 批量开关：仅作用于当前筛选结果 */
  const setVisibleEnabled = (enabled: boolean) => {
    const targets = new Set(visibleModels.map((model) => model.id));
    setModels((prev) =>
      prev.map((model) => (targets.has(model.id) ? { ...model, enabled } : model))
    );
  };

  const enabledCount = models.filter(isEnabled).length;

  const removeModel = (id: string) => {
    setModels((prev) => prev.filter((model) => model.id !== id));
    setTestModel((prev) => (prev === id ? '' : prev));
  };

  const addModel = (id: string) => {
    const value = id.trim();
    if (!value) return;
    setModels((prev) =>
      prev.some((m) => m.id === value) ? prev : [...prev, { id: value, enabled: true }]
    );
    setTestModel((prev) => prev || value);
    setNewModel('');
  };

  const handleFetchModels = async () => {
    setBusy('fetch');
    setStatus(null);
    const result = await window.electronAPI.providers.listModels(apiConfig());
    setBusy(null);
    if (result.ok) {
      // 合并：已存在的保留开关状态，新拉取的默认启用
      setModels((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const fresh = result.models
          .filter((id) => !known.has(id))
          .map((id) => ({ id, enabled: true }) satisfies ModelEntry);
        return [...prev, ...fresh];
      });
      setStatus({ ok: true, text: t('Fetched {{count}} models', { count: result.models.length }) });
    } else {
      setStatus({ ok: false, text: result.error ?? 'Failed' });
    }
  };

  const handleTest = async () => {
    setBusy('test');
    setStatus(null);
    const target = testModel || models.find(isEnabled)?.id;
    const result = await window.electronAPI.providers.test(apiConfig(), target);
    setBusy(null);
    setStatus({
      ok: result.ok,
      text: result.ok ? t('Connected ({{ms}}ms)', { ms: result.latencyMs }) : result.message,
    });
  };

  const handleSave = () => {
    if (!provider || !name.trim()) return;
    updateProvider(provider.id, {
      name: name.trim(),
      api,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      models,
    });
    onClose();
  };

  return (
    <Dialog open={provider !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Edit Provider')}</DialogTitle>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          <Field>
            <FieldLabel>{t('Name')}</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field>
            <FieldLabel>{t('API Type')}</FieldLabel>
            <Select value={api} onValueChange={(v) => setApi(v as ModelProvider['api'])}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                {MODEL_API_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {kind}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          <Field>
            <FieldLabel>{t('Base URL')}</FieldLabel>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://..."
            />
          </Field>

          <Field>
            <FieldLabel>{t('API Key')}</FieldLabel>
            <div className="relative w-full">
              <Input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="[&_input]:pr-10"
              />
              <button
                type="button"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </Field>

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
            </div>

            {models.length > 0 && (
              <>
                <div className="flex w-full items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
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
                    onClick={() => setVisibleEnabled(true)}
                  >
                    {t('Enable all')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 px-2 text-xs"
                    disabled={visibleModels.length === 0}
                    onClick={() => setVisibleEnabled(false)}
                  >
                    {t('Disable all')}
                  </Button>
                </div>

                <div className="max-h-48 w-full space-y-0.5 overflow-y-auto rounded-md border p-1">
                  {visibleModels.map((model) => (
                    <div
                      key={model.id}
                      className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50"
                    >
                      <Switch
                        checked={isEnabled(model)}
                        onCheckedChange={() => toggleModel(model.id)}
                      />
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate font-mono text-xs',
                          !isEnabled(model) && 'text-muted-foreground line-through'
                        )}
                      >
                        {model.id}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                        onClick={() => removeModel(model.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
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
                onChange={(e) => setNewModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addModel(newModel);
                  }
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
            {models.length > 0 && (
              <Select value={testModel} onValueChange={(v) => setTestModel(v ?? '')}>
                <SelectTrigger className="h-8 w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.id}
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
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button size="sm" disabled={!name.trim()} onClick={handleSave}>
              {t('Save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
