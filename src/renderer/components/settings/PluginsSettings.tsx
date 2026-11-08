import type { PluginArtifactInfo } from '@shared/extensionPlugins/protocol';
import type {
  ExtensionPluginConfigField,
  ExtensionPluginInstallPreview,
  ExtensionPluginSummary,
  RegistryNotice,
} from '@shared/extensionPlugins/types';
import type { InstalledPluginInfo, PluginComponentSummary, PluginEntry } from '@shared/types';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Files,
  FileText,
  FolderOpen,
  Link2,
  Package,
  Puzzle,
  RefreshCw,
  RotateCw,
  Settings2,
  Store,
  Trash2,
} from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { PluginArtifactList } from '@/plugins/artifactViews';
import { coerceConfigValue } from '@/plugins/configValue';
import { PluginIcon } from '@/plugins/PluginIcon';
import { pluginPermissionLabel } from '@/plugins/pluginMeta';
import { usePluginThemesStore } from '@/stores/pluginThemes';
import { useSettingsStore } from '@/stores/settings';
import { NewSessionBadge } from './NewSessionBadge';
import { PluginMarket } from './PluginMarket';
import { PluginReadmeDialog } from './PluginReadmeDialog';
import { RegistryNoticeBanner } from './RegistryNoticeBanner';

/** 插件配置表单：密钥不回显，留空保持不变 */
function ExtensionPluginConfigForm({ pluginId, plain }: { pluginId: string; plain?: boolean }) {
  const { t } = useI18n();
  const [fields, setFields] = React.useState<ExtensionPluginConfigField[]>([]);
  const [draft, setDraft] = React.useState<Record<string, string | boolean | null>>({});
  const [message, setMessage] = React.useState<{ error: boolean; text: string } | null>(null);

  const load = React.useCallback(async () => {
    const result = await window.electronAPI.extensionPlugins.configGet(pluginId);
    if (result.ok) setFields(result.fields);
    else setMessage({ error: true, text: result.error });
    setDraft({});
  }, [pluginId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const patch: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(draft)) {
      const field = fields.find((item) => item.key === key);
      if (!field || (field.secret && value === '')) continue;
      const coerced = coerceConfigValue(field, value);
      if (!coerced.ok) {
        setMessage({ error: true, text: `${field.title}：${coerced.error}` });
        return;
      }
      patch[key] = coerced.value;
    }
    const result = await window.electronAPI.extensionPlugins.configSet(pluginId, patch);
    setMessage(
      result.ok
        ? { error: false, text: t('Saved. New calls use it right away.') }
        : { error: true, text: result.error ?? '' }
    );
    if (result.ok) await load();
  };

  const textOf = (field: ExtensionPluginConfigField) => {
    const drafted = draft[field.key];
    if (typeof drafted === 'string') return drafted;
    if (drafted === null) return '';
    if (field.secret) return '';
    return field.value ?? (field.default !== undefined ? String(field.default) : '');
  };

  const checkedOf = (field: ExtensionPluginConfigField) => {
    const drafted = draft[field.key];
    if (typeof drafted === 'boolean') return drafted;
    const raw =
      field.value ?? (typeof field.default === 'boolean' ? String(field.default) : 'false');
    return raw === 'true';
  };

  return (
    <div className={cn('space-y-2', plain ? '' : 'rounded-md border border-border p-3')}>
      {fields.map((field) => (
        <div key={field.key} className="space-y-1">
          <p className="text-sm">
            {field.title}
            <span className="ml-2 font-mono text-muted-foreground text-xs">{field.key}</span>
          </p>
          {field.description && (
            <p className="text-muted-foreground text-xs">{field.description}</p>
          )}
          {field.multiline && field.type === 'string' ? (
            <div className="flex items-start gap-2">
              <Textarea
                autoComplete="off"
                rows={4}
                value={textOf(field)}
                placeholder={
                  field.secret && field.set ? t('Set (leave blank to keep)') : t('Not set')
                }
                className="min-w-0 flex-1"
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))
                }
              />
              {field.set && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDraft((prev) => ({ ...prev, [field.key]: null }))}
                >
                  {t('Clear value')}
                </Button>
              )}
            </div>
          ) : field.secret ||
            field.type === 'string' ||
            field.type === 'number' ||
            field.type === 'path' ? (
            <div className="flex items-center gap-2">
              <Input
                type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'}
                autoComplete="off"
                inputMode={field.type === 'number' ? 'decimal' : undefined}
                min={field.type === 'number' ? field.min : undefined}
                max={field.type === 'number' ? field.max : undefined}
                value={textOf(field)}
                placeholder={
                  field.secret && field.set ? t('Set (leave blank to keep)') : t('Not set')
                }
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))
                }
              />
              {field.type === 'path' && !field.secret && !window.electronAPI.remote && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void window.electronAPI.extensionPlugins
                      .pickPath(field.pathKind === 'directory' ? 'directory' : 'file')
                      .then((result) => {
                        if (result.ok && 'path' in result)
                          setDraft((prev) => ({ ...prev, [field.key]: result.path }));
                      });
                  }}
                >
                  {field.pathKind === 'directory' ? '选择文件夹' : '选择文件'}
                </Button>
              )}
              {field.set && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDraft((prev) => ({ ...prev, [field.key]: null }))}
                >
                  {t('Clear value')}
                </Button>
              )}
            </div>
          ) : field.type === 'boolean' ? (
            <Switch
              checked={checkedOf(field)}
              onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, [field.key]: checked }))}
            />
          ) : (
            <Select
              items={Object.fromEntries((field.options ?? []).map((option) => [option, option]))}
              value={textOf(field)}
              onValueChange={(value) => {
                if (typeof value === 'string')
                  setDraft((prev) => ({ ...prev, [field.key]: value }));
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="请选择" />
              </SelectTrigger>
              <SelectPopup>
                {(field.options ?? []).map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        </div>
      ))}
      {message && (
        <p className={cn('text-xs', message.error ? 'text-destructive' : 'text-muted-foreground')}>
          {message.text}
        </p>
      )}
      <Button size="sm" disabled={Object.keys(draft).length === 0} onClick={() => void save()}>
        {t('Save')}
      </Button>
    </div>
  );
}

