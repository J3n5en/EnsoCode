import { AVATAR_MAX_BYTES, sniffAvatar } from '@shared/bots/cardPng';
import type { ExtensionPluginSummary } from '@shared/extensionPlugins/types';
import { secretaryAvatarUrl } from '@shared/localImage';
import { MAX_RUNNING_DISPATCHES, MIN_RUNNING_DISPATCHES } from '@shared/secretary/parse';
import type {
  SecretaryProfile,
  SecretaryProfileDraft,
  SecretaryScheduleView,
  SecretarySkillView,
  SecretaryTakeoverScope,
  SecretaryTakeoverView,
  SecretaryToolDraft,
  SecretaryUntrackedView,
} from '@shared/types/secretary';
import * as React from 'react';
import { AvatarCropDialog } from '@/components/bots/AvatarCropDialog';
import { dataUrlBytes, readDataUrl } from '@/components/bots/avatarRaster';
import { declaresGif, secretaryAvatarUploadError } from '@/components/secretary/avatarColor';
import {
  type AvatarUploadProblem,
  avatarUpload,
  IDLE_AVATAR_UPLOAD,
} from '@/components/secretary/avatarUpload';
import { defaultDraft, draftFromProfile } from '@/components/secretary/profileFormState';
import {
  NOTIFY_LABELS,
  REPLY_LANGUAGE_LABELS,
  STYLE_LABELS,
} from '@/components/secretary/profileLabels';
import { SecretaryAvatar } from '@/components/secretary/SecretaryAvatar';
import { SecretaryDeleteDialog } from '@/components/secretary/SecretaryDeleteDialog';
import { SecretaryProfileForm } from '@/components/secretary/SecretaryProfileForm';
import { SecretaryResetDialog } from '@/components/secretary/SecretaryResetDialog';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import {
  SettingsButton,
  SettingsPage,
  SettingsRow,
  SettingsSaved,
  SettingsSection,
  SettingsSwitch,
  useSettingsRowControl,
} from './kit';
import { ListFilterBar, matchesFilter } from './ListFilterBar';
import { SettingsSecretaryChips, useSettingsSecretaries } from './SettingsSecretaryPicker';

const DISPATCH_LIMIT_OPTIONS = Array.from(
  { length: MAX_RUNNING_DISPATCHES - MIN_RUNNING_DISPATCHES + 1 },
  (_, index) => {
    const value = String(MIN_RUNNING_DISPATCHES + index);
    return { value, label: value };
  }
);

/** 头像上传失败的原因 → 给用户看的一句话 */
const AVATAR_PROBLEM_TEXT: Record<AvatarUploadProblem, string> = {
  type: 'Avatar images must be PNG, JPEG, WebP or GIF, and at most 2 MB.',
  size: 'Avatar images must be PNG, JPEG, WebP or GIF, and at most 2 MB.',
  read: 'This image cannot be used as an avatar.',
  save: 'Could not save the secretary profile. Try again.',
};

/** 触屏把芯片本身撑到 44px，并用 ring 代替边框，避免再画出一张卡片 */
function chipClass(active: boolean): string {
  return cn(
    'relative rounded-md px-2.5 py-1 text-xs ring-1 transition-colors pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]',
    active
      ? 'bg-primary/10 text-foreground ring-primary/60'
      : 'text-muted-foreground ring-border hover:bg-muted'
  );
}

function useSavedFlash(): { status: React.ReactNode; mark: () => void } {
  const [on, setOn] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const mark = React.useCallback(() => {
    setOn(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), 1500);
  }, []);
  return { status: on ? <SettingsSaved /> : null, mark };
}

function Chips<T extends string>({
  value,
  options,
  onChange,
  enso,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  enso?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex max-w-full flex-wrap justify-end gap-1" data-enso={enso}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={chipClass(option.value === value)}
        >
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}

/** 点选后立即保存；成功时在芯片左侧闪「已保存」 */
function SaveChips<T extends string>({
  value,
  options,
  enso,
  onPick,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  enso?: string;
  onPick: (value: T) => Promise<boolean>;
}) {
  const { status, mark } = useSavedFlash();
  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
      {status}
      <Chips
        enso={enso}
        value={value}
        options={options}
        onChange={(next) => {
          if (next === value) return;
          void onPick(next).then((ok) => {
            if (ok) mark();
          });
        }}
      />
    </div>
  );
}

