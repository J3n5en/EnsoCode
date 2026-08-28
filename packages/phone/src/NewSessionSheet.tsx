import type { ApprovalMode, ProjectEntry, ProviderEntry } from '@enso/pair';
import { useState } from 'react';

export interface NewSessionRequest {
  projectId: string;
  providerId: string;
  modelId: string;
  approvalMode?: ApprovalMode;
}

interface Props {
  projects: ProjectEntry[];
  providers: ProviderEntry[];
  onClose(): void;
  onCreate(request: NewSessionRequest): void;
}

/** 新建会话：只能选桌面已添加的项目（cwd 由 main 反查）与已启用的模型 */
export function NewSessionSheet({ projects, providers, onClose, onCreate }: Props) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [modelId, setModelId] = useState(providers[0]?.models[0]?.id ?? '');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('full');

  const provider = providers.find((p) => p.id === providerId);
  const canCreate = projectId && providerId && modelId;

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="presentation">
        <h2>新建会话</h2>

        <label className="field">
          <span>项目</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>模型服务</span>
          <select
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              const next = providers.find((p) => p.id === e.target.value);
              setModelId(next?.models[0]?.id ?? '');
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>模型</span>
          <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {(provider?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>审批模式</span>
          <select
            value={approvalMode}
            onChange={(e) => setApprovalMode(e.target.value as ApprovalMode)}
          >
            <option value="full">全部需审批</option>
            <option value="auto-edits">自动改文件</option>
            <option value="supervised">受监督</option>
          </select>
        </label>

        {projects.length === 0 && <p className="error">桌面端还没有项目，请先在桌面添加。</p>}

        <div className="sheet-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!canCreate}
            onClick={() => onCreate({ projectId, providerId, modelId, approvalMode })}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
