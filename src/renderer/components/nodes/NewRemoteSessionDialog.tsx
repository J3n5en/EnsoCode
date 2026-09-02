import {
  type ApprovalMode,
  type ProjectEntry,
  type ProviderEntry,
  pairProjectListLabel,
} from '@enso/pair';
import { THINKING_LEVELS, type ThinkingLevel } from '@shared/types/agent';
import { useEffect, useState } from 'react';
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { Z_INDEX } from '@/lib/z-index';

export interface NewRemoteSessionRequest {
  projectId: string;
  providerId: string;
  modelId: string;
  approvalMode?: ApprovalMode;
  reasoningEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectEntry[];
  providers: ProviderEntry[];
  onCreate: (request: NewRemoteSessionRequest) => void;
}

// 与桌面 ApprovalModePicker 同 key
const APPROVAL_KEYS: Record<ApprovalMode, string> = {
  supervised: 'Supervised',
  'auto-edits': 'Auto-accept edits',
  full: 'Full access',
};
const LEVEL_KEYS: Record<ThinkingLevel, string> = {
  minimal: 'Min',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

/** 在远程节点上新建会话：只能选对方已添加的项目（cwd 由对方 main 反查）与对方已启用的模型 */
export function NewRemoteSessionDialog({
  open,
  onOpenChange,
  projects,
  providers,
  onCreate,
}: Props) {
  const { t } = useI18n();
  // 目录异步到达：记录用户显式选过的值，取值时对当前列表校验回落
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const [pickedProvider, setPickedProvider] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('full');
  const [reasoningEnabled, setReasoningEnabled] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('medium');

  useEffect(() => {
    if (!open) return;
    setPickedProject(null);
    setPickedProvider(null);
    setPickedModel(null);
  }, [open]);

  const projectId = projects.find((p) => p.id === pickedProject)?.id ?? projects[0]?.id ?? '';
  const provider: ProviderEntry = providers.find((p) => p.id === pickedProvider) ??
    providers[0] ?? { id: '', name: '', models: [] };
  const modelId =
    provider.models.find((m) => m.id === pickedModel)?.id ?? provider.models[0]?.id ?? '';
  const canCreate = Boolean(projectId && provider.id && modelId);

  const create = () => {
    if (!canCreate) return;
    onCreate({
      projectId,
      providerId: provider.id,
      modelId,
      approvalMode,
      ...(reasoningEnabled ? { reasoningEnabled: true, thinkingLevel } : {}),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('New remote conversation')}</DialogTitle>
          <DialogDescription>
            {t('The conversation runs on the remote computer with its projects, models and keys.')}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <Field label={t('Project')}>
            <Select
              items={projects.map((p) => ({ value: p.id, label: pairProjectListLabel(p) }))}
              value={projectId}
              onValueChange={(v) => setPickedProject(v as string)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {pairProjectListLabel(p)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label={t('Provider')}>
            <Select
              items={providers.map((p) => ({ value: p.id, label: p.name }))}
              value={provider.id}
              onValueChange={(v) => {
                setPickedProvider(v as string);
                setPickedModel(null);
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
          <Field label={t('Model')}>
            <Select
              items={provider.models.map((m) => ({ value: m.id, label: m.label ?? m.id }))}
              value={modelId}
              onValueChange={(v) => setPickedModel(v as string)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                {provider.models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label ?? m.id}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label={t('Approval mode')}>
            <Select
              items={(Object.keys(APPROVAL_KEYS) as ApprovalMode[]).map((mode) => ({
                value: mode,
                label: t(APPROVAL_KEYS[mode]),
              }))}
              value={approvalMode}
              onValueChange={(v) => setApprovalMode(v as ApprovalMode)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                {(Object.keys(APPROVAL_KEYS) as ApprovalMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(APPROVAL_KEYS[mode])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">{t('Reasoning')}</span>
            <Switch checked={reasoningEnabled} onCheckedChange={setReasoningEnabled} />
          </div>
          {reasoningEnabled && (
            <Field label={t('Thinking level')}>
              <Select
                items={THINKING_LEVELS.map((l) => ({ value: l, label: t(LEVEL_KEYS[l]) }))}
                value={thinkingLevel}
                onValueChange={(v) => setThinkingLevel(v as ThinkingLevel)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                  {THINKING_LEVELS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {t(LEVEL_KEYS[l])}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button size="sm" disabled={!canCreate} onClick={create}>
            {t('Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  );
}