function BlurControl({
  value,
  onCommit,
  multiline = false,
  placeholder,
  type = 'text',
}: {
  value: string;
  onCommit: (value: string) => Promise<boolean>;
  multiline?: boolean;
  placeholder?: string;
  type?: 'text' | 'time';
}) {
  const a11y = useSettingsRowControl();
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft === value) return;
    void onCommit(draft);
  };
  if (multiline) {
    return (
      <Textarea
        {...a11y}
        size="sm"
        rows={4}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        className="w-full min-w-0 max-w-full"
      />
    );
  }
  return (
    <Input
      {...a11y}
      size="sm"
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      className="w-full min-w-0 max-w-full sm:w-[220px]"
    />
  );
}

/** 文本失焦且和已保存值不同才提交，成功后行内闪「已保存」 */
function BlurRow({
  label,
  value,
  onCommit,
  multiline,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => Promise<boolean>;
  multiline?: boolean;
  placeholder?: string;
  type?: 'text' | 'time';
}) {
  const { status, mark } = useSavedFlash();
  return (
    <SettingsRow label={label} status={status}>
      <BlurControl
        value={value}
        multiline={multiline}
        placeholder={placeholder}
        type={type}
        onCommit={async (next) => {
          const ok = await onCommit(next);
          if (ok) mark();
          return ok;
        }}
      />
    </SettingsRow>
  );
}

const DIVIDER = 'px-4 py-3 max-sm:px-3';

