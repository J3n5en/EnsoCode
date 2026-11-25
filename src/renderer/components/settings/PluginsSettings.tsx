import type { PluginArtifactInfo } from '@shared/extensionPlugins/protocol';
import type {
  ExtensionPluginConfigField,
  ExtensionPluginInstallPreview,
  ExtensionPluginSummary,
  RegistryNotice,
} from '@shared/extensionPlugins/types';
import {
  BookOpen,
  Check,
  Copy,
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
import { copyText } from '@/lib/copyText';
import { cn } from '@/lib/utils';
import { PluginArtifactList } from '@/plugins/artifactViews';
import { coerceConfigValue } from '@/plugins/configValue';
import { PluginIcon } from '@/plugins/PluginIcon';
import { pluginPermissionLabel } from '@/plugins/pluginMeta';
import { openSettings } from '@/stores/appView';
import { usePluginThemesStore } from '@/stores/pluginThemes';
import { useSettingsStore } from '@/stores/settings';
import {
  SettingsButton,
  SettingsEmptyState,
  SettingsExpandableRow,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
  SettingsSwitch,
} from './kit';
import { NewSessionBadge } from './NewSessionBadge';
import { PluginMarket } from './PluginMarket';
import { PluginModelConfigField } from './PluginModelConfigField';
import { PluginReadmeDialog } from './PluginReadmeDialog';
import { RegistryNoticeBanner } from './RegistryNoticeBanner';

/** 插件配置表单：密钥不回显，留空保持不变 */
function ExtensionPluginConfigForm({ pluginId }: { pluginId: string }) {
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
    <div className="space-y-2">
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
          ) : field.type === 'model' ? (
            <PluginModelConfigField
              value={textOf(field)}
              onChange={(value) => setDraft((prev) => ({ ...prev, [field.key]: value }))}
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

/** 超过这个行数就退回纯文本，避免几千个节点卡住面板 */
const MAX_LOG_LINES = 5000;
/** 与 Main 的 PluginLogger 写入格式一致：`<ISO> [level] message`；无前缀的是上一条的续行 */
const LOG_HEAD =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (\[(debug|info|warn|error)\] .*)$/;
/** 状态色本身是给底色用的，直接当字色在亮色（warn）和暗色（error）下都太淡；向前景色混一点，两种主题都清楚 */
const LOG_LEVEL_CLASS = {
  debug: 'text-muted-foreground/70',
  info: 'text-muted-foreground',
  warn: 'text-[color-mix(in_oklab,var(--color-warning)_60%,var(--color-foreground))]',
  error: 'text-[color-mix(in_oklab,var(--color-destructive)_55%,var(--color-foreground))]',
} as const;

type LogLine = { time: string | null; body: string; level: keyof typeof LOG_LEVEL_CLASS };

function parseLogLines(text: string): LogLine[] | null {
  const raw = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (raw.length > MAX_LOG_LINES) return null;
  let level: LogLine['level'] = 'info';
  return raw.map((line) => {
    const head = LOG_HEAD.exec(line);
    if (!head) return { time: null, body: line, level };
    level = head[3] as LogLine['level'];
    return { time: head[1] ?? null, body: head[2] ?? '', level };
  });
}

/** Enso 自己的插件：安装时展示权限并征得同意，更新扩大授权要重新同意 */
function ExtensionPluginLogs({ pluginId }: { pluginId: string }) {
  const { t } = useI18n();
  const pluginLoggingEnabled = useSettingsStore((state) => state.pluginLoggingEnabled === true);
  const [text, setText] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const load = React.useCallback(async () => {
    const result = await window.electronAPI.extensionPlugins.logs(pluginId);
    setText(result.ok ? result.text : result.error);
  }, [pluginId]);
  React.useEffect(() => {
    void load();
  }, [load]);
  const loggingWasOn = React.useRef(pluginLoggingEnabled);
  React.useEffect(() => {
    if (!loggingWasOn.current && pluginLoggingEnabled) void load();
    loggingWasOn.current = pluginLoggingEnabled;
  }, [pluginLoggingEnabled, load]);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const lines = React.useMemo(() => (text ? parseLogLines(text) : null), [text]);
  const showBody = pluginLoggingEnabled || (text !== null && text !== '');
  React.useLayoutEffect(() => {
    const box = scrollRef.current;
    if (box && text) box.scrollTop = box.scrollHeight;
  }, [text]);
  return (
    <div className="space-y-2">
      {!pluginLoggingEnabled && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm">{t('Plugin logging is off')}</p>
            <p className="text-muted-foreground text-xs">
              {t('New plugin logs are not recorded while off. Existing log files are kept.')}
            </p>
          </div>
          <SettingsButton onClick={() => openSettings({ category: 'logs', rowId: 'logs.root' })}>
            {t('Enable plugin logging')}
          </SettingsButton>
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm">{t('Plugin logs')}</p>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('Copy')}
            title={copied ? t('Copied') : t('Copy')}
            disabled={!text}
            onClick={() => {
              if (!text) return;
              void copyText(text).then((ok) => ok && setCopied(true));
            }}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
          <Button size="icon" variant="ghost" aria-label={t('Refresh')} onClick={() => void load()}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>
      {showBody && text && !lines && (
        <p className="text-muted-foreground text-xs">{t('Log too large, showing plain text')}</p>
      )}
      {showBody && (
        <div
          ref={scrollRef}
          className="max-h-96 select-text overflow-auto font-mono text-muted-foreground text-xs"
        >
          {lines ? (
            lines.map((line, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: 日志行无稳定标识，按位置渲染
                key={index}
                data-log-level={line.level}
                className={cn('whitespace-pre-wrap break-words', LOG_LEVEL_CLASS[line.level])}
              >
                {line.time && (
                  <>
                    <span data-log-time className="text-muted-foreground/60">
                      {line.time}
                    </span>{' '}
                  </>
                )}
                {line.body}
              </div>
            ))
          ) : (
            <pre className="whitespace-pre-wrap break-words">
              {text === null ? '' : text || t('No logs yet')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function PluginErrorText({ message }: { message: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <span className="mt-1 block space-y-0.5">
      <span
        className={cn(
          'block select-text break-all font-mono text-destructive text-xs',
          open ? 'max-h-48 overflow-auto whitespace-pre-wrap' : 'line-clamp-2'
        )}
      >
        {message}
      </span>
      {message.length > 120 && (
        <button
          type="button"
          className="text-muted-foreground text-xs hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '收起' : '展开全部'}
        </button>
      )}
    </span>
  );
}

function PermissionLines({
  permissions,
  styles = false,
  added = [],
}: {
  permissions: readonly string[];
  styles?: boolean;
  /** 更新时新增的权限：单独标出 */
  added?: readonly string[];
}) {
  const { t } = useI18n();
  if (permissions.length === 0)
    return styles ? null : <p className="text-muted-foreground text-xs">无特殊权限</p>;
  return (
    <ul className="space-y-0.5">
      {permissions.map((permission) => {
        const isAdded = added.includes(permission);
        return (
          <li
            key={permission}
            className={cn('text-xs', isAdded && 'font-medium text-amber-700 dark:text-amber-400')}
          >
            {isAdded && (
              <Badge variant="warning" className="mr-1.5 text-[11px]">
                {t('Added')}
              </Badge>
            )}
            <span className={cn('font-mono', !isAdded && 'text-muted-foreground')}>
              {permission}
            </span>
            <span className="ml-2">{pluginPermissionLabel(permission)}</span>
          </li>
        );
      })}
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
    plugin.hasRenderer ? '界面代码' : '',
    plugin.crossSessionInject !== undefined ? '跨会话投递开关' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function PluginCapabilityBlock({
  permissions,
  addedPermissions,
  env,
  interop,
  resident,
  running,
  styles,
  trustedUi,
  events,
  schedules,
}: {
  permissions: readonly string[];
  addedPermissions?: readonly string[];
  env?: readonly string[];
  interop?: readonly string[];
  resident?: boolean;
  running?: boolean;
  styles?: boolean;
  /** 带 ui.js：与主界面同权运行，不受权限清单约束 */
  trustedUi?: boolean;
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
      <PermissionLines
        permissions={permissions}
        styles={styles || trustedUi}
        added={addedPermissions}
      />
      {trustedUi && <TrustedUiLine />}
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

function TrustedUiLine() {
  return (
    <p className="text-amber-700 text-xs dark:text-amber-400">
      界面代码：运行在主界面里，可读写页面内容、调用界面能力，不受上面权限清单约束；只安装信任的插件
    </p>
  );
}

function InstallPreviewTitle({ preview }: { preview: ExtensionPluginInstallPreview }) {
  const { t } = useI18n();
  return (
    <>
      {preview.name} {preview.version}
      {preview.existingVersion && (
        <span className="ml-2 text-base text-muted-foreground">
          {t('updating from {{version}}', { version: preview.existingVersion })}
        </span>
      )}
    </>
  );
}

function InstallPreviewDetails({ preview }: { preview: ExtensionPluginInstallPreview }) {
  const { t } = useI18n();
  return (
    <>
      {preview.existingVersion && preview.expands && (
        <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-amber-700 text-xs dark:text-amber-400">
          {t(
            'This update asks for more than {{version}}. {{version}} keeps running until you allow the update in the plugin list.',
            { version: preview.existingVersion }
          )}
        </p>
      )}
      <PluginCapabilityBlock
        permissions={preview.permissions}
        addedPermissions={preview.addedPermissions}
        env={preview.env}
        interop={preview.interop}
        resident={preview.resident}
        styles={preview.styles}
        trustedUi={preview.hasRenderer}
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
    </>
  );
}

/** 确认按钮出现后稍等才可点：防止连点或按住回车把刚弹出的权限确认直接点掉 */
const CONFIRM_ARM_MS = 1000;

function ConfirmInstallButton({
  token,
  busy,
  onConfirm,
}: {
  token: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = React.useState<string | null>(null);
  React.useEffect(() => {
    const timer = setTimeout(() => setArmed(token), CONFIRM_ARM_MS);
    return () => clearTimeout(timer);
  }, [token]);
  return (
    <Button size="sm" disabled={busy || armed !== token} onClick={onConfirm}>
      {busy ? <Spinner /> : t('Install')}
    </Button>
  );
}

function ExtensionPluginArtifacts({ pluginId }: { pluginId: string }) {
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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm">产出文件</p>
        <SettingsButton size="icon" variant="ghost" aria-label="刷新" onClick={() => void load()}>
          <RefreshCw className="size-4" />
        </SettingsButton>
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

function ExtensionPluginRow({
  plugin,
  themeErrors,
  busy,
  downloading,
  forceOpen,
  onUpdate,
  onReinstall,
  onPanel,
  onGuide,
}: {
  plugin: ExtensionPluginSummary;
  themeErrors?: readonly string[];
  busy: boolean;
  downloading: boolean;
  /** 深链点到这一行时展开；之后由行内开关自己记 */
  forceOpen: boolean;
  onUpdate: () => void;
  onReinstall: () => void;
  onPanel: (kind: 'config' | 'logs' | 'artifacts') => void;
  onGuide: () => void;
}) {
  const { t } = useI18n();
  const summary = capabilitySummary(plugin);
  return (
    <div data-plugin-id={plugin.id}>
      <SettingsExpandableRow
        key={forceOpen ? 'open' : 'closed'}
        defaultOpen={forceOpen}
        label={
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-md bg-muted',
                plugin.state === 'enabled' ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              <PluginIcon pluginId={plugin.id} icon={plugin.icon} className="size-3.5" />
            </span>
            <span className={cn('truncate', plugin.state === 'crashed' && 'text-destructive')}>
              {plugin.name}
            </span>
            <Badge variant="outline" className="font-normal text-[11px]">
              {plugin.version}
            </Badge>
            {plugin.state === 'crashed' && (
              <Badge variant="destructive" className="font-normal text-[11px]">
                {t('Stopped after crashes')}
              </Badge>
            )}
            {plugin.availableVersion && (
              <Badge className="font-normal text-[11px]">{t('Update')}</Badge>
            )}
            {plugin.pendingVersion && (
              <Badge variant="warning" className="font-normal text-[11px]">
                待授权
              </Badge>
            )}
            {plugin.hasRenderer && (
              <Badge variant="outline" className="font-normal text-[11px]">
                受信任界面
              </Badge>
            )}
            {plugin.devWatch && (
              <Badge variant="secondary" className="font-normal text-[11px]">
                开发模式
              </Badge>
            )}
            {plugin.resident && (
              <Badge
                variant={plugin.running ? 'secondary' : 'outline'}
                className="font-normal text-[11px]"
              >
                {plugin.running ? '常驻运行中' : '常驻未运行'}
              </Badge>
            )}
          </span>
        }
        description={
          <>
            <span className="block truncate font-mono">{plugin.id}</span>
            {summary && <span className="mt-0.5 block">{summary}</span>}
            {plugin.availableVersion && (
              <span className="mt-1 flex flex-wrap items-center gap-2 text-primary">
                {t('Version {{version}} is available', { version: plugin.availableVersion })}
                <SettingsButton size="xs" disabled={busy || downloading} onClick={onUpdate}>
                  {downloading ? <Spinner /> : t('Update')}
                </SettingsButton>
              </span>
            )}
            {plugin.updateCheckError && (
              <span className="mt-1 block">
                {t('Update check failed: {{reason}}', { reason: plugin.updateCheckError })}
              </span>
            )}
            {plugin.lastError && <PluginErrorText message={plugin.lastError.message} />}
            {themeErrors?.map((item) => (
              <PluginErrorText key={item} message={`主题加载失败：${item}`} />
            ))}
            {plugin.pendingVersion && (
              <span className="mt-1 flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-400">
                {t('{{version}} asks for more and is waiting for approval', {
                  version: plugin.pendingVersion,
                })}
                <SettingsButton
                  size="xs"
                  variant="default"
                  onClick={() => void window.electronAPI.extensionPlugins.approvePending(plugin.id)}
                >
                  {t('Allow')}
                </SettingsButton>
                <SettingsButton
                  size="xs"
                  variant="ghost"
                  onClick={() => void window.electronAPI.extensionPlugins.rejectPending(plugin.id)}
                >
                  {t('Keep current')}
                </SettingsButton>
              </span>
            )}
          </>
        }
        control={
          <>
            {plugin.source && (
              <SettingsButton
                size="icon"
                variant="ghost"
                disabled={busy || downloading}
                aria-label={t('Reinstall from source')}
                title={
                  plugin.source.kind === 'url'
                    ? `${t('Reinstall from source')}: ${plugin.source.url}`
                    : t('Reinstall from source')
                }
                onClick={onReinstall}
              >
                <RotateCw className="size-4" />
              </SettingsButton>
            )}
            <SettingsButton
              size="icon"
              variant="ghost"
              aria-label="产出文件"
              title="产出文件"
              onClick={() => onPanel('artifacts')}
            >
              <Files className="size-4" />
            </SettingsButton>
            <SettingsButton
              size="icon"
              variant="ghost"
              aria-label={t('Usage guide')}
              title={t('Usage guide')}
              onClick={onGuide}
            >
              <BookOpen className="size-4" />
            </SettingsButton>
            <SettingsButton
              size="icon"
              variant="ghost"
              aria-label={t('Plugin logs')}
              title={t('Plugin logs')}
              onClick={() => onPanel('logs')}
            >
              <FileText className="size-4" />
            </SettingsButton>
            {plugin.configurable && (
              <SettingsButton
                size="icon"
                variant="ghost"
                aria-label={t('Configure')}
                title={t('Configure')}
                onClick={() => onPanel('config')}
              >
                <Settings2 className="size-4" />
              </SettingsButton>
            )}
            <SettingsButton
              size="icon"
              variant="ghost"
              aria-label={t('Uninstall')}
              title={t('Uninstall')}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => void window.electronAPI.extensionPlugins.uninstall(plugin.id)}
            >
              <Trash2 className="size-4" />
            </SettingsButton>
            <div className="mx-1.5 h-5 w-px bg-border" />
            <SettingsSwitch
              checked={plugin.state === 'enabled'}
              onCheckedChange={(enabled) =>
                void window.electronAPI.extensionPlugins.setEnabled(plugin.id, enabled)
              }
            />
          </>
        }
      >
        {plugin.interceptBreakers?.map((breaker) => (
          <p
            key={breaker.event}
            className="px-4 py-2 pl-10 text-amber-600 text-xs dark:text-amber-400 max-sm:pr-3 max-sm:pl-7"
          >
            {breaker.event} 检查连续失败，临时放行到 {new Date(breaker.until).toLocaleTimeString()}
          </p>
        ))}
        <div className="px-4 py-3 pl-10 max-sm:pr-3 max-sm:pl-7">
          <PluginCapabilityBlock
            permissions={plugin.permissions}
            resident={plugin.resident}
            running={plugin.running}
            styles={plugin.themes.some((theme) => theme.css !== undefined)}
            trustedUi={plugin.hasRenderer}
            events={plugin.events}
            schedules={plugin.schedules}
          />
        </div>
        {plugin.crossSessionInject !== undefined && (
          <SettingsSubRow
            rowId={`plugins.crossSessionInject-${plugin.id}`}
            label="允许向任意运行中的会话发送消息"
            description="关闭时只能发到发起调用的会话；开启后定时任务、常驻进程也能向其他项目和窗口的会话发消息并触发执行"
          >
            <SettingsSwitch
              checked={plugin.crossSessionInject}
              onCheckedChange={(allowed) =>
                void window.electronAPI.extensionPlugins.setCrossSessionInject(plugin.id, allowed)
              }
            />
          </SettingsSubRow>
        )}
        {plugin.devWatch !== undefined && (
          <SettingsSubRow
            rowId={`plugins.devWatch-${plugin.id}`}
            label="开发模式：目录改动后自动重装"
            description="授权没扩大时直接替换；扩大时停下，需要从来源重新安装并同意。重启应用后关闭"
          >
            <SettingsSwitch
              checked={plugin.devWatch}
              onCheckedChange={(on) =>
                void window.electronAPI.extensionPlugins.setDevWatch(plugin.id, on).then((res) => {
                  if (!res.ok && res.error) addToast({ title: res.error });
                })
              }
            />
          </SettingsSubRow>
        )}
        {((plugin.pendingPermissions?.length ?? 0) > 0 || plugin.pendingRenderer) && (
          <div className="space-y-1 px-4 py-3 pl-10 max-sm:pr-3 max-sm:pl-7">
            <p className="text-muted-foreground text-xs">待同意</p>
            <PermissionLines
              permissions={plugin.pendingPermissions ?? []}
              styles={plugin.pendingRenderer}
            />
            {plugin.pendingRenderer && (
              <p className="text-amber-700 text-xs dark:text-amber-400">
                新增界面代码：运行在主界面里，不受权限清单约束
              </p>
            )}
          </div>
        )}
      </SettingsExpandableRow>
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
  requestedMarketQuery = null,
  onRequestedMarketQueryConsumed,
}: {
  requestedInstallUrl?: string | null;
  onRequestedInstallUrlConsumed?: () => void;
  focusPluginId?: string | null;
  onFocusPluginConsumed?: () => void;
  /** 深链带搜索词：直接打开市场并按它筛选 */
  requestedMarketQuery?: string | null;
  onRequestedMarketQueryConsumed?: () => void;
} = {}) {
  const { t } = useI18n();
  const pluginAutoUpdate = useSettingsStore((state) => state.pluginAutoUpdate !== false);
  const setPluginAutoUpdate = useSettingsStore((state) => state.setPluginAutoUpdate);
  const [plugins, setPlugins] = React.useState<ExtensionPluginSummary[]>([]);
  const themeErrors = usePluginThemesStore((state) => state.errors);
  const [preview, setPreview] = React.useState<ExtensionPluginInstallPreview | null>(null);
  /** 当前暂存来自市场弹窗：确认卡片就地显示在市场里，市场不关 */
  const [previewInMarket, setPreviewInMarket] = React.useState(false);
  /** 每关一次市场自增，用来识别关掉后才回来的市场暂存结果 */
  const marketSession = React.useRef(0);
  const [panel, setPanel] = React.useState<{
    kind: 'config' | 'logs' | 'artifacts';
    pluginId: string;
    pluginName: string;
  } | null>(null);
  /** 深链点名的插件：挂上后展开一次，之后交给行自己的开关 */
  const [forcedOpen, setForcedOpen] = React.useState<readonly string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState('');
  const [downloading, setDownloading] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [checkResult, setCheckResult] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<RegistryNotice | null>(null);
  const [marketOpen, setMarketOpen] = React.useState(false);
  const [marketQuery, setMarketQuery] = React.useState('');

  React.useEffect(() => {
    if (!requestedMarketQuery) return;
    setMarketQuery(requestedMarketQuery);
    setMarketOpen(true);
    onRequestedMarketQueryConsumed?.();
  }, [requestedMarketQuery, onRequestedMarketQueryConsumed]);
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
    setForcedOpen((prev) => (prev.includes(focusPluginId) ? prev : [...prev, focusPluginId]));
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
  const urlInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!requestedInstallUrl) return;
    const installUrl = requestedInstallUrl;
    let cancelled = false;
    // StrictMode 会立刻卸掉第一次 effect；推迟到下一拍，避免对已卸载的实例发起暂存
    const timer = window.setTimeout(() => {
      if (cancelled || stagingInstallUrls.has(installUrl)) return;
      stagingInstallUrls.add(installUrl);
      setUrl(installUrl);
      urlInputRef.current?.focus();
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

  const restage = async (id: string, fromMarket = false, inMarket = false) => {
    setError(null);
    if (preview) void window.electronAPI.extensionPlugins.discard(preview.token);
    setPreview(null);
    setPreviewInMarket(inMarket);
    setDownloading(true);
    const session = marketSession.current;
    const api = window.electronAPI.extensionPlugins;
    const result = await (fromMarket ? api.marketStage(id) : api.restage(id)).finally(() => {
      setDownloading(false);
    });
    if (inMarket && session !== marketSession.current) {
      if (result.ok) void api.discard(result.preview.token);
      return;
    }
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
      // 扩大授权的更新只是暂存待授权：Main 会发「需要授权」通知，这里不报已安装
      if (!preview.existingVersion || !preview.expands) {
        const enabled = preview.existingVersion
          ? { ok: true }
          : await window.electronAPI.extensionPlugins.setEnabled(preview.id, true);
        addToast({
          type: enabled.ok ? 'success' : 'warning',
          title: t('{{name}} installed', { name: preview.name }),
          description: enabled.ok ? undefined : enabled.error,
        });
      }
      void refresh();
    }
    setPreview(null);
    setPreviewInMarket(false);
  };

  const discard = () => {
    if (preview) void window.electronAPI.extensionPlugins.discard(preview.token);
    setPreview(null);
    setPreviewInMarket(false);
  };

  const closeMarket = () => {
    if (busy) return;
    marketSession.current += 1;
    if (previewInMarket) discard();
    setMarketOpen(false);
  };
  const marketPreview = previewInMarket ? preview : null;

  return (
    <SettingsPage
      rowId="plugins.enso"
      title={t('Enso plugins')}
      badge={<NewSessionBadge />}
      description={t(
        'Installing a plugin lets it run code on this machine. Review what it asks for before confirming.'
      )}
      actions={
        <>
          {plugins.length > 0 && (
            <SettingsButton disabled={checking} onClick={() => void checkUpdates()}>
              {checking ? <Spinner /> : <RefreshCw className="size-4" />}
              {t('Check for updates')}
            </SettingsButton>
          )}
          <SettingsButton
            variant="default"
            onClick={() => {
              setMarketQuery('');
              setMarketOpen(true);
            }}
          >
            <Store className="size-4" />
            {t('Marketplace')}
          </SettingsButton>
        </>
      }
    >
      <SettingsSection>
        <SettingsRow
          rowId="plugins.update-plugins-automatically"
          label={t('Update plugins automatically')}
          description={t(
            'Marketplace updates that do not ask for new permissions install on their own.'
          )}
        >
          <SettingsSwitch checked={pluginAutoUpdate} onCheckedChange={setPluginAutoUpdate} />
        </SettingsRow>
        <div
          data-settings-row="plugins.installUrl"
          className="flex flex-wrap items-center gap-2 px-4 py-3 max-sm:px-3"
        >
          <InputGroup className="min-w-40 flex-1">
            <InputGroupAddon>
              <Link2 className="size-4 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              ref={urlInputRef}
              size="sm"
              value={url}
              placeholder={t('https://github.com/owner/repo')}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void stageUrl();
              }}
            />
          </InputGroup>
          <SettingsButton
            disabled={busy || downloading || url.trim() === ''}
            onClick={() => void stageUrl()}
          >
            {downloading ? <Spinner /> : t('Install from URL')}
          </SettingsButton>
        </div>
        <div className="flex flex-wrap items-center gap-1 px-4 py-2.5 text-muted-foreground text-xs max-sm:px-3">
          <span className="mr-1">{t('Or install from')}</span>
          <SettingsButton
            size="xs"
            variant="ghost"
            disabled={busy || downloading}
            onClick={() => void stage('dir')}
          >
            <FolderOpen className="size-3.5" />
            {t('Install from folder')}
          </SettingsButton>
          <SettingsButton
            size="xs"
            variant="ghost"
            disabled={busy || downloading}
            onClick={() => void stage('zip')}
          >
            <Package className="size-3.5" />
            {t('Install from zip')}
          </SettingsButton>
        </div>
      </SettingsSection>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <Dialog
        open={marketOpen}
        onOpenChange={(open) => (open ? setMarketOpen(true) : closeMarket())}
      >
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>{t('Marketplace')}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {error && <p className="text-destructive text-sm">{error}</p>}
            {marketPreview && (
              <div className="flex h-[min(72vh,720px)] min-h-0 flex-col gap-3">
                <p className="font-medium text-base">
                  <InstallPreviewTitle preview={marketPreview} />
                </p>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                  <InstallPreviewDetails preview={marketPreview} />
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>
                    {t('Cancel')}
                  </Button>
                  <ConfirmInstallButton
                    token={marketPreview.token}
                    busy={busy}
                    onConfirm={() => void commit()}
                  />
                </div>
              </div>
            )}
            {/* 确认期间只隐藏不卸载，回到列表时保留搜索词、分类与详情位置 */}
            <div hidden={marketPreview !== null}>
              <PluginMarket
                key={marketQuery}
                initialQuery={marketQuery}
                disabled={busy || downloading}
                installedKey={plugins
                  .map(
                    (p) => `${p.id}@${p.version}${p.pendingVersion ? `>${p.pendingVersion}` : ''}`
                  )
                  .join(',')}
                onInstall={(id) => void restage(id, true, true)}
              />
            </div>
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
      <Dialog
        open={preview !== null && !previewInMarket}
        onOpenChange={(open) => !open && !busy && discard()}
      >
        <DialogContent>
          {preview && !previewInMarket && (
            <>
              <DialogHeader>
                <DialogTitle>
                  <InstallPreviewTitle preview={preview} />
                </DialogTitle>
              </DialogHeader>
              <DialogPanel className="space-y-3">
                <InstallPreviewDetails preview={preview} />
              </DialogPanel>
              <DialogFooter>
                <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>
                  {t('Cancel')}
                </Button>
                <ConfirmInstallButton
                  token={preview.token}
                  busy={busy}
                  onConfirm={() => void commit()}
                />
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {plugins.length === 0 && !preview && (
        <SettingsSection>
          <SettingsEmptyState
            icon={Puzzle}
            title={t('No Enso plugins installed')}
            description={t('Browse the marketplace or install from a GitHub URL, folder or zip.')}
          />
        </SettingsSection>
      )}
      {plugins.length > 0 && (
        <SettingsSection>
          {plugins.map((plugin) => (
            <ExtensionPluginRow
              key={plugin.id}
              plugin={plugin}
              themeErrors={themeErrors[plugin.id]}
              busy={busy}
              downloading={downloading}
              forceOpen={forcedOpen.includes(plugin.id)}
              onUpdate={() => void restage(plugin.id, plugin.source?.kind !== 'url')}
              onReinstall={() => void restage(plugin.id)}
              onPanel={(kind) => setPanel({ kind, pluginId: plugin.id, pluginName: plugin.name })}
              onGuide={() => setGuide({ id: plugin.id, name: plugin.name, from: 'installed' })}
            />
          ))}
        </SettingsSection>
      )}
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
            {panel?.kind === 'config' && <ExtensionPluginConfigForm pluginId={panel.pluginId} />}
            {panel?.kind === 'logs' && <ExtensionPluginLogs pluginId={panel.pluginId} />}
            {panel?.kind === 'artifacts' && <ExtensionPluginArtifacts pluginId={panel.pluginId} />}
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
    </SettingsPage>
  );
}
