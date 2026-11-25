import { formatPluginModelChoice, parsePluginModelChoice } from '@shared/extensionPlugins/manifest';
import { MODEL_PICKER_DIALOG_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUsableProviders } from '@/stores/modelDirectory/useProviders';

const MODES = { session: '跟随当前会话', title: '跟随标题模型', fixed: '指定模型' } as const;

/** 插件 model 配置项：跟随会话、跟随标题模型，或从用户已配置的模型里指定一个 */
export function PluginModelConfigField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const providers = useUsableProviders();
  const choice = parsePluginModelChoice(value) ?? 'session';
  const mode = typeof choice === 'string' ? choice : 'fixed';
  const fixed = typeof choice === 'string' ? null : choice;
  const provider = fixed ? providers.find((p) => p.id === fixed.providerId) : undefined;
  const model = provider?.models.find((m) => m.id === fixed?.modelId);
  return (
    <div className="space-y-2">
      <Select
        items={MODES}
        value={mode}
        onValueChange={(next) => {
          if (next === 'session' || next === 'title') onChange(next);
          else if (next === 'fixed' && !fixed) {
            const first = providers[0];
            const firstModel = first?.models[0];
            if (first && firstModel)
              onChange(formatPluginModelChoice({ providerId: first.id, modelId: firstModel.id }));
          }
        }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {Object.entries(MODES).map(([key, label]) => (
            <SelectItem key={key} value={key} disabled={key === 'fixed' && providers.length === 0}>
              {label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {fixed && (
        <ModelPicker
          providers={providers}
          providerId={provider?.id ?? ''}
          modelId={model?.id ?? ''}
          reasoningEnabled={false}
          thinkingLevel="medium"
          showReasoningControls={false}
          emptyLabel="选择模型"
          side="bottom"
          triggerClassName={MODEL_PICKER_DIALOG_TRIGGER_CLASS}
          onSelect={(providerId, modelId) =>
            onChange(formatPluginModelChoice({ providerId, modelId }))
          }
          onReasoningChange={() => {}}
          onThinkingChange={() => {}}
        />
      )}
      {fixed && !model && (
        <p className="text-destructive text-xs">选中的模型已不可用，运行时会失败，请重新选择。</p>
      )}
    </div>
  );
}