function formatWhen(at: number | undefined, locale: string): string {
  if (!at) return '';
  return new Date(at).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 勾选给秘书用的 Enso 插件：只列已安装且已启用的，停用后勾选自动失效 */
function PluginPicker({
  pluginIds,
  busy,
  onChange,
}: {
  pluginIds: string[];
  busy: boolean;
  onChange: (pluginIds: string[]) => void;
}) {
  const { t } = useI18n();
  const [plugins, setPlugins] = React.useState<ExtensionPluginSummary[]>([]);
  React.useEffect(() => {
    void window.electronAPI.extensionPlugins
      .list()
      .then((list) => setPlugins(list))
      .catch(() => undefined);
  }, []);
  const enabled = plugins.filter((plugin) => plugin.state === 'enabled');
  if (enabled.length === 0)
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
        {t('No plugins enabled')}
      </p>
    );
  return (
    <div>
      {enabled.map((plugin) => (
        <label
          key={plugin.id}
          className={cn('flex cursor-pointer flex-wrap items-center gap-2 text-sm', DIVIDER)}
          data-enso="secretary-plugin-row"
          data-plugin-id={plugin.id}
        >
          <Checkbox
            checked={pluginIds.includes(plugin.id)}
            disabled={busy}
            onCheckedChange={(checked) =>
              onChange(
                checked === true
                  ? [...pluginIds, plugin.id]
                  : pluginIds.filter((id) => id !== plugin.id)
              )
            }
          />
          <span className="min-w-0 flex-1 truncate">{plugin.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {t('{{n}} tools', { n: plugin.tools.length })}
          </span>
          {plugin.permissions.includes('agent.inject') ? (
            <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
              {t('Sends messages')}
            </span>
          ) : null}
        </label>
      ))}
    </div>
  );
}

/** 设置页当前编辑的秘书：只有一个秘书时为 undefined，Main 接受省略 */
const SecretaryIdContext = React.createContext<string | undefined>(undefined);

/** 秘书自有的 skill：与右侧面板同一份列表，正文可展开，删除后 Main 释放会话 */
function OwnSkills({ busy }: { busy: boolean }) {
  const { t } = useI18n();
  const secretaryId = React.useContext(SecretaryIdContext);
  const [skills, setSkills] = React.useState<SecretarySkillView[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const result = await window.electronAPI.secretary.listSkills(secretaryId);
    if (result.ok) setSkills(result.skills.filter((skill) => skill.source === 'own'));
    else setError(result.error);
  }, [secretaryId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const remove = async (name: string) => {
    setError(null);
    const result = await window.electronAPI.secretary.removeSkill(name, secretaryId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
  };

  if (error) return <p className="px-4 py-3 text-xs text-destructive max-sm:px-3">{error}</p>;
  if (skills.length === 0)
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">{t('No skills yet')}</p>
    );
  return (
    <div>
      {skills.map((skill) => (
        <div key={skill.name} className={DIVIDER} data-enso="secretary-skill-row">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{skill.name}</span>
            {!skill.enabled && (
              <span className="shrink-0 rounded bg-warning/10 px-1 text-[10px] text-warning">
                {t('Disabled')}
              </span>
            )}
            <SettingsButton variant="ghost" disabled={busy} onClick={() => void remove(skill.name)}>
              {t('Remove')}
            </SettingsButton>
          </div>
          <p className="text-xs text-muted-foreground">{skill.description}</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              {t('Show the content')}
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-[11px]">
              {skill.body ?? ''}
            </pre>
          </details>
        </div>
      ))}
    </div>
  );
}

/** 秘书自造的工具：代码可展开，删除后 Main 释放会话，下次 spawn 生效 */
function OwnTools({ busy }: { busy: boolean }) {
  const { t } = useI18n();
  const secretaryId = React.useContext(SecretaryIdContext);
  const [tools, setTools] = React.useState<SecretaryToolDraft[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const result = await window.electronAPI.secretary.listTools(secretaryId);
    if (result.ok) setTools(result.tools);
    else setError(result.error);
  }, [secretaryId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const remove = async (name: string) => {
    setError(null);
    const result = await window.electronAPI.secretary.removeTool(name, secretaryId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
  };

  if (error) return <p className="px-4 py-3 text-xs text-destructive max-sm:px-3">{error}</p>;
  if (tools.length === 0)
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">{t('No tools yet')}</p>
    );
  return (
    <div>
      {tools.map((tool) => (
        <div key={tool.name} className={DIVIDER} data-enso="secretary-tool-row">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{tool.name}</span>
            <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
              {tool.runtime === 'python' ? 'Python' : 'Node'}
            </span>
            <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
              {tool.readOnly ? t('Read-only') : t('Asks every call')}
            </span>
            <SettingsButton variant="ghost" disabled={busy} onClick={() => void remove(tool.name)}>
              {t('Remove')}
            </SettingsButton>
          </div>
          <p className="text-xs text-muted-foreground">{tool.description}</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              {t('Show the code')}
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre font-mono text-[11px]">
              {tool.code}
            </pre>
          </details>
        </div>
      ))}
    </div>
  );
}

/** 可接管的会话：范围只给操作权限，秘书真正用过某个会话之后才开始跟踪它 */
function TakeoverScopePicker({
  profile,
  busy,
  onChange,
}: {
  profile: SecretaryProfile;
  busy: boolean;
  onChange: (scope: SecretaryTakeoverScope) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const projects = useSettingsStore((state) => state.projects);
  const scope = profile.takeoverScope;
  const visible = profile.visibleProjectIds;
  // 临时会话与秘书自己不是可接管的项目；范围只在秘书看得见的项目里选
  const candidates = projects.filter(
    (project) =>
      project.kind !== 'secretary' &&
      project.kind !== 'scratch' &&
      (visible === 'all' || visible.includes(project.id))
  );
  const selected = scope.mode === 'projects' ? scope.projectIds : [];
  return (
    <div className="space-y-2 px-4 py-3 max-sm:px-3">
      <SaveChips
        enso="secretary-takeover-scope"
        value={scope.mode}
        options={[
          { value: 'explicit', label: 'One by one' },
          { value: 'projects', label: 'Selected projects' },
          { value: 'all', label: 'All visible projects' },
        ]}
        onPick={(mode) =>
          onChange(
            mode === 'all'
              ? { mode: 'all' }
              : mode === 'explicit'
                ? { mode: 'explicit' }
                : { mode: 'projects', projectIds: selected }
          )
        }
      />
      {scope.mode === 'projects' ? (
        candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('No project in the takeover scope')}</p>
        ) : (
          <div
            className="flex max-w-full flex-wrap justify-end gap-1"
            data-enso="secretary-takeover-projects"
          >
            {candidates.map((project) => {
              const active = selected.includes(project.id);
              return (
                <button
                  key={project.id}
                  type="button"
                  aria-pressed={active}
                  disabled={busy}
                  onClick={() =>
                    void onChange({
                      mode: 'projects',
                      projectIds: active
                        ? selected.filter((id) => id !== project.id)
                        : [...selected, project.id],
                    })
                  }
                  className={chipClass(active)}
                >
                  {project.alias || project.name}
                </button>
              );
            })}
          </div>
        )
      ) : null}
    </div>
  );
}

/** 交给秘书接管的会话：随秘书状态推送刷新，取消后秘书立即失去对它的发消息与停止权限 */
function Takeovers({ locale }: { locale: string }) {
  const { t } = useI18n();
  const secretaryId = React.useContext(SecretaryIdContext);
  const [takeovers, setTakeovers] = React.useState<SecretaryTakeoverView[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const result = await window.electronAPI.secretary.listTakeovers(secretaryId);
    if (result.ok) setTakeovers(result.takeovers);
    else setError(result.error);
  }, [secretaryId]);

  React.useEffect(() => {
    void load();
    return window.electronAPI.secretary.onStateChanged(() => void load());
  }, [load]);

  const revoke = async (conversationId: string) => {
    setError(null);
    const result = await window.electronAPI.secretary.revokeTakeover(conversationId);
    if (!result.ok) setError(result.error);
    await load();
  };

  return (
    <>
      {error ? <p className="px-4 py-2.5 text-xs text-destructive max-sm:px-3">{error}</p> : null}
      {takeovers.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
          {t('No sessions handed over')}
        </p>
      ) : (
        <div>
          {takeovers.map((entry) => (
            <div
              key={entry.conversationId}
              className={cn('flex flex-wrap items-center gap-2', DIVIDER)}
              data-enso="secretary-takeover-row"
              data-conversation-id={entry.conversationId}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{entry.title || t('Unnamed')}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[entry.projectName, formatWhen(entry.grantedAt, locale)]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <SettingsButton variant="ghost" onClick={() => void revoke(entry.conversationId)}>
                {t('Take back')}
              </SettingsButton>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * 用户点 × 收回过的会话：范围权限不再覆盖它们，秘书只能重新提确认卡。
 * 移除只是恢复范围权限，不会建立接管记录。
 */
function Untracked() {
  const { t } = useI18n();
  const secretaryId = React.useContext(SecretaryIdContext);
  const [entries, setEntries] = React.useState<SecretaryUntrackedView[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const result = await window.electronAPI.secretary.listUntracked(secretaryId);
    if (result.ok) setEntries(result.untracked);
    else setError(result.error);
  }, [secretaryId]);

  React.useEffect(() => {
    void load();
    return window.electronAPI.secretary.onStateChanged(() => void load());
  }, [load]);

  const remove = async (conversationId: string) => {
    setError(null);
    const result = await window.electronAPI.secretary.removeUntracked(conversationId, secretaryId);
    if (!result.ok) setError(result.error);
    await load();
  };

  if (entries.length === 0 && !error) return null;
  return (
    <div className="space-y-2 px-4 py-3 max-sm:px-3" data-enso="secretary-untracked">
      <p className="text-xs text-muted-foreground">
        {t(
          'Not tracked: the takeover scope no longer covers these sessions. Removing one lets the scope cover it again.'
        )}
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div>
        {entries.map((entry) => (
          <div
            key={entry.conversationId}
            className={cn('flex flex-wrap items-center gap-2', DIVIDER)}
            data-enso="secretary-untracked-row"
            data-conversation-id={entry.conversationId}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{entry.title || t('Unnamed')}</p>
              <p className="truncate text-xs text-muted-foreground">{entry.projectName}</p>
            </div>
            <SettingsButton variant="ghost" onClick={() => void remove(entry.conversationId)}>
              {t('Track again')}
            </SettingsButton>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 勾选全局 Enso skill：未勾选的不进秘书会话。和秘书自有技能一样平铺行，不套框 */
function GlobalSkillPicker({
  skillIds,
  onChange,
}: {
  skillIds: string[];
  onChange: (skillIds: string[]) => void;
}) {
  const { t } = useI18n();
  const skills = useSettingsStore((state) => state.skills);
  const [query, setQuery] = React.useState('');
  const visible = skills.filter((skill) => matchesFilter(query, [skill.name, skill.source]));
  return (
    <div>
      <p className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase max-sm:px-3">
        {t('Global skills')}
      </p>
      {skills.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">{t('No skills yet')}</p>
      ) : (
        <>
          <ListFilterBar
            query={query}
            onQueryChange={setQuery}
            placeholder={t('Filter skills...')}
          />
          {visible.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">{t('No results')}</p>
          )}
          {visible.map((skill) => {
            const checked = skillIds.includes(skill.id);
            return (
              <SettingsRow
                key={skill.id}
                label={skill.name}
                description={skill.description || skill.path}
                status={<Badge variant="secondary">{skill.source}</Badge>}
              >
                <SettingsSwitch
                  checked={checked}
                  onCheckedChange={() =>
                    onChange(
                      checked ? skillIds.filter((id) => id !== skill.id) : [...skillIds, skill.id]
                    )
                  }
                />
              </SettingsRow>
            );
          })}
        </>
      )}
    </div>
  );
}

/** 设置 → 秘书：多秘书时先选秘书，再编辑它的档案、风格、定时；也能新建与删除 */
export function SecretarySettings() {
  const { t } = useI18n();
  const { secretaries, setSecretaries, current, multiple, select, reload } =
    useSettingsSecretaries();
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  // 点删除时的那个秘书：途中列表推送或主窗口切换选中，都不改删除对象
  const [deleteTarget, setDeleteTarget] = React.useState<string>();

  const create = async () => {
    const result = await window.electronAPI.secretary.create();
    if (!result.ok) return;
    await reload();
    select(result.secretaryId);
  };

  return (
    <SecretaryIdContext.Provider value={multiple ? current : undefined}>
      <SettingsPage
        rowId="secretary.root"
        title={t('Secretary')}
        description={t(
          'The secretary is not part of any project. It watches your projects, dispatches sessions and reports results back. It never reads or writes code itself.'
        )}
      >
        {secretaries.length > 0 && (
          <div
            className="mt-4 flex max-w-full flex-wrap items-center gap-1.5"
            data-enso="secretary-settings-picker"
          >
            {multiple && (
              <SettingsSecretaryChips
                secretaries={secretaries}
                current={current}
                onSelect={select}
              />
            )}
            <SettingsButton data-enso="secretary-settings-create" onClick={() => void create()}>
              {t('New secretary')}
            </SettingsButton>
          </div>
        )}
        <SecretaryProfileSettings
          key={current ?? 'single'}
          onDelete={
            current
              ? () => {
                  setDeleteTarget(current);
                  setDeleteOpen(true);
                }
              : undefined
          }
        />
        {deleteTarget && (
          <SecretaryDeleteDialog
            open={deleteOpen}
            secretaryId={deleteTarget}
            onOpenChange={setDeleteOpen}
            onDeleted={() => {
              setSecretaries((list) => list.filter((entry) => entry.id !== deleteTarget));
              select(undefined);
              void reload();
            }}
          />
        )}
      </SettingsPage>
    </SecretaryIdContext.Provider>
  );
}

function SecretaryProfileSettings({ onDelete }: { onDelete?: () => void }) {
  const { t, locale } = useI18n();
  const secretaryId = React.useContext(SecretaryIdContext);
  const [profile, setProfile] = React.useState<SecretaryProfile | null>(null);
  const [persona, setPersona] = React.useState('');
  const [schedules, setSchedules] = React.useState<SecretaryScheduleView[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [avatar, dispatchAvatar] = React.useReducer(avatarUpload, IDLE_AVATAR_UPLOAD);
  const { status: profileSaved, mark: markProfileSaved } = useSavedFlash();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const defaultName = t('Secretary');

  const loadSchedules = React.useCallback(async () => {
    const result = await window.electronAPI.secretary.listSchedules(secretaryId);
    if (result.ok) setSchedules(result.schedules);
  }, [secretaryId]);

  const reload = React.useCallback(async () => {
    const result = await window.electronAPI.secretary.getProfile(secretaryId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setProfile(result.profile);
    setPersona(result.persona);
    await loadSchedules();
  }, [loadSchedules, secretaryId]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const save = async (draft: SecretaryProfileDraft): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.secretary.saveProfile(draft, secretaryId);
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setProfile(result.profile);
      await loadSchedules();
      return true;
    } catch {
      setError(t('Could not save the secretary profile. Try again.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setAvatar = async (image: Uint8Array | null) => {
    dispatchAvatar({ type: 'saving' });
    setError(null);
    try {
      const result = await window.electronAPI.secretary.setAvatar(image, secretaryId);
      if (!result.ok) {
        dispatchAvatar({ type: 'save-failed' });
        setError(result.error);
        return;
      }
      setProfile(result.profile);
      dispatchAvatar({ type: 'saved' });
    } catch {
      dispatchAvatar({ type: 'save-failed' });
      setError(t('Could not save the secretary profile. Try again.'));
    }
  };

  const removeSchedule = async (scheduleId: string) => {
    setError(null);
    const result = await window.electronAPI.secretary.removeSchedule(scheduleId, secretaryId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await loadSchedules();
  };

  return (
    <>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {avatar.problem ? (
        <p className="text-xs text-destructive" data-enso="secretary-avatar-problem">
          {t(AVATAR_PROBLEM_TEXT[avatar.problem])}
        </p>
      ) : null}

      <SettingsSection
        title={t('Secretary profile')}
        description={t('Name, avatar, visible projects and patrol.')}
        rowId="secretary.profile"
      >
        {profile ? (
          <div className={cn('flex flex-wrap items-center gap-2', DIVIDER)}>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              data-enso="secretary-avatar-file"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                const problem = secretaryAvatarUploadError(file, AVATAR_MAX_BYTES);
                // 每次选图都先回到干净状态：上一次的弹窗、错误、忙碌都不带过来
                dispatchAvatar({ type: 'pick', problem });
                if (problem) return;
                const crop = () =>
                  readDataUrl(file).then((source) => dispatchAvatar({ type: 'picked', source }));
                // canvas 裁切只留第一帧：真 GIF 原字节直接保存，显示时 object-cover 居中裁
                const picked = declaresGif(file)
                  ? file.arrayBuffer().then((buffer) => {
                      const bytes = new Uint8Array(buffer);
                      if (sniffAvatar(bytes, true) !== 'gif') return crop();
                      void setAvatar(bytes);
                    })
                  : crop();
                picked.catch(() => dispatchAvatar({ type: 'read-failed' }));
              }}
            />
            <SecretaryAvatar
              name={profile.name}
              color={profile.avatar.color}
              image={
                profile.avatar.imageVersion
                  ? secretaryAvatarUrl(
                      profile.avatar.imageVersion,
                      profile.avatar.imageHash,
                      secretaryId
                    )
                  : undefined
              }
              needsYou={0}
              running={0}
              enso="secretary-settings-avatar"
            />
            <SettingsButton
              disabled={avatar.busy}
              onClick={() => fileRef.current?.click()}
              data-enso="secretary-avatar-upload"
            >
              {t('Upload image')}
            </SettingsButton>
            {profile.avatar.imageVersion ? (
              <SettingsButton
                variant="ghost"
                disabled={avatar.busy}
                onClick={() => void setAvatar(null)}
                data-enso="secretary-avatar-remove"
              >
                {t('Remove image')}
              </SettingsButton>
            ) : null}
            <AvatarCropDialog
              source={avatar.cropSource}
              onCancel={() => dispatchAvatar({ type: 'crop-cancelled' })}
              onDone={(dataUrl) => {
                const bytes = dataUrlBytes(dataUrl);
                const tooLarge = bytes.byteLength > AVATAR_MAX_BYTES;
                dispatchAvatar({ type: 'cropped', tooLarge });
                if (tooLarge) return;
                void setAvatar(bytes);
              }}
            />
          </div>
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
        <div className="px-4 py-3 max-sm:px-3">
          <SecretaryProfileForm
            key={profile?.updatedAt ?? 'new'}
            initialDraft={
              profile ? draftFromProfile(profile, defaultName) : defaultDraft(defaultName)
            }
            submitLabel={t('Save')}
            busy={busy}
            hideMaxRunning
            onSubmit={({ maxRunningDispatches: _, ...draft }) => {
              void save(draft).then((ok) => {
                if (ok) markProfileSaved();
              });
            }}
          />
          {profileSaved}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('Concurrent dispatch limit')}
        description={t(
          'The most dispatched sessions the secretary may run at the same time. Dispatches beyond the limit wait in line and start on their own when a slot frees up.'
        )}
        rowId="secretary.dispatchLimit"
      >
        {profile ? (
          <div className="px-4 py-3 max-sm:px-3">
            <SaveChips
              enso="secretary-dispatch-limit"
              value={String(profile.maxRunningDispatches)}
              options={DISPATCH_LIMIT_OPTIONS}
              onPick={async (value) => {
                const maxRunningDispatches = Number(value);
                if (busy || maxRunningDispatches === profile.maxRunningDispatches) return false;
                return save({ maxRunningDispatches });
              }}
            />
          </div>
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('Plugins')}
        description={t(
          'Check a plugin to give the secretary its agent tools and skills. Tools that are not read-only ask for your approval on every call.'
        )}
        rowId="secretary.plugins"
      >
        {profile ? (
          <PluginPicker
            pluginIds={profile.pluginIds ?? []}
            busy={busy}
            onChange={(pluginIds) => void save({ pluginIds })}
          />
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('Skills')}
        description={t(
          'Skills the secretary may use. It proposes new ones in the chat; you confirm before anything is written.'
        )}
        rowId="secretary.skills"
      >
        {profile ? (
          <div className="space-y-3">
            <div>
              <p className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase max-sm:px-3">
                {t('Secretary skills')}
              </p>
              <OwnSkills busy={busy} />
            </div>
            <GlobalSkillPicker
              skillIds={profile.skillIds ?? []}
              onChange={(skillIds) => void save({ skillIds })}
            />
          </div>
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('Tools')}
        description={t(
          'Python or Node tools the secretary builds for itself. It proposes them in the chat; you confirm before anything is written. Read-only tools run directly, anything else asks for your approval on every call.'
        )}
        rowId="secretary.tools"
      >
        {profile ? (
          <OwnTools busy={busy} />
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
      </SettingsSection>

      {profile ? (
        <SettingsSection
          title={t('Style and interruptions')}
          description={t('What it calls you, reply language, style and system notifications.')}
          rowId="secretary.style"
        >
          <BlurRow
            label={t('What to call you')}
            value={profile.addressAs ?? ''}
            placeholder={t('Optional')}
            onCommit={(raw) => {
              const next = raw.trim() ? raw : null;
              if (next === (profile.addressAs ?? null)) return Promise.resolve(false);
              return save({ addressAs: next });
            }}
          />
          <SettingsRow rowId="secretary.reply-language" label={t('Reply language')}>
            <SaveChips
              value={profile.replyLanguage}
              options={(['ui', 'zh', 'en'] as const).map((value) => ({
                value,
                label: REPLY_LANGUAGE_LABELS[value],
              }))}
              onPick={(replyLanguage) => (busy ? Promise.resolve(false) : save({ replyLanguage }))}
            />
          </SettingsRow>
          <SettingsRow rowId="secretary.communication-style" label={t('Communication style')}>
            <SaveChips
              value={profile.style}
              options={(['concise', 'detailed'] as const).map((value) => ({
                value,
                label: STYLE_LABELS[value],
              }))}
              onPick={(style) => (busy ? Promise.resolve(false) : save({ style }))}
            />
          </SettingsRow>
          <SettingsRow rowId="secretary.system-notifications" label={t('System notifications')}>
            <SaveChips
              value={profile.notify}
              options={(['needs-user', 'with-done', 'off'] as const).map((value) => ({
                value,
                label: NOTIFY_LABELS[value],
              }))}
              onPick={(notify) => (busy ? Promise.resolve(false) : save({ notify }))}
            />
          </SettingsRow>
          <BlurRow
            label={t('Daily brief time')}
            type="time"
            value={profile.dailyBriefAt ?? ''}
            onCommit={(raw) => {
              const next = raw || null;
              if (next === (profile.dailyBriefAt ?? null)) return Promise.resolve(false);
              return save({ dailyBriefAt: next });
            }}
          />
          <BlurRow
            label={t('Persona')}
            multiline
            value={persona}
            onCommit={async (raw) => {
              if (raw === persona) return false;
              const ok = await save({ persona: raw });
              if (ok) setPersona(raw);
              return ok;
            }}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={t('Sessions it may take over')}
        description={t(
          'Which sessions the secretary may message and stop without asking you first. Everything else still needs a confirmation card from the secretary.'
        )}
        rowId="secretary.takeoverScope"
      >
        {profile ? (
          <TakeoverScopePicker
            profile={profile}
            busy={busy}
            onChange={(takeoverScope) => save({ takeoverScope })}
          />
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('Sessions handed over')}
        description={t(
          'Sessions you started and handed to the secretary. It may message and stop them like the ones it dispatched; take one back to remove that right.'
        )}
        rowId="secretary.takeovers"
      >
        <Takeovers locale={locale} />
        <Untracked />
      </SettingsSection>

      <SettingsSection title={t('Scheduled tasks')} rowId="secretary.schedules">
        {schedules.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted-foreground max-sm:px-3">
            {t('Nothing scheduled')}
          </p>
        ) : (
          <div>
            {schedules.map((schedule) => (
              <div key={schedule.id} className={cn('flex flex-wrap items-center gap-2', DIVIDER)}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{schedule.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {schedule.cron ?? schedule.at ?? ''}
                    {schedule.nextRunAt ? ` · ${formatWhen(schedule.nextRunAt, locale)}` : ''}
                  </p>
                </div>
                {schedule.system ? (
                  <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                    {t('Built-in')}
                  </span>
                ) : (
                  <SettingsButton variant="ghost" onClick={() => void removeSchedule(schedule.id)}>
                    {t('Remove')}
                  </SettingsButton>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('Reset the secretary and start over')}
        description={t('Sessions and dispatch history are kept either way.')}
        rowId="secretary.reset"
      >
        <div className={cn('flex flex-wrap justify-end', DIVIDER)}>
          <SettingsButton onClick={() => setResetOpen(true)}>{t('Re-run setup')}</SettingsButton>
        </div>
        <SecretaryResetDialog
          open={resetOpen}
          secretaryId={secretaryId}
          onOpenChange={setResetOpen}
          onReset={() => {
            setProfile(null);
            setPersona('');
            void loadSchedules();
          }}
        />
      </SettingsSection>

      {onDelete ? (
        <SettingsSection rowId="secretary.danger-zone" tone="danger" title={t('Danger zone')}>
          <SettingsRow
            rowId="secretary.delete-secretary"
            label={t('Delete secretary')}
            description={t(
              'This cannot be undone. The sessions it manages stay, but nobody manages them afterwards; its contact bindings are released and its private memory is deleted.'
            )}
          >
            <SettingsButton
              variant="destructive"
              data-enso="secretary-settings-delete"
              onClick={onDelete}
            >
              {t('Delete secretary')}
            </SettingsButton>
          </SettingsRow>
        </SettingsSection>
      ) : null}
    </>
  );
}
