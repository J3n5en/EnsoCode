import { commitPendingModel, mergeFetchedModels } from '@shared/modelEntry';
import { baseUrlAfterApiChange, isClassifierOnlyProvider } from '@shared/providerCatalog';
import {
  isProviderModelRefreshIntervalHours,
  MAX_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS,
  MIN_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS,
  normalizeProviderModelRefreshIntervalHours,
} from '@shared/providers/modelRefreshInterval';
import {
  HEADER_NAME_RE,
  isSendableHeaderValue,
  normalizeProviderHeaders,
} from '@shared/providers/providerHeaders';
import {
  normalizeProviderProxy,
  type ProviderProxyConfig,
  type ProviderProxyMode,
  proxyUrlHasCredentials,
} from '@shared/providers/providerProxy';
import { isValidProxyUrl } from '@shared/proxy';
import type { ModelEntry, ModelMeta, ModelProvider } from '@shared/types';
import { MODEL_API_KINDS } from '@shared/types/llm';
import { CircleCheck, CircleX, Eye, EyeOff, ListPlus, Loader2, Plus, X, Zap } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
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
import { useScrollChain } from '@/hooks/useScrollChain';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { API_KIND_LABELS } from './constants';
import {
  SettingsButton,
  SettingsExpandableRow,
  SettingsSegmented,
  SettingsSubRow,
  useSettingsRowControl,
} from './kit';
import { ListFilterBar, useVisibleSelection } from './ListFilterBar';
import { ProviderModelRow } from './ProviderModelRow';

export interface ProviderApiFormValue {
  name: string;
  api: ModelProvider['api'];
  apiKey: string;
  baseUrl: string;
  models: ModelEntry[];
  headers?: Record<string, string>;
  /** 缺省跟随全局代理 */
  proxy?: ProviderProxyConfig;
  autoFetchModels?: boolean;
  modelRefreshIntervalHours?: number;
}

interface ProviderApiFormProps {
  initialValue: ProviderApiFormValue;
  catalogId?: ModelProvider['catalogId'];
  /** 供应商已停用时不显示自动拉取：停用条目不会被拉取 */
  providerEnabled?: boolean;
  modelRefreshStatus?: ModelProvider['modelRefreshStatus'];
  oauth: boolean;
  oauthAccountKey?: string;
  extraFields?: React.ReactNode;
  hideName?: boolean;
  /** 已经在别的滚动区里（向导的分步页）时不要再套一层 ScrollArea */
  bare?: boolean;
  saveDisabled?: boolean;
  onCancel: () => void;
  onSave: (value: ProviderApiFormValue, seenModelIds: ReadonlySet<string>) => void;
}

const isEnabled = (model: ModelEntry) => model.enabled !== false;
const autoFetchField = 'provider-auto-fetch-models';
const refreshIntervalSlot = 'provider-model-refresh-interval-hours';
const refreshIntervalRange = {
  min: MIN_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS,
  max: MAX_PROVIDER_MODEL_REFRESH_INTERVAL_HOURS,
};

type HeaderDraft = { key: string; name: string; value: string };

const PROXY_MODES = ['global', 'none', 'custom'] as const satisfies readonly ProviderProxyMode[];
const PROXY_MODE_LABELS: Record<ProviderProxyMode, string> = {
  global: 'Follow global proxy',
  none: 'No proxy (direct)',
  custom: 'Custom proxy',
};
const PROXY_MODE_HINTS: Record<ProviderProxyMode, string> = {
  global: 'Uses the network proxy in Settings → General.',
  none: 'All requests to this provider connect directly, ignoring the global and system proxy.',
  custom: 'All requests to this provider go through this proxy.',
};

/** 子行里的输入框：id 与行标签关联 */
function RowInput(props: React.ComponentProps<typeof Input>) {
  const { id } = useSettingsRowControl();
  return <Input id={id} render={<input id={id} />} {...props} />;
}

