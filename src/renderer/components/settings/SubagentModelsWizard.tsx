import { pickModelCapabilityOverrides } from '@shared/modelCatalog';
import type { ModelProvider, ModelThinkingLevelOverride, SubagentModelEntry } from '@shared/types';
import { MODEL_THINKING_LEVEL_OVERRIDES } from '@shared/types/llm';
import type { VirtualModelEntry } from '@shared/virtualModels';
import { X } from 'lucide-react';
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
  const [tuning, setTuning] = useState<ReadonlySet<SubagentRoleId>>(() => new Set());
  const preview = buildWizardEntries(drafts, existing, mode, () => '');

  const patchDraft = (index: number, update: (draft: SubagentRoleDraft) => SubagentRoleDraft) =>
    setDrafts((current) => current.map((draft, i) => (i === index ? update(draft) : draft)));
  const toggleTuning = (roleId: SubagentRoleId) =>
    setTuning((current) => {
      const next = new Set(current);
      if (!next.delete(roleId)) next.add(roleId);
      return next;
    });

  const confirm = () => {
    setEntries(buildWizardEntries(drafts, existing, mode, () => crypto.randomUUID()).entries);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Quick setup wizard')}</DialogTitle>
          <DialogDescription>
            {t(
              'Pick models only for the roles you need; empty roles are skipped. Roles may share a model.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {existing.length > 0 && (
            <SettingsSegmented<SubagentWizardMode>
              aria-label={t('Existing models')}
              value={mode}
              onValueChange={setMode}
              options={[
                { value: 'append', label: t('Append to existing list') },
                { value: 'replace', label: t('Replace existing list') },
              ]}
            />
          )}
          <div className="divide-y divide-border/60">
            {SUBAGENT_ROLE_PRESETS.map((role, index) => {
              const draft = drafts[index];
              const open = tuning.has(role.id);
              return (
                <div
                  key={role.id}
                  data-slot="subagent-wizard-role"
                  data-selected={draft.selection ? 'true' : undefined}
                  className="px-3.5 py-3"
                >
                  <div className="flex items-center gap-3 max-sm:flex-col max-sm:items-stretch">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-[13px]">{t(role.title)}</div>
                      <div className="text-muted-foreground text-xs">{t(role.summary)}</div>
                    </div>
                    <div className="flex w-[300px] shrink-0 items-center gap-1 max-sm:w-full">
                      <div className="min-w-0 flex-1">
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
                      {draft.selection && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('Skip this role')}
                          className="shrink-0 text-muted-foreground"
                          onClick={() => patchDraft(index, (d) => ({ ...d, selection: null }))}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {draft.selection && (
                    // 收起时一行小字预览；微调时文本框占同一位置，「完成」贴在右下角，不多占一行
                    <div
                      className={cn(
                        'mt-1.5 flex gap-2 text-xs',
                        open ? 'items-end' : 'items-baseline'
                      )}
                    >
                      {open ? (
                        <Textarea
                          size="sm"
                          className={cn('min-w-0 flex-1', COMPACT_TEXTAREA_CLASS)}
                          aria-label={t('Description')}
                          value={draft.description}
                          onChange={(event) =>
                            patchDraft(index, (d) => ({ ...d, description: event.target.value }))
                          }
                        />
                      ) : (
                        <span
                          data-slot="subagent-wizard-description-preview"
                          className="min-w-0 flex-1 truncate text-muted-foreground"
                          title={draft.description}
                        >
                          {draft.description}
                        </span>
                      )}
                      <button
                        type="button"
                        data-slot="subagent-wizard-tune"
                        aria-expanded={open}
                        className="shrink-0 cursor-pointer text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        onClick={() => toggleTuning(role.id)}
                      >
                        {open ? t('Done') : t('Fine-tune')}
                      </button>
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
