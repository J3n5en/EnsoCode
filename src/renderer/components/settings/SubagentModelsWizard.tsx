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
import { Z_INDEX } from '@/lib/z-index';
import { useUsableProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { SettingsSegmented } from './kit';
import {
  buildWizardEntries,
  SUBAGENT_ROLE_PRESETS,
  type SubagentRoleDraft,
  type SubagentWizardMode,
} from './subagentModelPresets';

// 继承项只做能力适配显示，不落成独立覆盖；只有用户操作才写入。
const ignoreInheritedNormalization = () => undefined;

function isReasoningOverride(value: unknown): value is 'on' | 'off' {
  return value === 'on' || value === 'off';
}

function isThinkingLevelOverride(value: unknown): value is ModelThinkingLevelOverride {
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

/** 一页式角色向导：每个角色选一个模型（可重复）并改写描述，确认时一次写入列表。 */
export function SubagentModelsWizard({
  seed,
  onClose,
}: {
  seed: { providerId: string; modelId: string } | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const existing = useSettingsStore((state) => state.subagentModels);
  const setEntries = useSettingsStore((state) => state.setSubagentModels);
  const virtualModels = useSettingsStore((state) => state.virtualModels);
  const candidates = useUsableProviders();
  const [mode, setMode] = useState<SubagentWizardMode>('append');
  const [drafts, setDrafts] = useState<SubagentRoleDraft[]>(() =>
    SUBAGENT_ROLE_PRESETS.map((role) => ({
      roleId: role.id,
      selection: role.skipByDefault ? null : seed,
      description: t(role.template),
    }))
  );
  const preview = buildWizardEntries(drafts, existing, mode, () => '');

  const patchDraft = (index: number, update: (draft: SubagentRoleDraft) => SubagentRoleDraft) =>
    setDrafts((current) => current.map((draft, i) => (i === index ? update(draft) : draft)));

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
              'Pick a model for each role. Roles may share a model; each keeps its own description and reasoning.'
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
          {SUBAGENT_ROLE_PRESETS.map((role, index) => {
            const draft = drafts[index];
            return (
              <div
                key={role.id}
                data-slot="subagent-wizard-role"
                className="space-y-2 rounded-lg border border-border/80 p-3"
              >
                <div>
                  <div className="font-medium text-sm">{t(role.title)}</div>
                  <div className="text-muted-foreground text-xs">{t(role.summary)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 max-w-[400px] flex-1">
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
                      size="icon"
                      aria-label={t('Skip this role')}
                      className="shrink-0 text-muted-foreground"
                      onClick={() => patchDraft(index, (d) => ({ ...d, selection: null }))}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                {draft.selection && (
                  <Textarea
                    size="sm"
                    aria-label={t('Description')}
                    value={draft.description}
                    onChange={(event) =>
                      patchDraft(index, (d) => ({ ...d, description: event.target.value }))
                    }
                  />
                )}
              </div>
            );
          })}
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
