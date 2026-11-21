import { projectDisplayName } from '@shared/projectName';
import type { SecretaryProfileDraft } from '@shared/types/secretary';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { AvatarColorField } from './AvatarColorField';
import { defaultDraft, formReducer } from './profileFormState';

const MAX_RUNNING_OPTIONS = [1, 2, 3, 4, 5] as const;

function Chips<T extends string>({
  value,
  options,
  onChange,
  enso,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  enso: string;
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-1.5">
      <p className="text-sm">{t(label)}</p>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{t(hint)}</p> : null}
    </div>
  );
}

function SwitchField({
  label,
  hint,
  checked,
  onChange,
  enso,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  enso: string;
}) {
  const { t } = useI18n();
  return (
    <label className="flex items-start justify-between gap-3" data-enso={enso}>
      <span className="space-y-1">
        <span className="block text-sm">{t(label)}</span>
        <span className="block text-xs text-muted-foreground">{t(hint)}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors',
          checked ? 'border-primary bg-primary' : 'border-border bg-muted'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-3.5 rounded-full bg-background transition-all',
            checked ? 'left-[18px]' : 'left-0.5'
          )}
        />
      </button>
    </label>
  );
}

function ProjectChips({
  selected,
  onChange,
  enso,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  enso: string;
}) {
  const projects = useSettingsStore((state) => state.projects);
  // 临时会话与秘书自己不是可派活的项目
  const dispatchable = projects.filter(
    (project) => project.kind !== 'scratch' && project.kind !== 'secretary'
  );
  if (dispatchable.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-enso={enso}>
      {dispatchable.map((project) => {
        const active = selected.includes(project.id);
        return (
          <button
            key={project.id}
            type="button"
            aria-pressed={active}
            onClick={() =>
              onChange(
                active ? selected.filter((id) => id !== project.id) : [...selected, project.id]
              )
            }
            className={cn(
              'rounded-md border px-2.5 py-1 text-xs transition-colors',
              active
                ? 'border-primary/60 bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-muted'
            )}
          >
            {projectDisplayName(project)}
          </button>
        );
      })}
    </div>
  );
}

export interface SecretaryProfileFormProps {
  initialDraft: SecretaryProfileDraft;
  submitLabel: string;
  onSubmit: (draft: SecretaryProfileDraft) => void;
  busy?: boolean;
  error?: string | null;
  /** 欢迎页：可以「全部用默认，直接开始」 */
  allowDefaults?: boolean;
  /** 就地修改时收起表单 */
  onCancel?: () => void;
  /** 设置页另有独立的派发上限控件 */
  hideMaxRunning?: boolean;
}

/** 一页平铺的档案表单：欢迎页、设置页与配置卡片的就地修改共用同一份 */
export function SecretaryProfileForm({
  initialDraft,
  submitLabel,
  onSubmit,
  busy = false,
  error = null,
  allowDefaults = false,
  onCancel,
  hideMaxRunning = false,
}: SecretaryProfileFormProps) {
  const { t } = useI18n();
  const [draft, dispatch] = React.useReducer(formReducer, initialDraft);
  const patch = (value: SecretaryProfileDraft) => dispatch({ type: 'patch', patch: value });

  return (
    <div className="space-y-4" data-enso="secretary-profile-form">
      <Field label="Name">
        <Input
          data-enso="secretary-form-name"
          value={draft.name ?? ''}
          onChange={(event) => patch({ name: event.target.value })}
          className="max-w-xs"
        />
      </Field>
      <Field label="Avatar color">
        <AvatarColorField
          color={draft.avatar?.color ?? '#7c5cff'}
          onChange={(color) => patch({ avatar: { color } })}
        />
      </Field>
      <Field label="Visible projects">
        <Chips
          enso="secretary-form-visible-mode"
          value={draft.visibleProjectIds === 'all' ? 'all' : 'selected'}
          options={[
            { value: 'all', label: 'All projects' },
            { value: 'selected', label: 'Selected projects' },
          ]}
          onChange={(mode) =>
            patch({
              visibleProjectIds:
                mode === 'all'
                  ? 'all'
                  : draft.visibleProjectIds === 'all'
                    ? []
                    : draft.visibleProjectIds,
            })
          }
        />
        {draft.visibleProjectIds !== 'all' ? (
          <ProjectChips
            enso="secretary-form-visible-projects"
            selected={draft.visibleProjectIds ?? []}
            onChange={(visibleProjectIds) => patch({ visibleProjectIds })}
          />
        ) : null}
      </Field>
      {!hideMaxRunning && (
        <Field label="Running dispatches at most">
          <Chips
            enso="secretary-form-max-running"
            value={String(draft.maxRunningDispatches ?? 3)}
            options={MAX_RUNNING_OPTIONS.map((value) => ({
              value: String(value),
              label: String(value),
            }))}
            onChange={(value) => patch({ maxRunningDispatches: Number(value) })}
          />
        </Field>
      )}
      <SwitchField
        enso="secretary-form-patrol"
        label="Watch running sessions automatically"
        hint="While anything is running the secretary checks it and only reports an anomaly: a goal session idle for 3 minutes with an unfinished goal and no live background task, idle for 20 minutes with a background task that never woke it, or running for 30 minutes without any event. Every hour it also reports background tasks left running in finished sessions; nothing is killed. Nothing is sent when all is well."
        checked={draft.patrolEnabled ?? true}
        onChange={(patrolEnabled) => patch({ patrolEnabled })}
      />
      <SwitchField
        enso="secretary-form-cleanup-skip-confirm"
        label="Clean up without asking"
        hint="Off by default. When on, this secretary's cleanup deletes immediately, with no confirmation card: merged local branches and their worktrees. Sessions are only archived, never deleted. Unmerged branches, branches in use, feat/secretary-agent, main, the current branch and worktrees with uncommitted changes are still refused or skipped."
        checked={draft.cleanupSkipConfirm ?? false}
        onChange={(cleanupSkipConfirm) => patch({ cleanupSkipConfirm })}
      />

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy}
          data-enso="secretary-form-submit"
          onClick={() => onSubmit(draft)}
        >
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            {t('Cancel')}
          </Button>
        )}
        {allowDefaults && (
          <button
            type="button"
            data-enso="secretary-form-defaults"
            disabled={busy}
            onClick={() => onSubmit(defaultDraft(t('Secretary')))}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {t('Use all defaults and start')}
          </button>
        )}
      </div>
    </div>
  );
}
