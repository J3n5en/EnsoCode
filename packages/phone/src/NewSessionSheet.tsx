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
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [modelId, setModelId] = useState(providers[0]?.models[0]?.id ?? '');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('full');

  const provider = providers.find((p) => p.id === providerId);
  const canCreate = Boolean(projectId && providerId && modelId);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="bottom" className="pb-safe">
        <SheetHeader>
          <SheetTitle>新建会话</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 p-4">
          <Field label="项目">
            <Select
              items={projects.map((p) => ({ value: p.id, label: p.name }))}
              value={projectId}
              onValueChange={(v) => setProjectId(v as string)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
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
                setProviderId(v as string);
                setModelId(providers.find((p) => p.id === v)?.models[0]?.id ?? '');
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
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
              items={(provider?.models ?? []).map((m) => ({ value: m.id, label: m.label ?? m.id }))}
              value={modelId}
              onValueChange={(v) => setModelId(v as string)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {(provider?.models ?? []).map((m) => (
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
              <SelectPopup>
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
