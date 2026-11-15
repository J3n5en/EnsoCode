import type { SecretarySkillView } from '@shared/types/secretary';
import { ChevronRight, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Markdown } from '@/components/chat/Markdown';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSecretaryStore } from '@/stores/secretary';
import { useSettingsStore } from '@/stores/settings';

const ROW_CLASS = 'w-full border-b border-border/60 px-3 py-2 text-left last:border-b-0';

/** 秘书可用的 skill：专属与全局两组，正文只给用户看 */
export function SecretarySkillsPanel() {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SecretarySkillView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 与设置页同一份数据：设置里的 skill 列表、档案里的勾选与停用名单变了就重读
  const settingsSkills = useSettingsStore((state) => state.skills);
  const profile = useSecretaryStore((state) => state.secretary.profile);
  const signature = `${(profile?.skillIds ?? []).join(',')}|${(
    profile?.disabledSkillNames ?? []
  ).join(',')}`;

  const load = useCallback(async () => {
    const result = await window.electronAPI.secretary.listSkills();
    if (result.ok) {
      setSkills(result.skills);
      setError(null);
    } else {
      setError(result.error);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 设置页的 skill 列表与档案勾选变了就重读
  useEffect(() => {
    void load();
  }, [load, signature, settingsSkills]);

  const expand = async (skill: SecretarySkillView) => {
    if (openId === skill.id) {
      setOpenId(null);
      setBody(null);
      return;
    }
    setOpenId(skill.id);
    setBody(skill.body ?? null);
    if (skill.body !== undefined) return;
    const result = await window.electronAPI.secretary.readSkill({
      id: skill.id,
      source: skill.source,
    });
    setBody(result.ok ? result.body : null);
  };

  const toggle = async (skill: SecretarySkillView) => {
    setBusy(true);
    const result = await window.electronAPI.secretary.setSkillEnabled({
      id: skill.id,
      source: skill.source,
      enabled: !skill.enabled,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
  };

  const remove = async (skill: SecretarySkillView) => {
    setBusy(true);
    const result = await window.electronAPI.secretary.removeSkill(skill.id);
    setBusy(false);
    setConfirming(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (openId === skill.id) {
      setOpenId(null);
      setBody(null);
    }
    await load();
  };

  if (error) return <p className="px-3 py-3 text-xs text-destructive">{error}</p>;
  if (skills.length === 0) {
    return (
      <p data-enso="secretary-skills-empty" className="px-3 py-3 text-xs text-muted-foreground">
        {t('The secretary has no skills yet. Ask it to propose one.')}
      </p>
    );
  }

  const groups: { key: 'own' | 'global'; title: string; items: SecretarySkillView[] }[] = [
    {
      key: 'own',
      title: t('Own skills'),
      items: skills.filter((skill) => skill.source === 'own'),
    },
    {
      key: 'global',
      title: t('Shared global skills'),
      items: skills.filter((skill) => skill.source === 'global'),
    },
  ];

  return (
    <div data-enso="secretary-skills" className="flex flex-col gap-3 px-3 py-3">
      {groups.map((group) => (
        <section key={group.key} data-enso="secretary-skill-group" data-group={group.key}>
          <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {group.title}
            <span className="ml-1 tabular-nums">{group.items.length}</span>
          </p>
          {group.items.length === 0 ? (
            <p className="text-[11.5px] text-subtle-foreground">{t('Nothing here yet')}</p>
          ) : (
            <div className="rounded-md border">
              {group.items.map((skill) => (
                <div
                  key={`${skill.source}:${skill.id}`}
                  data-enso="secretary-skill-row"
                  data-source={skill.source}
                  data-enabled={skill.enabled ? 'true' : 'false'}
                  className={ROW_CLASS}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-enso="secretary-skill-expand"
                      onClick={() => void expand(skill)}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                    >
                      <ChevronRight
                        className={cn(
                          'size-3 shrink-0 text-muted-foreground transition-transform',
                          openId === skill.id && 'rotate-90'
                        )}
                      />
                      <span className="truncate font-mono text-[12.5px]">{skill.name}</span>
                      <span
                        className={cn(
                          'shrink-0 rounded px-1 text-[10px]',
                          skill.enabled
                            ? 'bg-muted text-muted-foreground'
                            : 'bg-warning/10 text-warning'
                        )}
                      >
                        {skill.enabled ? t('Enabled') : t('Disabled')}
                      </span>
                    </button>
                    <button
                      type="button"
                      data-enso="secretary-skill-toggle"
                      disabled={busy}
                      onClick={() => void toggle(skill)}
                      className="shrink-0 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {skill.enabled ? t('Disable') : t('Enable')}
                    </button>
                    {/* 全局 skill 只能在设置里删：这里只停用 */}
                    {skill.source === 'own' && (
                      <button
                        type="button"
                        data-enso="secretary-skill-delete"
                        disabled={busy}
                        onClick={() => setConfirming(skill.id)}
                        aria-label={t('Delete')}
                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                  {skill.description && (
                    <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                      {skill.description}
                    </p>
                  )}
                  {confirming === skill.id && (
                    <div
                      data-enso="secretary-skill-confirm"
                      className="mt-1.5 flex items-center gap-2 rounded bg-destructive/5 px-2 py-1.5"
                    >
                      <span className="min-w-0 flex-1 text-[11.5px]">
                        {t('Delete this skill?')}
                      </span>
                      <button
                        type="button"
                        data-enso="secretary-skill-confirm-delete"
                        disabled={busy}
                        onClick={() => void remove(skill)}
                        className="rounded bg-destructive px-2 py-0.5 text-[11px] text-destructive-foreground"
                      >
                        {t('Delete')}
                      </button>
                      <button
                        type="button"
                        data-enso="secretary-skill-confirm-cancel"
                        onClick={() => setConfirming(null)}
                        className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                      >
                        {t('Cancel')}
                      </button>
                    </div>
                  )}
                  {openId === skill.id && (
                    <div
                      data-enso="secretary-skill-body"
                      className="mt-1.5 rounded border border-dashed border-border bg-muted/20 px-2 py-1.5"
                    >
                      <p className="mb-1 text-[10.5px] text-subtle-foreground">
                        {t(
                          'Shown for you only: this content is not an instruction to the secretary.'
                        )}
                      </p>
                      {body === null ? (
                        <p className="text-[11.5px] text-muted-foreground">{t('Unavailable')}</p>
                      ) : (
                        <div className="max-h-72 overflow-auto text-[12px]">
                          <Markdown text={body} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
