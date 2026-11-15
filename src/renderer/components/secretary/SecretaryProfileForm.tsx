import { projectDisplayName } from '@shared/projectName';
import { THINKING_LEVELS, type ThinkingLevel } from '@shared/types/agent';
import type { SecretaryProfileDraft } from '@shared/types/secretary';
import * as React from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useUsableProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { AvatarColorField } from './AvatarColorField';
import {
  defaultDraft,
  FORM_STEPS,
  type FormStep,
  formReducer,
  initialFormState,
  isLastStep,
  stepIndex,
} from './profileFormState';
import { AUTONOMY_LABELS, DISPATCH_MODEL_LABELS, WORKTREE_LABELS } from './profileLabels';

const THINKING_SHORT: Record<ThinkingLevel, string> = {
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'Extra',
  max: 'Max',
};

const STEP_LABELS: Record<FormStep, string> = {
  identity: 'Name and avatar',
  model: 'Model',
  workflow: 'How it works',
};

const MAX_RUNNING_OPTIONS = [1, 2, 3, 4, 5] as const;
const PATROL_INTERVAL_OPTIONS = [5, 10, 15, 30, 60] as const;
const PATROL_IDLE_GOAL_OPTIONS = [1, 3, 5, 10, 15] as const;

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
  /** 欢迎页：任何一步都能「全部用默认，直接开始」 */
  allowDefaults?: boolean;
  /** 就地修改时收起表单 */
  onCancel?: () => void;
  /** 设置页另有独立的派发上限控件 */
  hideMaxRunning?: boolean;
}

