import { AVATAR_MAX_BYTES, sniffAvatar } from '@shared/bots/cardPng';
import type { ExtensionPluginSummary } from '@shared/extensionPlugins/types';
import { secretaryAvatarUrl } from '@shared/localImage';
import { MAX_RUNNING_DISPATCHES, MIN_RUNNING_DISPATCHES } from '@shared/secretary/parse';
import type {
  SecretaryProfile,
  SecretaryProfileDraft,
  SecretaryScheduleView,
  SecretarySkillView,
  SecretarySummary,
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
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { SETTINGS_SECRETARY_KEY } from '@/lib/secretarySettingsLink';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { PickList } from './PresetsSettings';

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
    <div className="flex flex-wrap gap-1" data-enso={enso}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md border px-2.5 py-1 text-xs transition-colors',
            option.value === value
              ? 'border-primary/60 bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:bg-muted'
          )}
        >
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}

function Section({
  title,
  description,
  rowId,
  children,
}: {
  title: string;
  description?: string;
  rowId: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="space-y-3" data-settings-row={rowId}>
      <div>
        <h4 className="text-sm font-medium">{t(title)}</h4>
        {description ? <p className="text-xs text-muted-foreground">{t(description)}</p> : null}
      </div>
      {children}
    </section>
  );
}

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
    return <p className="text-xs text-muted-foreground">{t('No plugins enabled')}</p>;
  return (
    <div className="divide-y rounded-md border">
      {enabled.map((plugin) => (
        <label
          key={plugin.id}
          className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm"
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

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (skills.length === 0)
    return <p className="text-xs text-muted-foreground">{t('No skills yet')}</p>;
  return (
    <div className="divide-y rounded-md border">
      {skills.map((skill) => (
        <div key={skill.name} className="px-3 py-2" data-enso="secretary-skill-row">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{skill.name}</span>
            {!skill.enabled && (
              <span className="shrink-0 rounded bg-warning/10 px-1 text-[10px] text-warning">
                {t('Disabled')}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void remove(skill.name)}
            >
              {t('Remove')}
            </Button>
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

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (tools.length === 0)
    return <p className="text-xs text-muted-foreground">{t('No tools yet')}</p>;
  return (
    <div className="divide-y rounded-md border">
      {tools.map((tool) => (
        <div key={tool.name} className="px-3 py-2" data-enso="secretary-tool-row">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{tool.name}</span>
            <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
              {tool.runtime === 'python' ? 'Python' : 'Node'}
            </span>
            <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
              {tool.readOnly ? t('Read-only') : t('Asks every call')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void remove(tool.name)}
            >
              {t('Remove')}
            </Button>
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
  onChange: (scope: SecretaryTakeoverScope) => void;
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
    <div className="space-y-2">
      <Chips
        enso="secretary-takeover-scope"
        value={scope.mode}
        options={[
          { value: 'explicit', label: 'One by one' },
          { value: 'projects', label: 'Selected projects' },
          { value: 'all', label: 'All visible projects' },
        ]}
        onChange={(mode) =>
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
          <div className="flex flex-wrap gap-1" data-enso="secretary-takeover-projects">
            {candidates.map((project) => {
              const active = selected.includes(project.id);
              return (
                <button
                  key={project.id}
                  type="button"
                  aria-pressed={active}
                  disabled={busy}
                  onClick={() =>
                    onChange({
                      mode: 'projects',
                      projectIds: active
                        ? selected.filter((id) => id !== project.id)
                        : [...selected, project.id],
                    })
                  }
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs transition-colors',
                    active
                      ? 'border-primary/60 bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  )}
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
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {takeovers.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('No sessions handed over')}</p>
      ) : (
        <div className="divide-y rounded-md border">
          {takeovers.map((entry) => (
            <div
              key={entry.conversationId}
              className="flex items-center gap-2 px-3 py-2"
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
              <Button variant="ghost" size="sm" onClick={() => void revoke(entry.conversationId)}>
                {t('Take back')}
              </Button>
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
    <div className="mt-3 space-y-2" data-enso="secretary-untracked">
      <p className="text-xs text-muted-foreground">
        {t(
          'Not tracked: the takeover scope no longer covers these sessions. Removing one lets the scope cover it again.'
        )}
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="divide-y rounded-md border">
        {entries.map((entry) => (
          <div
            key={entry.conversationId}
            className="flex items-center gap-2 px-3 py-2"
            data-enso="secretary-untracked-row"
            data-conversation-id={entry.conversationId}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{entry.title || t('Unnamed')}</p>
              <p className="truncate text-xs text-muted-foreground">{entry.projectName}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void remove(entry.conversationId)}>
              {t('Track again')}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 勾选全局 Enso skill：未勾选的不进秘书会话 */
function GlobalSkillPicker({
  skillIds,
  onChange,
}: {
  skillIds: string[];
  onChange: (skillIds: string[]) => void;
}) {
  const { t } = useI18n();
  const skills = useSettingsStore((state) => state.skills);
  return (
    <PickList
      title={t('Global skills')}
      emptyText={t('No skills yet')}
      items={skills}
      getName={(skill) => skill.name}
      getSource={(skill) => skill.source}
      isChecked={(skill) => skillIds.includes(skill.id)}
      onToggle={(skill) =>
        onChange(
          skillIds.includes(skill.id)
            ? skillIds.filter((id) => id !== skill.id)
            : [...skillIds, skill.id]
        )
      }
      placeholder={t('Filter skills...')}
      renderDetail={(skill) => <p className="text-xs">{skill.description || skill.path}</p>}
    />
  );
}

/** 设置 → 秘书：多秘书时先选秘书，再编辑它的档案、风格、定时；也能新建与删除 */
export function SecretarySettings() {
  const { t } = useI18n();
  const [secretaries, setSecretaries] = React.useState<SecretarySummary[]>([]);
  const [selected, setSelected] = React.useState<string | undefined>(() => {
    try {
      return localStorage.getItem(SETTINGS_SECRETARY_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const loadList = React.useCallback(async () => {
    const list = await window.electronAPI.secretary.list();
    setSecretaries(list);
  }, []);

  React.useEffect(() => {
    void loadList();
    return window.electronAPI.secretary.onListChanged(setSecretaries);
  }, [loadList]);

  // 设置窗口已开着时，主窗口点另一个秘书的「设置」：跟着切过去
  React.useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key === SETTINGS_SECRETARY_KEY && event.newValue) setSelected(event.newValue);
    };
    window.addEventListener('storage', follow);
    return () => window.removeEventListener('storage', follow);
  }, []);

  const current =
    secretaries.find((entry) => entry.id === selected)?.id ?? secretaries[0]?.id ?? undefined;
  const multiple = secretaries.length > 1;

  const create = async () => {
    const result = await window.electronAPI.secretary.create();
    if (!result.ok) return;
    await loadList();
    setSelected(result.secretaryId);
  };

  return (
    <SecretaryIdContext.Provider value={multiple ? current : undefined}>
      <div className="space-y-4">
        {secretaries.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1.5"
            data-enso="secretary-settings-picker"
          >
            {multiple &&
              secretaries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  data-enso="secretary-settings-pick"
                  data-secretary-id={entry.id}
                  data-selected={entry.id === current || undefined}
                  onClick={() => setSelected(entry.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    entry.id === current
                      ? 'border-foreground/40 bg-foreground/5 text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {entry.name ?? t('Secretary')}
                </button>
              ))}
            <Button
              variant="outline"
              size="sm"
              data-enso="secretary-settings-create"
              onClick={() => void create()}
            >
              {t('New secretary')}
            </Button>
            {current && (
              <Button
                variant="ghost"
                size="sm"
                data-enso="secretary-settings-delete"
                onClick={() => setDeleteOpen(true)}
              >
                {t('Delete secretary')}
              </Button>
            )}
          </div>
        )}
        <SecretaryProfileSettings key={current ?? 'single'} />
        {current && (
          <SecretaryDeleteDialog
            open={deleteOpen}
            secretaryId={current}
            onOpenChange={setDeleteOpen}
            onDeleted={() => {
              setSelected(undefined);
              void loadList();
            }}
          />
        )}
      </div>
    </SecretaryIdContext.Provider>
  );
}

function SecretaryProfileSettings() {
  const { t, locale } = useI18n();
  const secretaryId = React.useContext(SecretaryIdContext);
  const [profile, setProfile] = React.useState<SecretaryProfile | null>(null);
  const [persona, setPersona] = React.useState('');
  const [styleDraft, setStyleDraft] = React.useState<SecretaryProfileDraft | null>(null);
  const [schedules, setSchedules] = React.useState<SecretaryScheduleView[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [avatar, dispatchAvatar] = React.useReducer(avatarUpload, IDLE_AVATAR_UPLOAD);
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
    setStyleDraft(result.profile ? draftFromProfile(result.profile, defaultName) : null);
    await loadSchedules();
  }, [defaultName, loadSchedules, secretaryId]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const save = async (draft: SecretaryProfileDraft) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.electronAPI.secretary.saveProfile(draft, secretaryId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setProfile(result.profile);
      setStyleDraft(draftFromProfile(result.profile, defaultName));
      setNotice(t('Saved'));
      await loadSchedules();
    } catch {
      setError(t('Could not save the secretary profile. Try again.'));
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
      setStyleDraft(draftFromProfile(result.profile, defaultName));
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
    <div className="space-y-8">
      <div>
        <h3 className="text-lg font-medium">{t('Secretary')}</h3>
        <p className="text-sm text-muted-foreground">
          {t(
            'The secretary is not part of any project. It watches your projects, dispatches sessions and reports results back. It never reads or writes code itself.'
          )}
        </p>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {avatar.problem ? (
        <p className="text-xs text-destructive" data-enso="secretary-avatar-problem">
          {t(AVATAR_PROBLEM_TEXT[avatar.problem])}
        </p>
      ) : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}

      <Section
        title="Secretary profile"
        description="Name, avatar, visible projects and patrol."
        rowId="secretary.profile"
      >
        {profile ? (
          <div className="flex items-center gap-2">
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
            <Button
              variant="outline"
              size="sm"
              disabled={avatar.busy}
              onClick={() => fileRef.current?.click()}
              data-enso="secretary-avatar-upload"
            >
              {t('Upload image')}
            </Button>
            {profile.avatar.imageVersion ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={avatar.busy}
                onClick={() => void setAvatar(null)}
                data-enso="secretary-avatar-remove"
              >
                {t('Remove image')}
              </Button>
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
          <p className="text-xs text-muted-foreground">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
        <SecretaryProfileForm
          key={profile?.updatedAt ?? 'new'}
          initialDraft={
            profile ? draftFromProfile(profile, defaultName) : defaultDraft(defaultName)
          }
          submitLabel={t('Save')}
          busy={busy}
          hideMaxRunning
          onSubmit={({ maxRunningDispatches: _, ...draft }) => void save(draft)}
        />
      </Section>

      <Section
        title="Concurrent dispatch limit"
        description="The most dispatched sessions the secretary may run at the same time. Once the limit is reached, new dispatches are refused."
        rowId="secretary.dispatchLimit"
      >
        {profile ? (
          <Chips
            enso="secretary-dispatch-limit"
            value={String(profile.maxRunningDispatches)}
            options={DISPATCH_LIMIT_OPTIONS}
            onChange={(value) => {
              const maxRunningDispatches = Number(value);
              if (busy || maxRunningDispatches === profile.maxRunningDispatches) return;
              void save({ maxRunningDispatches });
            }}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
      </Section>

      <Section
        title="Plugins"
        description="Check a plugin to give the secretary its agent tools and skills. Tools that are not read-only ask for your approval on every call."
        rowId="secretary.plugins"
      >
        {profile ? (
          <PluginPicker
            pluginIds={profile.pluginIds ?? []}
            busy={busy}
            onChange={(pluginIds) => void save({ pluginIds })}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
      </Section>

      <Section
        title="Skills"
        description="Skills the secretary may use. It proposes new ones in the chat; you confirm before anything is written."
        rowId="secretary.skills"
      >
        {profile ? (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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
          <p className="text-xs text-muted-foreground">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
      </Section>

      <Section
        title="Tools"
        description="Python or Node tools the secretary builds for itself. It proposes them in the chat; you confirm before anything is written. Read-only tools run directly, anything else asks for your approval on every call."
        rowId="secretary.tools"
      >
        {profile ? (
          <OwnTools busy={busy} />
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
      </Section>

      {styleDraft ? (
        <Section
          title="Style and interruptions"
          description="What it calls you, reply language, style and system notifications."
          rowId="secretary.style"
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="text-sm">{t('What to call you')}</p>
              <Input
                value={styleDraft.addressAs ?? ''}
                placeholder={t('Optional')}
                onChange={(event) =>
                  setStyleDraft({
                    ...styleDraft,
                    addressAs: event.target.value.trim() ? event.target.value : null,
                  })
                }
                className="max-w-xs"
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm">{t('Reply language')}</p>
              <Chips
                value={styleDraft.replyLanguage ?? 'ui'}
                options={(['ui', 'zh', 'en'] as const).map((value) => ({
                  value,
                  label: REPLY_LANGUAGE_LABELS[value],
                }))}
                onChange={(replyLanguage) => setStyleDraft({ ...styleDraft, replyLanguage })}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm">{t('Communication style')}</p>
              <Chips
                value={styleDraft.style ?? 'concise'}
                options={(['concise', 'detailed'] as const).map((value) => ({
                  value,
                  label: STYLE_LABELS[value],
                }))}
                onChange={(style) => setStyleDraft({ ...styleDraft, style })}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm">{t('System notifications')}</p>
              <Chips
                value={styleDraft.notify ?? 'needs-user'}
                options={(['needs-user', 'with-done', 'off'] as const).map((value) => ({
                  value,
                  label: NOTIFY_LABELS[value],
                }))}
                onChange={(notify) => setStyleDraft({ ...styleDraft, notify })}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm">{t('Daily brief time')}</p>
              <Input
                type="time"
                value={styleDraft.dailyBriefAt ?? ''}
                onChange={(event) =>
                  setStyleDraft({ ...styleDraft, dailyBriefAt: event.target.value || null })
                }
                className="max-w-32"
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm">{t('Persona')}</p>
              <Textarea
                value={persona}
                onChange={(event) => setPersona(event.target.value)}
                rows={4}
              />
            </div>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void save({
                  addressAs: styleDraft.addressAs ?? null,
                  replyLanguage: styleDraft.replyLanguage,
                  style: styleDraft.style,
                  notify: styleDraft.notify,
                  dailyBriefAt: styleDraft.dailyBriefAt ?? null,
                  persona,
                })
              }
            >
              {t('Save')}
            </Button>
          </div>
        </Section>
      ) : null}

      <Section
        title="Sessions it may take over"
        description="Which sessions the secretary may message and stop without asking you first. Everything else still needs a confirmation card from the secretary."
        rowId="secretary.takeoverScope"
      >
        {profile ? (
          <TakeoverScopePicker
            profile={profile}
            busy={busy}
            onChange={(takeoverScope) => void save({ takeoverScope })}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
      </Section>

      <Section
        title="Sessions handed over"
        description="Sessions you started and handed to the secretary. It may message and stop them like the ones it dispatched; take one back to remove that right."
        rowId="secretary.takeovers"
      >
        <Takeovers locale={locale} />
        <Untracked />
      </Section>

      <Section title="Scheduled tasks" rowId="secretary.schedules">
        {schedules.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('Nothing scheduled')}</p>
        ) : (
          <div className="divide-y rounded-md border">
            {schedules.map((schedule) => (
              <div key={schedule.id} className="flex items-center gap-2 px-3 py-2">
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void removeSchedule(schedule.id)}
                  >
                    {t('Remove')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Reset the secretary and start over"
        description="Sessions and dispatch history are kept either way."
        rowId="secretary.reset"
      >
        <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
          {t('Re-run setup')}
        </Button>
        <SecretaryResetDialog
          open={resetOpen}
          secretaryId={secretaryId}
          onOpenChange={setResetOpen}
          onReset={() => {
            setProfile(null);
            setStyleDraft(null);
            setPersona('');
            setNotice(null);
            void loadSchedules();
          }}
        />
      </Section>
    </div>
  );
}
