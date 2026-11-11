export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type WorkflowMemberStatus = 'running' | 'completed' | 'failed';

export interface WorkflowMemberSnapshot {
  seq: number;
  label: string;
  phase?: string;
  batch: number;
  status: WorkflowMemberStatus;
  prompt?: string;
  result?: string;
  childId?: string;
}

export interface WorkflowRunSnapshot {
  runId: string;
  name: string;
  description: string;
  status: WorkflowRunStatus;
  phase?: string;
  logs: string[];
  members: WorkflowMemberSnapshot[];
  error?: string;
}

export interface WorkflowMemberGroup {
  phase?: string;
  batch: number;
  members: WorkflowMemberSnapshot[];
}

export type WorkflowPresetSource = 'project' | 'custom' | 'global' | 'plugin' | 'builtin';

const WORKFLOW_PRESET_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DISABLED_WORKFLOW_PRESETS = 64;

export function isWorkflowPresetId(id: string): boolean {
  return WORKFLOW_PRESET_ID_RE.test(id);
}

/** 设置里禁用的内置预设 id：跨进程边界收窄，坏值丢弃 */
export function parseDisabledWorkflowPresets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === 'string' && isWorkflowPresetId(id));
  return [...new Set(ids)].slice(0, MAX_DISABLED_WORKFLOW_PRESETS);
}

export interface WorkflowPresetArg {
  key: string;
  label: string;
  default?: string;
  required?: boolean;
}

/** 侧边栏展示用；脚本正文只在 worker 执行时按 id 读取，不经 renderer。 */
export interface WorkflowPresetSummary {
  id: string;
  source: WorkflowPresetSource;
  name: string;
  description: string;
  args: WorkflowPresetArg[];
}

/** 设计器步骤；agentType 为空 = 运行时默认（worker） */
export interface WorkflowDesignStep {
  label: string;
  agentType: string;
  prompt: string;
}

/** 同一阶段内的步骤并行，阶段之间串行 */
export interface WorkflowDesignPhase {
  title: string;
  steps: WorkflowDesignStep[];
}

export interface WorkflowDesign {
  phases: WorkflowDesignPhase[];
}

/** 设置页编辑的表单内容；脚本不含注释头，保存时由 Main 序列化成预设文件。有 design 时脚本由它生成。 */
export interface WorkflowPresetDraft {
  name: string;
  description: string;
  args: WorkflowPresetArg[];
  script: string;
  design?: WorkflowDesign;
}

export type WorkflowPresetSaveResult = { ok: true; id: string } | { ok: false; error: string };

export function groupWorkflowMembers(
  members: readonly WorkflowMemberSnapshot[]
): WorkflowMemberGroup[] {
  const groups: WorkflowMemberGroup[] = [];
  for (const member of members) {
    const last = groups.at(-1);
    if (last && last.batch === member.batch && last.phase === member.phase) {
      last.members.push(member);
      continue;
    }
    groups.push({
      batch: member.batch,
      members: [member],
      ...(member.phase ? { phase: member.phase } : {}),
    });
  }
  return groups;
}

const RUN_STATUSES = new Set<WorkflowRunStatus>(['running', 'completed', 'failed', 'cancelled']);
const MEMBER_STATUSES = new Set<WorkflowMemberStatus>(['running', 'completed', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  return text;
}

export function parseWorkflowRunSnapshot(value: unknown): WorkflowRunSnapshot | null {
  if (!isRecord(value)) return null;
  const runId = bounded(value.runId, 80);
  const name = bounded(value.name, 80);
  const description = bounded(value.description, 240);
  if (!runId || !name || !description || !RUN_STATUSES.has(value.status as WorkflowRunStatus)) {
    return null;
  }
  const phase = value.phase === undefined ? undefined : bounded(value.phase, 80);
  if (value.phase !== undefined && !phase) return null;
  const error = value.error === undefined ? undefined : bounded(value.error, 400);
  if (value.error !== undefined && !error) return null;
  if (!Array.isArray(value.logs) || value.logs.length > 20) return null;
  const logs: string[] = [];
  for (const line of value.logs) {
    const text = bounded(line, 160);
    if (!text) return null;
    logs.push(text);
  }
  if (!Array.isArray(value.members) || value.members.length > 32) return null;
  const members: WorkflowMemberSnapshot[] = [];
  for (const member of value.members) {
    if (!isRecord(member) || !Number.isInteger(member.seq) || (member.seq as number) < 1) {
      return null;
    }
    const label = bounded(member.label, 80);
    const memberPhase = member.phase === undefined ? undefined : bounded(member.phase, 80);
    const prompt = member.prompt === undefined ? undefined : bounded(member.prompt, 160);
    const result = member.result === undefined ? undefined : bounded(member.result, 160);
    const childId = member.childId === undefined ? undefined : bounded(member.childId, 80);
    if (!label || !MEMBER_STATUSES.has(member.status as WorkflowMemberStatus)) return null;
    if (member.phase !== undefined && !memberPhase) return null;
    if (!Number.isInteger(member.batch) || (member.batch as number) < 1) return null;
    if (member.prompt !== undefined && !prompt) return null;
    if (member.result !== undefined && !result) return null;
    if (member.childId !== undefined && !childId) return null;
    members.push({
      seq: member.seq as number,
      label,
      batch: member.batch as number,
      status: member.status as WorkflowMemberStatus,
      ...(memberPhase ? { phase: memberPhase } : {}),
      ...(prompt ? { prompt } : {}),
      ...(result ? { result } : {}),
      ...(childId ? { childId } : {}),
    });
  }
  return {
    runId,
    name,
    description,
    status: value.status as WorkflowRunStatus,
    logs,
    members,
    ...(phase ? { phase } : {}),
    ...(error ? { error } : {}),
  };
}