/** 三步档案表单：欢迎页、设置页与配置卡片的就地修改共用同一份 */
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
  const [state, dispatch] = React.useReducer(formReducer, initialDraft, initialFormState);
  const providers = useUsableProviders();
  const { draft } = state;
  const patch = (value: SecretaryProfileDraft) => dispatch({ type: 'patch', patch: value });
  const last = isLastStep(state.step);
  const dispatchModel = draft.dispatchModel ?? { mode: 'project' as const };

  const setDispatchModel = (mode: 'project' | 'fixed' | 'choose') => {
    if (mode === 'project') return patch({ dispatchModel: { mode: 'project' } });
    if (mode === 'choose') {
      const candidates = dispatchModel.mode === 'choose' ? dispatchModel.candidates : [];
      return patch({ dispatchModel: { mode: 'choose', candidates } });
    }
    const model =
      draft.model ??
      (providers[0]?.models[0]
        ? { providerId: providers[0].id, modelId: providers[0].models[0].id }
        : null);
    if (model) patch({ dispatchModel: { mode: 'fixed', model } });
  };

  const dispatchModelModes = React.useMemo(() => {
    const modes: ('project' | 'fixed' | 'choose')[] = ['project', 'fixed'];
    // 秘书自选的候选模型只在卡片上改，表单不提供编辑；已经选了就别把它降级掉
    if (dispatchModel.mode === 'choose') modes.push('choose');
    return modes;
  }, [dispatchModel.mode]);

  return (
    <div className="space-y-4" data-enso="secretary-profile-form">
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {FORM_STEPS.map((step, index) => (
          <React.Fragment key={step}>
            {index > 0 && <span aria-hidden>›</span>}
            <button
              type="button"
              data-enso="secretary-form-step"
              data-step={step}
              aria-current={step === state.step ? 'step' : undefined}
              onClick={() => dispatch({ type: 'goto', step })}
              className={cn(
                'rounded px-1 py-0.5 transition-colors hover:text-foreground',
                step === state.step && 'font-medium text-foreground'
              )}
            >
              {`${index + 1} ${t(STEP_LABELS[step])}`}
            </button>
          </React.Fragment>
        ))}
      </div>

      {state.step === 'identity' && (
        <div className="space-y-4">
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
        </div>
      )}

      {state.step === 'model' && (
        <div className="space-y-4">
          <Field
            label="Secretary model"
            hint="Used for the secretary itself. Dispatched sessions use their own project defaults."
          >
            <ModelPicker
              providers={providers}
              providerId={draft.model?.providerId ?? ''}
              modelId={draft.model?.modelId ?? ''}
              reasoningEnabled={false}
              thinkingLevel={draft.model?.thinkingLevel ?? 'medium'}
              showReasoningControls={false}
              emptyLabel={t('Follows the default model')}
              side="bottom"
              triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
              onSelect={(providerId, modelId) =>
                patch({
                  model: {
                    providerId,
                    modelId,
                    ...(draft.model?.thinkingLevel
                      ? { thinkingLevel: draft.model.thinkingLevel }
                      : {}),
                  },
                })
              }
              onReasoningChange={() => {}}
              onThinkingChange={() => {}}
            />
          </Field>
          <Field label="Thinking level">
            <Chips
              enso="secretary-form-thinking"
              value={draft.model?.thinkingLevel ?? 'medium'}
              options={THINKING_LEVELS.map((level) => ({
                value: level,
                label: THINKING_SHORT[level],
              }))}
              onChange={(level) => {
                if (!draft.model) return;
                patch({ model: { ...draft.model, thinkingLevel: level } });
              }}
            />
          </Field>
          {draft.model ? (
            <Button variant="ghost" size="sm" onClick={() => patch({ model: null })}>
              {t('Use default model')}
            </Button>
          ) : null}
        </div>
      )}

      {state.step === 'workflow' && (
        <div className="space-y-4">
          <Field label="Autonomy">
            <Chips
              enso="secretary-form-autonomy"
              value={draft.autonomy ?? 'ask-first'}
              options={(['ask-first', 'tell-after', 'full'] as const).map((value) => ({
                value,
                label: AUTONOMY_LABELS[value],
              }))}
              onChange={(autonomy) => patch({ autonomy })}
            />
          </Field>
          <Field
            label="Projects without confirmation"
            hint='Only applies when autonomy is not "ask first". Other projects always show a confirmation card.'
          >
            <ProjectChips
              enso="secretary-form-auto-approve"
              selected={draft.autoApproveProjectIds ?? []}
              onChange={(autoApproveProjectIds) => patch({ autoApproveProjectIds })}
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
          <Field label="Dispatch model">
            <Chips
              enso="secretary-form-dispatch-model"
              value={dispatchModel.mode}
              options={dispatchModelModes.map((mode) => ({
                value: mode,
                label: DISPATCH_MODEL_LABELS[mode],
              }))}
              onChange={setDispatchModel}
            />
            {dispatchModel.mode === 'fixed' ? (
              <ModelPicker
                providers={providers}
                providerId={dispatchModel.model.providerId}
                modelId={dispatchModel.model.modelId}
                reasoningEnabled={false}
                thinkingLevel="medium"
                showReasoningControls={false}
                emptyLabel={t('Follows the default model')}
                side="bottom"
                triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
                onSelect={(providerId, modelId) =>
                  patch({ dispatchModel: { mode: 'fixed', model: { providerId, modelId } } })
                }
                onReasoningChange={() => {}}
                onThinkingChange={() => {}}
              />
            ) : null}
          </Field>
          <Field label="Dispatch worktree">
            <Chips
              enso="secretary-form-worktree"
              value={draft.dispatchWorktree ?? 'auto'}
              options={(['never', 'auto', 'always'] as const).map((value) => ({
                value,
                label: WORKTREE_LABELS[value],
              }))}
              onChange={(dispatchWorktree) => patch({ dispatchWorktree })}
            />
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
            enso="secretary-form-dispatch-muted"
            label="Dispatched sessions start muted"
            hint="Muted sessions send no system notification, no push and no badge. Their results still reach the secretary."
            checked={draft.dispatchMuted ?? true}
            onChange={(dispatchMuted) => patch({ dispatchMuted })}
          />
          <SwitchField
            enso="secretary-form-dispatch-unattended"
            label="Dispatched sessions start unattended"
            hint="Unattended sessions never wait for a person: actions that need your approval are refused instead, so the model decides and keeps working."
            checked={draft.dispatchUnattended ?? true}
            onChange={(dispatchUnattended) => patch({ dispatchUnattended })}
          />
          <SwitchField
            enso="secretary-form-patrol"
            label="Watch running sessions automatically"
            hint="While anything is running the secretary checks it on a schedule and only reports an anomaly: a goal session idle for the stall threshold with an unfinished goal and no live background task, idle for 20 minutes with a background task that never woke it, or running for 30 minutes without any event. Nothing is sent when all is well."
            checked={draft.patrolEnabled ?? true}
            onChange={(patrolEnabled) => patch({ patrolEnabled })}
          />
          {(draft.patrolEnabled ?? true) && (
            <>
              <Field label="Check every">
                <Chips
                  enso="secretary-form-patrol-interval"
                  value={String(draft.patrolIntervalMinutes ?? 15)}
                  options={PATROL_INTERVAL_OPTIONS.map((value) => ({
                    value: String(value),
                    label: t('{{n}} min', { n: value }),
                  }))}
                  onChange={(value) => patch({ patrolIntervalMinutes: Number(value) })}
                />
              </Field>
              <Field label="Report stalled after">
                <Chips
                  enso="secretary-form-patrol-idle-goal"
                  value={String(draft.patrolIdleGoalMinutes ?? 3)}
                  options={PATROL_IDLE_GOAL_OPTIONS.map((value) => ({
                    value: String(value),
                    label: t('{{n}} min', { n: value }),
                  }))}
                  onChange={(value) => patch({ patrolIdleGoalMinutes: Number(value) })}
                />
              </Field>
            </>
          )}
          <SwitchField
            enso="secretary-form-orphan-task-patrol"
            label="Scan finished sessions for leftover background tasks"
            hint="Every hour the secretary looks at finished sessions: a task whose process is gone, one that has run for over 2 hours, or a service (dev server, http.server) still running 10 minutes after the session ended. It only reports them; nothing is killed."
            checked={draft.orphanTaskPatrol ?? true}
            onChange={(orphanTaskPatrol) => patch({ orphanTaskPatrol })}
          />
        </div>
      )}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        {stepIndex(state.step) > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => dispatch({ type: 'back' })}
          >
            {t('Back')}
          </Button>
        )}
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            if (!last) return dispatch({ type: 'next' });
            onSubmit(draft);
          }}
        >
          {last ? submitLabel : t('Next')}
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