/** Enso 自己的插件：安装时展示权限并征得同意，更新扩大授权要重新同意 */
function ExtensionPluginLogs({ pluginId, plain }: { pluginId: string; plain?: boolean }) {
  const { t } = useI18n();
  const [text, setText] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const result = await window.electronAPI.extensionPlugins.logs(pluginId);
    setText(result.ok ? result.text : result.error);
  }, [pluginId]);
  React.useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className={cn('space-y-2', plain ? '' : 'rounded-md border border-border p-3')}>
      <div className="flex items-center justify-between">
        <p className="text-sm">{t('Plugin logs')}</p>
        <Button size="icon" variant="ghost" aria-label={t('Refresh')} onClick={() => void load()}>
          <RefreshCw className="size-4" />
        </Button>
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-muted-foreground text-xs">
        {text === null ? '' : text || t('No logs yet')}
      </pre>
    </div>
  );
}

function PluginErrorText({ message }: { message: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="space-y-0.5">
      <p
        className={cn(
          'select-text break-all font-mono text-destructive text-xs',
          open ? 'max-h-48 overflow-auto whitespace-pre-wrap' : 'line-clamp-2'
        )}
      >
        {message}
      </p>
      {message.length > 120 && (
        <button
          type="button"
          className="text-muted-foreground text-xs hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  );
}

function PermissionLines({
  permissions,
  styles = false,
}: {
  permissions: readonly string[];
  styles?: boolean;
}) {
  if (permissions.length === 0)
    return styles ? null : <p className="text-muted-foreground text-xs">无特殊权限</p>;
  return (
    <ul className="space-y-0.5">
      {permissions.map((permission) => (
        <li key={permission} className="text-xs">
          <span className="font-mono text-muted-foreground">{permission}</span>
          <span className="ml-2">{pluginPermissionLabel(permission)}</span>
        </li>
      ))}
    </ul>
  );
}

function scheduleLine(item: {
  id: string;
  intervalSeconds: number;
  lastRunAt?: number;
  lastError?: string;
}) {
  const every =
    item.intervalSeconds >= 60 && item.intervalSeconds % 60 === 0
      ? `每 ${item.intervalSeconds / 60} 分钟`
      : `每 ${item.intervalSeconds} 秒`;
  const last = item.lastRunAt ? ` · 最近 ${new Date(item.lastRunAt).toLocaleString()}` : '';
  return `${item.id} · ${every}${last}${item.lastError ? ` · ${item.lastError}` : ''}`;
}

/** 折叠状态下的一行摘要：不展开也能看出这个插件要了多少能力 */
function capabilitySummary(plugin: ExtensionPluginSummary): string {
  return [
    plugin.permissions.length > 0 ? `${plugin.permissions.length} 项权限` : '',
    (plugin.events?.length ?? 0) > 0 ? `${plugin.events?.length} 个事件` : '',
    (plugin.schedules?.length ?? 0) > 0 ? `${plugin.schedules?.length} 个定时任务` : '',
    plugin.crossSessionInject !== undefined ? '跨会话投递开关' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function PluginCapabilityBlock({
  permissions,
  env,
  interop,
  resident,
  running,
  styles,
  events,
  schedules,
}: {
  permissions: readonly string[];
  env?: readonly string[];
  interop?: readonly string[];
  resident?: boolean;
  running?: boolean;
  styles?: boolean;
  events?: readonly { event: string; mode: string; failClosed?: boolean }[];
  schedules?: readonly {
    id: string;
    intervalSeconds: number;
    lastRunAt?: number;
    lastError?: string;
  }[];
}) {
  return (
    <div className="space-y-1">
      <PermissionLines permissions={permissions} styles={styles} />
      {resident && (
        <p className="text-xs">
          常驻进程
          {running === undefined ? '' : running ? '：运行中' : '：未运行'}
        </p>
      )}
      {styles && <p className="text-xs">修改界面样式：主题 CSS 可以改变应用的任意界面</p>}
      {(env?.length ?? 0) > 0 && (
        <p className="text-xs">
          环境变量：<span className="font-mono">{env?.join(', ')}</span>
        </p>
      )}
      {(interop?.length ?? 0) > 0 && (
        <p className="text-xs">
          可调用插件：<span className="font-mono">{interop?.join(', ')}</span>
        </p>
      )}
      {events?.map((event) => (
        <p key={`${event.event}:${event.mode}`} className="text-xs">
          事件 {event.event} · {event.mode === 'intercept' ? '拦截' : '观察'}
          {event.failClosed ? ' · 失败即拒绝' : ''}
        </p>
      ))}
      {schedules?.map((item) => (
        <p key={item.id} className="text-xs">
          定时任务 {scheduleLine(item)}
        </p>
      ))}
    </div>
  );
}

function ExtensionPluginArtifacts({ pluginId, plain }: { pluginId: string; plain?: boolean }) {
  const [items, setItems] = React.useState<PluginArtifactInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const result = await window.electronAPI.extensionPlugins.artifactsList(pluginId);
    if (result.ok) {
      setItems(result.artifacts);
      setError(null);
    } else setError(result.error);
  }, [pluginId]);
  React.useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className={cn('space-y-2', plain ? '' : 'rounded-md border border-border p-3')}>
      <div className="flex items-center justify-between">
        <p className="text-sm">产出文件</p>
        <Button size="icon" variant="ghost" aria-label="刷新" onClick={() => void load()}>
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
      <PluginArtifactList
        artifacts={items ?? []}
        onDelete={(id) => {
          void window.electronAPI.extensionPlugins.artifactDelete(id).then((result) => {
            if (result.ok) void load();
            else setError(result.error ?? '删除失败');
          });
        }}
      />
    </div>
  );
}

/** Enso 自己的插件：安装时展示权限并征得同意，更新扩大授权要重新同意 */
const stagingInstallUrls = new Set<string>();

export function EnsoPluginsSettings({
  requestedInstallUrl = null,
  onRequestedInstallUrlConsumed,
  focusPluginId = null,
  onFocusPluginConsumed,
}: {
  requestedInstallUrl?: string | null;
  onRequestedInstallUrlConsumed?: () => void;
  focusPluginId?: string | null;
  onFocusPluginConsumed?: () => void;
} = {}) {
  const { t } = useI18n();
  const pluginAutoUpdate = useSettingsStore((state) => state.pluginAutoUpdate !== false);
  const setPluginAutoUpdate = useSettingsStore((state) => state.setPluginAutoUpdate);
  const [plugins, setPlugins] = React.useState<ExtensionPluginSummary[]>([]);
  const themeErrors = usePluginThemesStore((state) => state.errors);
  const [preview, setPreview] = React.useState<ExtensionPluginInstallPreview | null>(null);
  const [panel, setPanel] = React.useState<{
    kind: 'config' | 'logs' | 'artifacts';
    pluginId: string;
    pluginName: string;
  } | null>(null);
  const [expanded, setExpanded] = React.useState<readonly string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState('');
  const [downloading, setDownloading] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [checkResult, setCheckResult] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<RegistryNotice | null>(null);
  const [marketOpen, setMarketOpen] = React.useState(false);
  const [guide, setGuide] = React.useState<{
    id: string;
    name: string;
    from: 'installed' | 'market';
    homepage?: string;
  } | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setPlugins(await window.electronAPI.extensionPlugins.list());
    } catch {
      setPlugins([]);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    void window.electronAPI.extensionPlugins
      .registryNotice()
      .then(setNotice)
      .catch(() => setNotice(null));
    return window.electronAPI.extensionPlugins.onChanged(() => void refresh());
  }, [refresh]);

  React.useEffect(() => {
    if (!focusPluginId) return;
    setExpanded((prev) => (prev.includes(focusPluginId) ? prev : [...prev, focusPluginId]));
    if (!plugins.some((plugin) => plugin.id === focusPluginId)) return;
    const id = focusPluginId;
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-plugin-id="${CSS.escape(id)}"]`)?.scrollIntoView({
        block: 'center',
      });
    });
    onFocusPluginConsumed?.();
  }, [focusPluginId, plugins, onFocusPluginConsumed]);

  const stage = async (kind: 'dir' | 'zip') => {
    setError(null);
    if (preview) void window.electronAPI.extensionPlugins.discard(preview.token);
    setPreview(null);
    const result = await window.electronAPI.extensionPlugins.pickAndStage(kind);
    if (!result.ok) setError(result.error);
    else if (!('cancelled' in result)) setPreview(result.preview);
  };

  const stageUrl = async (raw?: string) => {
    const value = (raw ?? url).trim();
    if (!value) return;
    setError(null);
    setDownloading(true);
    if (preview) void window.electronAPI.extensionPlugins.discard(preview.token);
    setPreview(null);
    const result = await window.electronAPI.extensionPlugins.stageFromUrl(value).finally(() => {
      setDownloading(false);
    });
    if (!result.ok) setError(result.error);
    else setPreview(result.preview);
  };
  const stageUrlRef = React.useRef(stageUrl);
  stageUrlRef.current = stageUrl;

  React.useEffect(() => {
    if (!requestedInstallUrl) return;
    const installUrl = requestedInstallUrl;
    let cancelled = false;
    // StrictMode 会立刻卸掉第一次 effect；推迟到下一拍，避免对已卸载的实例发起暂存
    const timer = window.setTimeout(() => {
      if (cancelled || stagingInstallUrls.has(installUrl)) return;
      stagingInstallUrls.add(installUrl);
      setUrl(installUrl);
      onRequestedInstallUrlConsumed?.();
      void stageUrlRef.current(installUrl).finally(() => {
        stagingInstallUrls.delete(installUrl);
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [requestedInstallUrl, onRequestedInstallUrlConsumed]);

  const restage = async (id: string, fromMarket = false) => {
    setError(null);
    if (preview) void window.electronAPI.extensionPlugins.discard(preview.token);
    setPreview(null);
    setDownloading(true);
    const api = window.electronAPI.extensionPlugins;
    const result = await (fromMarket ? api.marketStage(id) : api.restage(id)).finally(() => {
      setDownloading(false);
    });
    if (!result.ok) setError(result.error);
    else setPreview(result.preview);
  };

  const checkUpdates = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await window.electronAPI.extensionPlugins.checkUpdates();
      setCheckResult(
        result.checked === 0
          ? t('No plugins installed from GitHub to check')
          : result.available > 0
            ? t('{{count}} update(s) available', { count: result.available })
            : t('All plugins are up to date')
      );
    } finally {
      setChecking(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    const result = await window.electronAPI.extensionPlugins.commit(preview.token);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? t('Install failed'));
    } else {
      setUrl('');
      const enabled = preview.existingVersion
        ? { ok: true }
        : await window.electronAPI.extensionPlugins.setEnabled(preview.id, true);
      addToast({
        type: enabled.ok ? 'success' : 'warning',
        title: t('{{name}} installed', { name: preview.name }),
        description: enabled.ok ? undefined : enabled.error,
      });
    }
    setPreview(null);
  };

  const discard = () => {
    if (preview) void window.electronAPI.extensionPlugins.discard(preview.token);
    setPreview(null);
  };

  return (
    <div className="space-y-5" data-settings-row="plugins.enso">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-medium text-lg">
            {t('Enso plugins')}
            <NewSessionBadge />
          </h3>
          <p className="mt-1 text-muted-foreground text-sm">
            {t(
              'Installing a plugin lets it run code on this machine. Review what it asks for before confirming.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {plugins.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={checking}
              onClick={() => void checkUpdates()}
            >
              {checking ? <Spinner /> : <RefreshCw className="size-4" />}
              {t('Check for updates')}
            </Button>
          )}
          <Button size="sm" onClick={() => setMarketOpen(true)}>
            <Store className="size-4" />
            {t('Marketplace')}
          </Button>
        </div>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0">
          <span className="block">{t('Update plugins automatically')}</span>
          <span className="block text-muted-foreground text-xs">
            {t('Marketplace updates that do not ask for new permissions install on their own.')}
          </span>
        </span>
        <Switch
          className="shrink-0"
          checked={pluginAutoUpdate}
          onCheckedChange={(on) => setPluginAutoUpdate(on)}
        />
      </label>
      <div className="space-y-2.5 rounded-lg border bg-muted/30 p-3">
        <div className="flex gap-2">
          <InputGroup className="flex-1">
            <InputGroupAddon>
              <Link2 className="size-4 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              value={url}
              placeholder={t('https://github.com/owner/repo')}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void stageUrl();
              }}
            />
          </InputGroup>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || downloading || url.trim() === ''}
            onClick={() => void stageUrl()}
          >
            {downloading ? <Spinner /> : t('Install from URL')}
          </Button>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground text-xs">
          <span className="mr-1">{t('Or install from')}</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || downloading}
            onClick={() => void stage('dir')}
          >
            <FolderOpen className="size-3.5" />
            {t('Install from folder')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || downloading}
            onClick={() => void stage('zip')}
          >
            <Package className="size-3.5" />
            {t('Install from zip')}
          </Button>
        </div>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Dialog open={marketOpen} onOpenChange={setMarketOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('Marketplace')}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <PluginMarket
              disabled={busy || downloading}
              installedKey={plugins.map((p) => `${p.id}@${p.version}`).join(',')}
              onInstall={(id) => {
                setMarketOpen(false);
                void restage(id, true);
              }}
              onGuide={(id, name, homepage) => {
                setMarketOpen(false);
                setGuide({ id, name, from: 'market', homepage });
              }}
            />
          </DialogPanel>
        </DialogContent>
      </Dialog>
      {checkResult && <p className="text-muted-foreground text-sm">{checkResult}</p>}
      {notice && (
        <RegistryNoticeBanner
          notice={notice}
          remote={Boolean(window.electronAPI.remote)}
          onDismiss={() =>
            void window.electronAPI.extensionPlugins
              .dismissRegistryNotice()
              .then(() => setNotice(null))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          }
        />
      )}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && !busy && discard()}>
        <DialogContent>
          {preview && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {preview.name} {preview.version}
                  {preview.existingVersion && (
                    <span className="ml-2 text-base text-muted-foreground">
                      {t('updating from {{version}}', { version: preview.existingVersion })}
                    </span>
                  )}
                </DialogTitle>
              </DialogHeader>
              <DialogPanel className="space-y-3">
                <PluginCapabilityBlock
                  permissions={preview.permissions}
                  env={preview.env}
                  interop={preview.interop}
                  resident={preview.resident}
                  styles={preview.styles}
                  events={preview.events}
                  schedules={preview.schedules}
                />
                {preview.mcpServers.map((server) => (
                  <p key={server.name} className="font-mono text-xs">
                    {server.command} {server.args.join(' ')}
                  </p>
                ))}
                {preview.mcpTools.length > 0 && (
                  <p className="text-muted-foreground text-xs">
                    {t('Host MCP tools it may call')}：
                    <span className="font-mono">{preview.mcpTools.join(', ')}</span>
                  </p>
                )}
                {preview.warnings.map((warning) => (
                  <p key={warning} className="text-muted-foreground text-xs">
                    {warning}
                  </p>
                ))}
              </DialogPanel>
              <DialogFooter>
                <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>
                  {t('Cancel')}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void commit()}>
                  {busy ? <Spinner /> : t('Install')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {plugins.length === 0 && !preview && (
        <div className="rounded-lg border border-dashed px-3 py-10 text-center">
          <Puzzle className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-3 font-medium text-sm">{t('No Enso plugins installed')}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            {t('Browse the marketplace or install from a GitHub URL, folder or zip.')}
          </p>
        </div>
      )}
      <div className="space-y-2">
        {plugins.map((plugin) => (
          <div
            key={plugin.id}
            data-plugin-id={plugin.id}
            className={cn(
              'overflow-hidden rounded-lg border bg-card transition-colors',
              plugin.state === 'crashed' && 'border-destructive/50'
            )}
          >
            <div className="flex items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 items-start gap-3">
                <div
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-md bg-muted',
                    plugin.state === 'enabled' ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  <PluginIcon pluginId={plugin.id} icon={plugin.icon} className="size-4" />
                </div>
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="truncate font-medium">{plugin.name}</span>
                    <Badge variant="outline" className="text-[11px]">
                      {plugin.version}
                    </Badge>
                    {plugin.state === 'crashed' && (
                      <Badge variant="destructive" className="text-[11px]">
                        {t('Stopped after crashes')}
                      </Badge>
                    )}
                    {plugin.availableVersion && (
                      <Badge className="text-[11px]">{t('Update')}</Badge>
                    )}
                    {plugin.pendingVersion && (
                      <Badge variant="warning" className="text-[11px]">
                        待授权
                      </Badge>
                    )}
                    {plugin.resident && (
                      <Badge
                        variant={plugin.running ? 'secondary' : 'outline'}
                        className="text-[11px]"
                      >
                        {plugin.running ? '常驻运行中' : '常驻未运行'}
                      </Badge>
                    )}
                  </p>
                  <p className="truncate font-mono text-muted-foreground text-xs">{plugin.id}</p>
                  {plugin.availableVersion && (
                    <p className="mt-1 flex items-center gap-2 text-primary text-xs">
                      {t('Version {{version}} is available', { version: plugin.availableVersion })}
                      <Button
                        size="xs"
                        disabled={busy || downloading}
                        onClick={() => void restage(plugin.id, plugin.source?.kind !== 'url')}
                      >
                        {downloading ? <Spinner /> : t('Update')}
                      </Button>
                    </p>
                  )}
                  {plugin.updateCheckError && (
                    <p className="text-muted-foreground text-xs">
                      {t('Update check failed: {{reason}}', { reason: plugin.updateCheckError })}
                    </p>
                  )}
                  {plugin.lastError && <PluginErrorText message={plugin.lastError.message} />}
                  {themeErrors[plugin.id]?.map((error) => (
                    <PluginErrorText key={error} message={`主题加载失败：${error}`} />
                  ))}
                  {plugin.pendingVersion && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-amber-700 text-xs dark:text-amber-400">
                      {t('{{version}} asks for more and is waiting for approval', {
                        version: plugin.pendingVersion,
                      })}
                      <Button
                        size="xs"
                        onClick={() =>
                          void window.electronAPI.extensionPlugins.approvePending(plugin.id)
                        }
                      >
                        {t('Allow')}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          void window.electronAPI.extensionPlugins.rejectPending(plugin.id)
                        }
                      >
                        {t('Keep current')}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {plugin.source && (
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busy || downloading}
                    aria-label={t('Reinstall from source')}
                    title={
                      plugin.source.kind === 'url'
                        ? `${t('Reinstall from source')}: ${plugin.source.url}`
                        : t('Reinstall from source')
                    }
                    onClick={() => void restage(plugin.id)}
                  >
                    <RotateCw className="size-4" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="产出文件"
                  title="产出文件"
                  onClick={() =>
                    setPanel({ kind: 'artifacts', pluginId: plugin.id, pluginName: plugin.name })
                  }
                >
                  <Files className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('Usage guide')}
                  title={t('Usage guide')}
                  onClick={() => setGuide({ id: plugin.id, name: plugin.name, from: 'installed' })}
                >
                  <BookOpen className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('Plugin logs')}
                  title={t('Plugin logs')}
                  onClick={() =>
                    setPanel({ kind: 'logs', pluginId: plugin.id, pluginName: plugin.name })
                  }
                >
                  <FileText className="size-4" />
                </Button>
                {plugin.configurable && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('Configure')}
                    title={t('Configure')}
                    onClick={() =>
                      setPanel({ kind: 'config', pluginId: plugin.id, pluginName: plugin.name })
                    }
                  >
                    <Settings2 className="size-4" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('Uninstall')}
                  title={t('Uninstall')}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void window.electronAPI.extensionPlugins.uninstall(plugin.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
                <div className="mx-1.5 h-5 w-px bg-border" />
                <Switch
                  checked={plugin.state === 'enabled'}
                  onCheckedChange={(enabled) =>
                    void window.electronAPI.extensionPlugins.setEnabled(plugin.id, enabled)
                  }
                />
              </div>
            </div>
            <button
              type="button"
              aria-expanded={expanded.includes(plugin.id)}
              className={cn(
                'flex w-full items-center gap-1 border-t bg-muted/20 px-3 py-1.5 text-left text-xs',
                'text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground'
              )}
              onClick={() =>
                setExpanded((prev) =>
                  prev.includes(plugin.id)
                    ? prev.filter((id) => id !== plugin.id)
                    : [...prev, plugin.id]
                )
              }
            >
              {expanded.includes(plugin.id) ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              {expanded.includes(plugin.id) ? '收起详情' : '详情'}
              {!expanded.includes(plugin.id) && capabilitySummary(plugin) && (
                <span className="ml-1 opacity-70">{capabilitySummary(plugin)}</span>
              )}
            </button>
            {expanded.includes(plugin.id) && (
              <div className="space-y-3 border-t px-3 py-3">
                {plugin.interceptBreakers?.map((breaker) => (
                  <p key={breaker.event} className="text-amber-600 text-xs dark:text-amber-400">
                    {breaker.event} 检查连续失败，临时放行到{' '}
                    {new Date(breaker.until).toLocaleTimeString()}
                  </p>
                ))}
                <PluginCapabilityBlock
                  permissions={plugin.permissions}
                  resident={plugin.resident}
                  running={plugin.running}
                  styles={plugin.themes.some((theme) => theme.css !== undefined)}
                  events={plugin.events}
                  schedules={plugin.schedules}
                />
                {plugin.crossSessionInject !== undefined && (
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span>
                      <span className="block">允许向任意运行中的会话发送消息</span>
                      <span className="block text-muted-foreground">
                        关闭时只能发到发起调用的会话；开启后定时任务、常驻进程也能向其他项目和窗口的会话发消息并触发执行
                      </span>
                    </span>
                    <Switch
                      aria-label="允许向任意运行中的会话发送消息"
                      checked={plugin.crossSessionInject}
                      onCheckedChange={(allowed) =>
                        void window.electronAPI.extensionPlugins.setCrossSessionInject(
                          plugin.id,
                          allowed
                        )
                      }
                    />
                  </div>
                )}
                {plugin.pendingPermissions && plugin.pendingPermissions.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs">待同意的权限</p>
                    <PermissionLines permissions={plugin.pendingPermissions} />
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <Dialog open={panel !== null} onOpenChange={(open) => !open && setPanel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {panel?.kind === 'config'
                ? t('Configure')
                : panel?.kind === 'logs'
                  ? t('Plugin logs')
                  : '产出文件'}
              {panel ? ` · ${panel.pluginName}` : ''}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {panel?.kind === 'config' && (
              <ExtensionPluginConfigForm pluginId={panel.pluginId} plain />
            )}
            {panel?.kind === 'logs' && <ExtensionPluginLogs pluginId={panel.pluginId} plain />}
            {panel?.kind === 'artifacts' && (
              <ExtensionPluginArtifacts pluginId={panel.pluginId} plain />
            )}
          </DialogPanel>
        </DialogContent>
      </Dialog>
      <PluginReadmeDialog
        pluginId={guide?.id ?? null}
        name={guide?.name ?? ''}
        from={guide?.from ?? 'installed'}
        homepage={guide?.homepage}
        onClose={() => setGuide(null)}
      />
    </div>
  );
}

function componentCounts(
  components: PluginComponentSummary,
  t: ReturnType<typeof useI18n>['t']
): string {
  return [
    [components.skills.length, t('Skills')],
    [components.commands.length, t('Commands')],
    [components.agents.length, t('Agent types')],
    [components.mcpServers.length, 'MCP'],
    [components.hooks.length, 'Hooks'],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, label]) => `${label} ${count}`)
    .join(' · ');
}

function Detail({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <p className="font-medium text-muted-foreground text-xs">{label}</p>
      {items.map((item) => (
        <p key={item} className="break-all font-mono text-[11px]">
          {item}
        </p>
      ))}
    </div>
  );
}

function PluginRow({
  plugin,
  entry,
  onToggle,
}: {
  plugin: InstalledPluginInfo;
  entry?: PluginEntry;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const { components } = plugin;
  const counts = componentCounts(components, t);
  return (
    <div className="rounded-md border" data-settings-row={`plugins.${plugin.key}`}>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90'
            )}
          />
          <span className="shrink-0 font-medium text-sm">{plugin.name}</span>
          {plugin.version && (
            <Badge variant="outline" className="shrink-0 text-[11px]">
              {plugin.version}
            </Badge>
          )}
          {plugin.marketplace && (
            <Badge variant="secondary" className="shrink-0 text-[11px]">
              {plugin.marketplace}
            </Badge>
          )}
          <span className="min-w-0 truncate text-muted-foreground text-xs">
            {counts ||
              (components.unsupported.length > 0
                ? `${t('Not supported')}: ${components.unsupported.join(', ')}`
                : t('No supported components'))}
          </span>
        </button>
        <Switch checked={entry?.enabled === true} onCheckedChange={onToggle} />
      </div>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {plugin.description && (
            <p className="text-muted-foreground text-xs">{plugin.description}</p>
          )}
          <Detail label={t('Skills')} items={components.skills} />
          <Detail label={t('Commands')} items={components.commands.map((name) => `/${name}`)} />
          <Detail label={t('Agent types')} items={components.agents} />
          <Detail
            label={t('MCP servers (run when a session starts)')}
            items={components.mcpServers.map((server) => `${server.name}: ${server.target}`)}
          />
          <Detail
            label={t('Hooks (run automatically on local sessions)')}
            items={components.hooks.map((hook) => `${hook.event}: ${hook.command}`)}
          />
          <Detail label={t('Not supported')} items={components.unsupported} />
        </div>
      )}
    </div>
  );
}

export function ClaudePluginsSettings() {
  const { t } = useI18n();
  const entries = useSettingsStore((state) => state.plugins);
  const addPlugins = useSettingsStore((state) => state.addPlugins);
  const setPluginEnabled = useSettingsStore((state) => state.setPluginEnabled);
  const removePlugin = useSettingsStore((state) => state.removePlugin);
  const [installed, setInstalled] = React.useState<InstalledPluginInfo[] | null>(null);

  const refresh = React.useCallback(async () => {
    setInstalled(null);
    try {
      setInstalled(await window.electronAPI.assets.listInstalledPlugins());
    } catch {
      setInstalled([]);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const installedKeys = new Set((installed ?? []).map((plugin) => plugin.key));
  const missing = installed ? entries.filter((entry) => !installedKeys.has(entry.key)) : [];
  const enabledCount = entries.filter((entry) => entry.enabled).length;

  const toggle = (plugin: InstalledPluginInfo, enabled: boolean) => {
    const entry = byKey.get(plugin.key);
    if (entry) {
      setPluginEnabled(entry.id, enabled);
      return;
    }
    addPlugins([
      {
        id: crypto.randomUUID(),
        key: plugin.key,
        name: plugin.name,
        description: plugin.description,
        ...(plugin.version ? { version: plugin.version } : {}),
        source: plugin.marketplace || 'Claude Code',
        enabled,
      },
    ]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4" data-settings-row="plugins.root">
        <div>
          <h3 className="font-medium text-lg">
            {t('Claude Code plugins')}
            <NewSessionBadge />
            {enabledCount > 0 && (
              <span className="ml-2 font-normal text-muted-foreground text-xs">
                {t('{{count}} enabled', { count: enabledCount })}
              </span>
            )}
          </h3>
          <p className="text-muted-foreground text-sm">
            {t(
              'Plugins installed in Claude Code. Each one is switched on or off as a whole here; changes apply to new sessions.'
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={installed === null}>
          <RefreshCw className="mr-1.5 h-4 w-4" />
          {t('Rescan')}
        </Button>
      </div>

      {installed === null ? (
        <div className="flex justify-center py-10">
          <Spinner className="size-5" />
        </div>
      ) : installed.length === 0 ? (
        <div className="rounded-md border border-dashed px-3 py-8 text-center">
          <Puzzle className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 font-medium text-sm">{t('No Claude Code plugins found')}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            {t('Install plugins with /plugin in Claude Code, then rescan.')}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {installed.map((plugin) => (
            <PluginRow
              key={plugin.key}
              plugin={plugin}
              entry={byKey.get(plugin.key)}
              onToggle={(enabled) => toggle(plugin, enabled)}
            />
          ))}
        </div>
      )}

      {missing.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium text-muted-foreground text-xs">
            {t('No longer installed in Claude Code')}
          </p>
          {missing.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-accent/50"
            >
              <span className="text-muted-foreground text-sm line-through">{entry.name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => removePlugin(entry.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