function headerDrafts(headers: Record<string, string> | undefined): HeaderDraft[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({
    key: crypto.randomUUID(),
    name,
    value,
  }));
}

/** 编辑与统一向导共用的 API/模型表单，Fetch/Test 只有这一份实现。 */
export function ProviderApiForm({
  initialValue,
  catalogId,
  providerEnabled = true,
  modelRefreshStatus,
  oauth,
  oauthAccountKey,
  extraFields,
  hideName = false,
  bare = false,
  saveDisabled = false,
  onCancel,
  onSave,
}: ProviderApiFormProps) {
  const { t, locale } = useI18n();
  const [name, setName] = React.useState(initialValue.name);
  const [api, setApi] = React.useState(initialValue.api);
  const [apiKey, setApiKey] = React.useState(initialValue.apiKey);
  const [baseUrl, setBaseUrl] = React.useState(initialValue.baseUrl);
  const [autoFetchModels, setAutoFetchModels] = React.useState(
    initialValue.autoFetchModels === true
  );
  const autoFetchLabelId = React.useId();
  const refreshIntervalId = React.useId();
  const refreshIntervalDescriptionId = React.useId();
  const [refreshInterval, setRefreshInterval] = React.useState(() =>
    String(normalizeProviderModelRefreshIntervalHours(initialValue.modelRefreshIntervalHours))
  );
  const [models, setModels] = React.useState<ModelEntry[]>(initialValue.models);
  const [seenModelIds] = React.useState(
    () => new Set(initialValue.models.map((model) => model.id))
  );
  const [headerRows, setHeaderRows] = React.useState(() => headerDrafts(initialValue.headers));
  const initialProxy = normalizeProviderProxy(initialValue.proxy);
  const [proxyMode, setProxyMode] = React.useState<ProviderProxyMode>(
    initialProxy?.mode ?? 'global'
  );
  const [proxyUrl, setProxyUrl] = React.useState(
    initialProxy?.mode === 'custom' ? initialProxy.url : ''
  );
  const proxyErrorId = React.useId();
  const [showProxyUrl, setShowProxyUrl] = React.useState(false);
  // 生效中的独立代理与请求头一样默认展开，避免用户看不到
  const [advancedOpen, setAdvancedOpen] = React.useState(
    () => Object.keys(initialValue.headers ?? {}).length > 0 || initialProxy !== undefined
  );
  const [newModel, setNewModel] = React.useState('');
  const [filter, setFilter] = React.useState('');
  const [testModel, setTestModel] = React.useState(
    initialValue.models.find(isEnabled)?.id ?? initialValue.models[0]?.id ?? ''
  );
  const [showKey, setShowKey] = React.useState(false);
  const [busy, setBusy] = React.useState<'fetch' | 'test' | null>(null);
  const [status, setStatus] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [errorDetail, setErrorDetail] = React.useState<string | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [catalogMeta, setCatalogMeta] = React.useState<Record<string, ModelMeta>>({});

  React.useEffect(() => {
    if (!oauth) return;
    // 目录可能晚于弹窗到达；只补新行，已有行保留用户尚未保存的编辑。
    setModels((current) => {
      const known = new Set(current.map((model) => model.id));
      const added = initialValue.models.filter((model) => !known.has(model.id));
      return added.length > 0 ? [...current, ...added] : current;
    });
  }, [oauth, initialValue.models]);

  const modelIdKey = models.map((model) => model.id).join('\0');
  React.useEffect(() => {
    if (!oauthAccountKey && (oauth || !modelIdKey)) return;
    const queryMeta = window.electronAPI.providers.modelMeta;
    if (typeof queryMeta !== 'function') return;
    const modelIds = modelIdKey ? modelIdKey.split('\0') : [];
    if (!oauthAccountKey && modelIds.length === 0) return;
    let cancelled = false;
    void queryMeta(oauthAccountKey ? { oauthAccountKey, modelIds } : { modelIds })
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
  }, [oauth, oauthAccountKey, modelIdKey]);

  const visibleModels = React.useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    return keyword ? models.filter((model) => model.id.toLowerCase().includes(keyword)) : models;
  }, [filter, models]);
  const visibleIds = visibleModels.map((model) => model.id);
  const selection = useVisibleSelection(visibleIds);
  const modelListRef = useScrollChain<HTMLDivElement>();
  const enabledCount = models.filter(isEnabled).length;
  const availableTestModel = models.some((model) => model.id === testModel)
    ? testModel
    : (models.find(isEnabled)?.id ?? models[0]?.id ?? '');
  const headers = normalizeProviderHeaders(headerRows);
  const headerNameInvalid = headerRows.some(
    (row) => row.name.trim() !== '' && !HEADER_NAME_RE.test(row.name.trim())
  );
  const headerValueInvalid = headerRows.some((row) => {
    const value = row.value.trim();
    return value !== '' && !isSendableHeaderValue(value);
  });
  const headersInvalid = headerNameInvalid || headerValueInvalid;
  const proxyInvalid = !oauth && proxyMode === 'custom' && !isValidProxyUrl(proxyUrl);
  // 代理账密与 API Key 一样默认遮住
  const proxyHasCredentials = proxyUrlHasCredentials(proxyUrl.trim());
  const proxy: ProviderProxyConfig | undefined =
    oauth || proxyInvalid
      ? undefined
      : proxyMode === 'none'
        ? { mode: 'none' }
        : proxyMode === 'custom'
          ? { mode: 'custom', url: proxyUrl.trim() }
          : undefined;
  const classifierOnly = isClassifierOnlyProvider({ api, baseUrl: baseUrl.trim(), catalogId });
  const showModelRefresh = !oauth && !classifierOnly && providerEnabled;
  const refreshIntervalHours = Number(refreshInterval);
  const refreshIntervalValid =
    /^\d+$/.test(refreshInterval) && isProviderModelRefreshIntervalHours(refreshIntervalHours);
  const refreshIntervalInvalid = showModelRefresh && !refreshIntervalValid;

  const setSelectedEnabled = (enabled: boolean) => {
    const ids = new Set(selection.selectedIds);
    setModels((current) =>
      current.map((model) => (ids.has(model.id) ? { ...model, enabled } : model))
    );
  };

  const apiConfig = {
    api,
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.trim(),
    ...(headers ? { headers } : {}),
    ...(proxy ? { proxy } : {}),
  };

  /** 选了自定义代理但地址无效时不发请求，展开高级区让错误可见 */
  const blockedByProxy = () => {
    if (!proxyInvalid) return false;
    setAdvancedOpen(true);
    setStatus({ ok: false, text: t('Enter an http(s) proxy URL') });
    return true;
  };

  const handleFetchModels = async () => {
    if (!oauthAccountKey && blockedByProxy()) return;
    setBusy('fetch');
    setStatus(null);
    if (oauthAccountKey) {
      const result = await window.electronAPI.providers.modelMeta({
        oauthAccountKey,
        modelIds: [],
      });
      setBusy(null);
      if (!result.ok) {
        const text = result.error ?? 'Failed';
        setStatus({ ok: false, text });
        setErrorDetail(text);
        return;
      }
      const fetched = result.models
        .filter((meta) => meta.source !== 'unknown')
        .map((meta) => ({
          id: meta.modelId,
          ...(meta.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
          ...(meta.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {}),
        }));
      const nextMeta: Record<string, ModelMeta> = {};
      for (const meta of result.models) nextMeta[meta.modelId] = meta;
      setCatalogMeta((current) => ({ ...current, ...nextMeta }));
      // OAuth 条目的清单归统一目录管：拉取只刷新目录（Main 侧已触发），
      // 本地按目录语义重建——保留已有行（含用户意图）、新模型追加裸行。
      // 不能用 mergeFetchedModels：回填的 contextWindow/maxTokens 是 catalog 事实，
      // 保存时会被 extractModelOverrides 误当用户覆盖持久化，重新冻结清单。
      setModels((current) => {
        const byId = new Map(current.map((model) => [model.id, model]));
        const fresh = fetched.map((model) => byId.get(model.id) ?? { id: model.id });
        const fetchedIds = new Set(fetched.map((model) => model.id));
        const retired = current.filter((model) => !fetchedIds.has(model.id));
        return [...fresh, ...retired];
      });
      setStatus({ ok: true, text: t('Fetched {{count}} models', { count: fetched.length }) });
      return;
    }
    const result = await window.electronAPI.providers.listModels(apiConfig);
    setBusy(null);
    if (!result.ok) {
      const text = result.error ?? 'Failed';
      setStatus({ ok: false, text });
      setErrorDetail(text);
      return;
    }
    for (const model of result.models) seenModelIds.add(model.id);
    setModels((current) => mergeFetchedModels(current, result.models));
    setStatus({ ok: true, text: t('Fetched {{count}} models', { count: result.models.length }) });
  };

  const handleTest = async () => {
    if (blockedByProxy()) return;
    setBusy('test');
    setStatus(null);
    const target = availableTestModel || undefined;
    const result = await window.electronAPI.providers.test(apiConfig, target);
    setBusy(null);
    const text = result.ok ? t('Connected ({{ms}}ms)', { ms: result.latencyMs }) : result.message;
    setStatus({ ok: result.ok, text });
    if (!result.ok) setErrorDetail(text);
  };

  const addModel = (id: string) => {
    const value = id.trim();
    if (!value) return;
    seenModelIds.add(value);
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
      <DialogPanel bare={bare} className="space-y-4">
        {extraFields}
        {classifierOnly && (
          <p className="text-xs text-muted-foreground">{t('Classification only, not for chat')}</p>
        )}
        {!hideName && (
          <Field>
            <FieldLabel>{t('Name')}</FieldLabel>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
        )}

        {!oauth && (
          <>
            <Field>
              <FieldLabel>{t('API Type')}</FieldLabel>
              <Select
                items={API_KIND_LABELS}
                value={api}
                onValueChange={(value) => {
                  const nextApi = value as ModelProvider['api'];
                  setBaseUrl((current) => baseUrlAfterApiChange(nextApi, current));
                  setApi(nextApi);
                }}
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

            {showModelRefresh && (
              <div className="space-y-2">
                <Field
                  data-field={autoFetchField}
                  className="flex-row items-center justify-between"
                >
                  <FieldLabel id={autoFetchLabelId}>{t('Automatically fetch models')}</FieldLabel>
                  <Switch
                    data-slot={autoFetchField}
                    aria-labelledby={autoFetchLabelId}
                    checked={autoFetchModels}
                    onCheckedChange={setAutoFetchModels}
                  />
                </Field>
                {autoFetchModels && modelRefreshStatus && (
                  <p
                    data-slot="provider-model-refresh-status"
                    className={cn(
                      'text-xs',
                      modelRefreshStatus.ok ? 'text-muted-foreground' : 'text-destructive'
                    )}
                  >
                    {t(
                      modelRefreshStatus.ok
                        ? 'Last fetched {{time}}'
                        : 'Last fetch failed {{time}}',
                      {
                        time: formatRelativeTime(modelRefreshStatus.at, locale),
                      }
                    )}
                  </p>
                )}
                <Field>
                  <FieldLabel htmlFor={refreshIntervalId}>{t('Model fetch interval')}</FieldLabel>
                  <div className="flex items-center gap-2">
                    <Input
                      id={refreshIntervalId}
                      render={<input id={refreshIntervalId} />}
                      data-slot={refreshIntervalSlot}
                      type="number"
                      min={refreshIntervalRange.min}
                      max={refreshIntervalRange.max}
                      step={1}
                      value={refreshInterval}
                      className="w-24"
                      aria-describedby={refreshIntervalDescriptionId}
                      aria-invalid={refreshIntervalInvalid || undefined}
                      onInput={(event) => setRefreshInterval(event.currentTarget.value)}
                    />
                    <span className="text-xs text-muted-foreground">{t('hours')}</span>
                  </div>
                  <p
                    id={refreshIntervalDescriptionId}
                    className={cn(
                      'text-xs',
                      refreshIntervalInvalid ? 'text-destructive' : 'text-muted-foreground'
                    )}
                    role={refreshIntervalInvalid ? 'alert' : undefined}
                  >
                    {refreshIntervalInvalid
                      ? t(
                          'Enter a whole number from {{min}} to {{max}} hours.',
                          refreshIntervalRange
                        )
                      : t(
                          'This interval applies when automatic fetching is enabled for this provider.'
                        )}
                  </p>
                </Field>
              </div>
            )}

            <div className="border-border border-t">
              <SettingsExpandableRow
                rowId="providers.advanced"
                label={t('Advanced')}
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
              >
                <div data-field="provider-proxy">
                  <SettingsSubRow
                    rowId="providers.proxy"
                    label={t('Proxy')}
                    description={
                      <span data-slot="provider-proxy-hint">{t(PROXY_MODE_HINTS[proxyMode])}</span>
                    }
                  >
                    <div data-slot="provider-proxy-mode" className="max-w-full">
                      <SettingsSegmented
                        value={proxyMode}
                        onValueChange={setProxyMode}
                        options={PROXY_MODES.map((mode) => ({
                          value: mode,
                          label: t(PROXY_MODE_LABELS[mode]),
                        }))}
                      />
                    </div>
                  </SettingsSubRow>
                  {proxyMode === 'custom' && (
                    <SettingsSubRow
                      rowId="providers.proxy-url"
                      label={t('Proxy URL')}
                      description={
                        proxyInvalid ? (
                          <span id={proxyErrorId} role="alert" className="text-destructive-text">
                            {t('Enter an http(s) proxy URL')}
                          </span>
                        ) : undefined
                      }
                    >
                      <div className="relative w-[280px] max-w-full">
                        <RowInput
                          data-slot="provider-proxy-url"
                          type={proxyHasCredentials && !showProxyUrl ? 'password' : 'text'}
                          value={proxyUrl}
                          placeholder="http://127.0.0.1:7890"
                          spellCheck={false}
                          className={proxyHasCredentials ? '[&_input]:pr-10' : undefined}
                          aria-invalid={proxyInvalid || undefined}
                          aria-describedby={proxyInvalid ? proxyErrorId : undefined}
                          onInput={(event) => setProxyUrl(event.currentTarget.value)}
                        />
                        {proxyHasCredentials && (
                          <button
                            type="button"
                            aria-label={t(showProxyUrl ? 'Hide proxy URL' : 'Show proxy URL')}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            onClick={() => setShowProxyUrl((visible) => !visible)}
                          >
                            {showProxyUrl ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        )}
                      </div>
                    </SettingsSubRow>
                  )}
                </div>
                <SettingsSubRow rowId="providers.request-headers" label={t('Request headers')}>
                  <SettingsButton
                    variant="ghost"
                    onClick={() =>
                      setHeaderRows((current) => [
                        ...current,
                        { key: crypto.randomUUID(), name: '', value: '' },
                      ])
                    }
                  >
                    + {t('Add header')}
                  </SettingsButton>
                </SettingsSubRow>
                {(headerRows.length > 0 || headerValueInvalid) && (
                  <div className="space-y-2 border-border border-b py-2 pl-10">
                    {headerRows.map((row) => {
                      const nameInvalid =
                        row.name.trim() !== '' && !HEADER_NAME_RE.test(row.name.trim());
                      const valueInvalid =
                        row.value.trim() !== '' && !isSendableHeaderValue(row.value.trim());
                      return (
                        <div key={row.key} className="flex min-w-0 items-center gap-2">
                          <Input
                            value={row.name}
                            placeholder="Header-Name"
                            aria-invalid={nameInvalid || undefined}
                            spellCheck={false}
                            className="min-w-0 flex-1"
                            onChange={(event) =>
                              setHeaderRows((current) =>
                                current.map((entry) =>
                                  entry.key === row.key
                                    ? { ...entry, name: event.target.value }
                                    : entry
                                )
                              )
                            }
                          />
                          <Input
                            value={row.value}
                            aria-invalid={valueInvalid || undefined}
                            spellCheck={false}
                            className="min-w-0 flex-1"
                            onChange={(event) =>
                              setHeaderRows((current) =>
                                current.map((entry) =>
                                  entry.key === row.key
                                    ? { ...entry, value: event.target.value }
                                    : entry
                                )
                              )
                            }
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="shrink-0"
                            aria-label={t('Remove header')}
                            onClick={() =>
                              setHeaderRows((current) =>
                                current.filter((entry) => entry.key !== row.key)
                              )
                            }
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      );
                    })}
                    {headerValueInvalid ? (
                      <p role="alert" className="text-destructive-text text-xs">
                        {t(
                          'Header values can only contain tab and single-byte characters (no Chinese, newlines, or NUL).'
                        )}
                      </p>
                    ) : null}
                  </div>
                )}
              </SettingsExpandableRow>
            </div>
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
            {(!oauth || oauthAccountKey) && (
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
              <ListFilterBar
                query={filter}
                onQueryChange={setFilter}
                placeholder={t('Filter models...')}
                allSelected={selection.allSelected}
                someSelected={selection.someSelected}
                onToggleSelectAll={selection.toggleAll}
                onEnable={() => setSelectedEnabled(true)}
                onDisable={() => setSelectedEnabled(false)}
                selectDisabled={visibleModels.length === 0}
                actionDisabled={selection.selectedIds.length === 0}
              />

              {/* 列表自己限高滚动，到边界后由 useScrollChain 把滚轮交给对话框 */}
              <div
                ref={modelListRef}
                className="max-h-72 w-full space-y-0.5 overflow-y-auto border-border border-y py-1"
              >
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
                    canRemove={!oauth}
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
                    selected={selection.isSelected(model.id)}
                    onSelectedChange={(checked) => selection.toggleOne(model.id, checked)}
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

          {/* OAuth 条目的清单归统一目录管：手动添加的 id 保存时会被当无意图行丢弃，
              不渲染入口以免误导。需要新模型请走静态表补丁或目录刷新。 */}
          {!oauth && (
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
          )}
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
              value={availableTestModel}
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
          {status &&
            (status.ok ? (
              <span className="flex min-w-0 items-center gap-1 text-emerald-600 text-xs dark:text-emerald-500">
                <CircleCheck className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{status.text}</span>
              </span>
            ) : (
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 text-destructive text-xs underline-offset-2 hover:underline"
                onClick={() => setErrorDetail(status.text)}
              >
                <CircleX className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{status.text}</span>
              </button>
            ))}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button
            size="sm"
            disabled={
              saveDisabled ||
              !name.trim() ||
              headersInvalid ||
              proxyInvalid ||
              refreshIntervalInvalid
            }
            onClick={() =>
              onSave(
                {
                  name: name.trim(),
                  api,
                  apiKey: apiKey.trim(),
                  baseUrl: baseUrl.trim(),
                  models: commitPendingModel(models, newModel),
                  headers,
                  proxy,
                  ...(showModelRefresh && refreshIntervalValid
                    ? { autoFetchModels, modelRefreshIntervalHours: refreshIntervalHours }
                    : {}),
                },
                seenModelIds
              )
            }
          >
            {t('Save')}
          </Button>
        </div>
      </DialogFooter>

      <Dialog open={errorDetail !== null} onOpenChange={(open) => !open && setErrorDetail(null)}>
        <DialogPopup zIndexLevel="nested" className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('Connection failed')}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <pre className="max-h-80 select-text overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
              {errorDetail}
            </pre>
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setErrorDetail(null)}>
              {t('Close')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
