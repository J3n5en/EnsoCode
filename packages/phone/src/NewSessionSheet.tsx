import type { ApprovalMode, ProjectEntry, ProviderEntry } from '@enso/pair';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Z_INDEX } from '@/lib/z-index';

export interface NewSessionRequest {
  projectId: string;
  providerId: string;
  modelId: string;
  approvalMode?: ApprovalMode;
}

interface Props {
  projects: ProjectEntry[];
  providers: ProviderEntry[];
  open: boolean;
  onClose(): void;
  onCreate(request: NewSessionRequest): void;
}

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  full: '全部需审批',
  'auto-edits': '自动改文件',
  supervised: '受监督',
};

/** 新建会话：只能选桌面已添加的项目（cwd 由 main 反查）与已启用的模型 */
export function NewSessionSheet({ projects, providers, open, onClose, onCreate }: Props) {
  // 组件常驻挂载，目录是异步到达的：选中值存"用户是否显式选过"，
  // 实际取值再对当前列表做校验回落，避免初值算在空列表上而永远选不中。
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const [pickedProvider, setPickedProvider] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('full');

  const projectId = projects.find((p) => p.id === pickedProject)?.id ?? projects[0]?.id ?? '';
  const provider = providers.find((p) => p.id === pickedProvider) ??
    providers[0] ?? { id: '', models: [] };
  const providerId = provider.id;
  const modelId =
    provider.models.find((m) => m.id === pickedModel)?.id ?? provider.models[0]?.id ?? '';

  const canCreate = Boolean(projectId && providerId && modelId);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="bottom" className="pb-safe">
        <SheetHeader>
          <SheetTitle>新建会话</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 p-4 pt-0">
          <Field label="项目">
            <Select
              items={projects.map((p) => ({ value: p.id, label: p.name }))}
              value={projectId}
              onValueChange={(v) => setPickedProject(v as string)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          <Field label="模型服务">
            <Select
              items={providers.map((p) => ({ value: p.id, label: p.name }))}
              value={providerId}
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

          <Field label="模型">
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

          <Field label="审批模式">
            <Select
              items={(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => ({
                value: mode,
                label: APPROVAL_LABELS[mode],
              }))}
              value={approvalMode}
              onValueChange={(v) => setApprovalMode(v as ApprovalMode)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
                {(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {APPROVAL_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          {projects.length === 0 && (
            <p className="text-destructive text-xs">桌面端还没有项目，请先在桌面添加。</p>
          )}
          {projects.length > 0 && providers.length === 0 && (
            <p className="text-destructive text-xs">桌面端没有可用的模型服务。</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              disabled={!canCreate}
              onClick={() => onCreate({ projectId, providerId, modelId, approvalMode })}
            >
              创建
            </Button>
          </div>
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
