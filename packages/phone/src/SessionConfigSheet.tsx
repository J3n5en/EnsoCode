import type { ProviderEntry, ThinkingLevel } from '@enso/pair';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Z_INDEX } from '@/lib/z-index';

export interface SessionConfig {
  providerId?: string;
  modelId?: string;
  reasoningEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
}

interface Props {
  providers: ProviderEntry[];
  config: SessionConfig;
  open: boolean;
  onClose(): void;
  onSetModel(providerId: string, modelId: string): void;
  onSetReasoning(enabled: boolean): void;
  onSetThinking(level: ThinkingLevel): void;
}

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  max: '最高',
};

/**
 * 会话模型/推理档位调整：选择即发命令（与桌面选择器同语义——模型切换
 * 只影响后续 spawn，推理档位对已启动会话即时生效）。当前值来自目录快照，
 * 命令生效后随目录回推自然回显，不做本地乐观状态。
 */
export function SessionConfigSheet({
  providers,
  config,
  open,
  onClose,
  onSetModel,
  onSetReasoning,
  onSetThinking,
}: Props) {
  const provider = providers.find((p) => p.id === config.providerId);
  const reasoningOn = config.reasoningEnabled ?? false;
  const level = config.thinkingLevel ?? 'medium';

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="bottom" className="pb-safe">
        <SheetHeader>
          <SheetTitle>会话设置</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 p-4 pt-0">
          <Field label="模型服务">
            <Select
              items={providers.map((p) => ({ value: p.id, label: p.name }))}
              value={config.providerId ?? ''}
              onValueChange={(v) => {
                const next = providers.find((p) => p.id === v);
                const firstModel = next?.models[0]?.id;
                if (next && firstModel) onSetModel(next.id, firstModel);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          <Field label="模型">
            <Select
              items={(provider?.models ?? []).map((m) => ({
                value: m.id,
                label: m.label ?? m.id,
              }))}
              value={config.modelId ?? ''}
              onValueChange={(v) => {
                if (config.providerId) onSetModel(config.providerId, v as string);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                {(provider?.models ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label ?? m.id}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">推理</span>
            <Switch checked={reasoningOn} onCheckedChange={onSetReasoning} />
          </div>

          {reasoningOn && (
            <Field label="推理档位">
              <Select
                items={(Object.keys(LEVEL_LABELS) as ThinkingLevel[]).map((l) => ({
                  value: l,
                  label: LEVEL_LABELS[l],
                }))}
                value={level}
                onValueChange={(v) => onSetThinking(v as ThinkingLevel)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                  {(Object.keys(LEVEL_LABELS) as ThinkingLevel[]).map((l) => (
                    <SelectItem key={l} value={l}>
                      {LEVEL_LABELS[l]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          )}

          <p className="text-[11px] text-muted-foreground">
            模型切换对运行中的会话在下次启动时生效；推理档位即时生效。
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </label>
  );
}
