import { pickModelCapabilityOverrides } from '@shared/modelCatalog';
import type { ModelProvider, ModelThinkingLevelOverride, SubagentModelEntry } from '@shared/types';
import { MODEL_THINKING_LEVEL_OVERRIDES } from '@shared/types/llm';
import type { VirtualModelEntry } from '@shared/virtualModels';
import {
  Code2,
  FlaskConical,
  type LucideIcon,
  Pencil,
  Search,
  ShieldCheck,
  X,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { useUsableProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { SettingsSegmented } from './kit';
import {
  buildWizardEntries,
  SUBAGENT_ROLE_PRESETS,
  type SubagentRoleDraft,
  type SubagentRoleId,
  type SubagentWizardMode,
} from './subagentModelPresets';

// 继承项只做能力适配显示，不落成独立覆盖；只有用户操作才写入。
const ignoreInheritedNormalization = () => undefined;

/** 两行起步、随文本增高、不带右下角缩放角的描述框 */
export const COMPACT_TEXTAREA_CLASS = '[&_textarea]:min-h-12 [&_textarea]:resize-none';

export function isReasoningOverride(value: unknown): value is 'on' | 'off' {
  return value === 'on' || value === 'off';
}

export function isThinkingLevelOverride(value: unknown): value is ModelThinkingLevelOverride {
  return (
    typeof value === 'string' &&
    (MODEL_THINKING_LEVEL_OVERRIDES as readonly string[]).includes(value)
  );
}

export type SubagentPickerValue = Pick<
  SubagentModelEntry,
  'providerId' | 'modelId' | 'reasoning' | 'thinkingLevel'
>;

/** 列表行与向导共用：条目级模型 + 推理三态/档位，变更只回传补丁。 */
export function SubagentEntryModelPicker({
  providers,
  virtualModels,
  value,
  onChange,
  emptyLabel,
  zIndex,
}: {
  providers: ModelProvider[];
  virtualModels: readonly VirtualModelEntry[];
  value: SubagentPickerValue;
  onChange: (patch: Partial<SubagentPickerValue>) => void;
  emptyLabel?: string;
  zIndex?: number;
}) {
  return (
    <ModelPicker
      providers={providers}
      virtualModels={virtualModels}
      providerId={value.providerId}
      modelId={value.modelId}
      modelCapabilityOverrides={pickModelCapabilityOverrides(value)}
      side="bottom"
      zIndex={zIndex}
      emptyLabel={emptyLabel}
      showReasoningControls={Boolean(value.providerId && value.modelId)}
      triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
      reasoningMode={isReasoningOverride(value.reasoning) ? value.reasoning : 'follow'}
      reasoningEnabled={value.reasoning === 'on'}
      thinkingLevel={isThinkingLevelOverride(value.thinkingLevel) ? value.thinkingLevel : 'medium'}
      onReasoningModeChange={(mode, level) => {
        if (mode === 'follow') {
          onChange({ reasoning: undefined, thinkingLevel: undefined });
        } else if (mode === 'on' && !isThinkingLevelOverride(value.thinkingLevel)) {
          onChange({ reasoning: 'on', thinkingLevel: level });
        } else {
          onChange({ reasoning: mode });
        }
      }}
      onSelect={(providerId, modelId) => onChange({ providerId, modelId })}
      onReasoningChange={(reasoningEnabled) =>
        onChange({ reasoning: reasoningEnabled ? 'on' : 'off' })
      }
      onThinkingChange={(thinkingLevel) => onChange({ thinkingLevel })}
      onReasoningNormalize={
        isReasoningOverride(value.reasoning)
          ? (reasoningEnabled) => onChange({ reasoning: reasoningEnabled ? 'on' : 'off' })
          : ignoreInheritedNormalization
      }
      onThinkingNormalize={
        isThinkingLevelOverride(value.thinkingLevel)
          ? (thinkingLevel) => onChange({ thinkingLevel })
          : ignoreInheritedNormalization
      }
    />
  );
}

function applyPickerPatch(
  draft: SubagentRoleDraft,
  { providerId, modelId, ...overrides }: Partial<SubagentPickerValue>
): SubagentRoleDraft {
  return {
    ...draft,
    ...overrides,
    ...(providerId !== undefined && modelId !== undefined
      ? { selection: { providerId, modelId } }
      : {}),
  };
}

const ROLE_ICONS: Record<SubagentRoleId, LucideIcon> = {
  scout: Search,
  worker: Code2,
  reviewer: ShieldCheck,
  tester: FlaskConical,
  light: Zap,
};

/** 下拉框与尾部动作槽固定宽度：未选中的行保留空槽，五行下拉框右缘对齐 */
const PICKER_SLOT_CLASS = 'w-[252px] shrink-0 max-sm:min-w-0 max-sm:flex-1';
const ACTION_SLOT_CLASS = 'flex w-[60px] shrink-0 items-center justify-end gap-0.5 max-sm:w-auto';

/** 一页式角色向导：只给需要的角色选模型（可重复），确认时一次写入列表。默认全部跳过。 */
export function SubagentModelsWizard({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const existing = useSettingsStore((state) => state.subagentModels);
  const setEntries = useSettingsStore((state) => state.setSubagentModels);
  const virtualModels = useSettingsStore((state) => state.virtualModels);
  const candidates = useUsableProviders();
  const [mode, setMode] = useState<SubagentWizardMode>('append');
  const [drafts, setDrafts] = useState<SubagentRoleDraft[]>(() =>
    SUBAGENT_ROLE_PRESETS.map((role) => ({
      roleId: role.id,
      selection: null,
      description: t(role.template),
    }))
  );
  const [editing, setEditing] = useState<ReadonlySet<SubagentRoleId>>(() => new Set());
  const preview = buildWizardEntries(drafts, existing, mode, () => '');

  const patchDraft = (index: number, update: (draft: SubagentRoleDraft) => SubagentRoleDraft) =>
    setDrafts((current) => current.map((draft, i) => (i === index ? update(draft) : draft)));
  const setEditingRole = (roleId: SubagentRoleId, open: boolean) =>
    setEditing((current) => {
      const next = new Set(current);
      if (open) next.add(roleId);
      else next.delete(roleId);
      return next;
    });

  const confirm = () => {
    setEntries(buildWizardEntries(drafts, existing, mode, () => crypto.randomUUID()).entries);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{t('Quick setup wizard')}</DialogTitle>
          <DialogDescription>
            {t(
              'Pick models only for the roles you need; empty roles are skipped. Roles may share a model.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="!px-0 !pt-0 !pb-0">
          {existing.length > 0 && (
            <div
              data-slot="subagent-wizard-mode"
              className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/25 px-6 py-2.5"
            >
              <span className="text-muted-foreground text-xs">{t('Write mode')}</span>
              <SettingsSegmented<SubagentWizardMode>
                aria-label={t('Write mode')}
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: 'append', label: t('Append to existing list') },
                  { value: 'replace', label: t('Replace existing list') },
                ]}
              />
            </div>
          )}
          <div className="divide-y divide-border/60 border-t border-border/60">
            {SUBAGENT_ROLE_PRESETS.map((role, index) => {
              const draft = drafts[index];
              const selected = draft.selection !== null;
              const open = selected && editing.has(role.id);
              const template = t(role.template);
              const customized = draft.description !== template;
              const Icon = ROLE_ICONS[role.id];
              return (
                <div
                  key={role.id}
                  data-slot="subagent-wizard-role"
                  data-selected={selected ? 'true' : undefined}
                >
                  <div className="flex items-center gap-3 px-6 py-3 max-sm:flex-wrap">
                    <div
                      aria-hidden
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
                        selected
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted/70 text-muted-foreground'
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-44px)]">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium text-[13px]">{t(role.title)}</span>
                        {selected && customized && (
                          <span
                            data-slot="subagent-wizard-customized"
                            className="shrink-0 rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground"
                          >
                            {t('Customized')}
                          </span>
                        )}
                      </div>
                      <div
                        className="truncate text-muted-foreground text-xs"
                        title={t(role.summary)}
                      >
                        {t(role.summary)}
                      </div>
                    </div>
                    <div className={PICKER_SLOT_CLASS}>
                      <SubagentEntryModelPicker
                        providers={candidates}
                        virtualModels={virtualModels}
                        zIndex={Z_INDEX.DROPDOWN_IN_MODAL}
                        emptyLabel={t('Skip this role')}
                        value={{
                          providerId: draft.selection?.providerId ?? '',
                          modelId: draft.selection?.modelId ?? '',
                          reasoning: draft.reasoning,
                          thinkingLevel: draft.thinkingLevel,
                        }}
                        onChange={(patch) => patchDraft(index, (d) => applyPickerPatch(d, patch))}
                      />
                    </div>
                    <div className={ACTION_SLOT_CLASS}>
                      {selected && (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            data-slot="subagent-wizard-tune"
                            aria-label={t('Edit')}
                            aria-expanded={open}
                            className={cn(
                              'text-muted-foreground',
                              open && 'bg-accent text-foreground'
                            )}
                            onClick={() => setEditingRole(role.id, !open)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            data-slot="subagent-wizard-skip"
                            aria-label={t('Skip this role')}
                            className="text-muted-foreground"
                            onClick={() => {
                              patchDraft(index, (d) => ({ ...d, selection: null }));
                              setEditingRole(role.id, false);
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {open && (
                    <div
                      data-slot="subagent-wizard-editor"
                      className="border-t border-border/50 bg-muted/40 px-6 py-3 pl-17 max-sm:pl-6 dark:bg-background/35"
                    >
                      {/* pl-17 = px-6 + 图标 w-8 + gap-3，按 rem 计算，与标题左缘对齐（根字号不是 16px 时 68px 会偏） */}
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">
                            {t('Selection description')}
                          </span>
                          {customized && (
                            <button
                              type="button"
                              data-slot="subagent-wizard-reset"
                              className="cursor-pointer text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                              onClick={() =>
                                patchDraft(index, (d) => ({ ...d, description: template }))
                              }
                            >
                              {t('Reset to default')}
                            </button>
                          )}
                        </div>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          data-slot="subagent-wizard-done"
                          onClick={() => setEditingRole(role.id, false)}
                        >
                          {t('Done')}
                        </Button>
                      </div>
                      <Textarea
                        size="sm"
                        className={COMPACT_TEXTAREA_CLASS}
                        aria-label={t('Selection description')}
                        value={draft.description}
                        onChange={(event) =>
                          patchDraft(index, (d) => ({ ...d, description: event.target.value }))
                        }
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </DialogPanel>
        <DialogFooter className="sm:items-center">
          <span className="mr-auto text-muted-foreground text-sm">
            {t('Will add {{count}} models (skipping {{skipped}} roles)', {
              count: preview.added,
              skipped: preview.skipped,
            })}
          </span>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button disabled={preview.added === 0} onClick={confirm}>
            {t('Confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
