import { type SubagentOp, splitTrailingJson } from '@/stores/sessions/timeline';

export interface SubagentRunLine {
  agentId: string;
  runId: string;
  status: string;
  /** 结束了才有 */
  durationMs: number | null;
}

/** 子代理 report / wait / list 回执拆成回答、各 run 状态，与收起显示的运行信息原文 */
export type SubagentReceiptView = {
  /** 回执前捎带的系统提醒等 */
  head: string;
  /** list 时每个子代理一行：已关闭 / 没有 run 的 status 是子代理状态，runId 为空 */
  runs: SubagentRunLine[];
  /** 运行信息原文，不含单独显示的回答 */
  info: string;
} & (
  | { kind: 'report'; text: string | null; value: string | null; error: string | null }
  | { kind: 'wait'; timedOut: boolean; interrupted: boolean }
  | { kind: 'receipt' }
  | { kind: 'list' }
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const nonBlank = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

function toRunLine(value: unknown): SubagentRunLine | null {
  if (!isRecord(value)) return null;
  const { agentId, runId, status, createdAt, startedAt, finishedAt } = value;
  if (typeof agentId !== 'string' || typeof runId !== 'string' || typeof status !== 'string') {
    return null;
  }
  const start = typeof startedAt === 'number' ? startedAt : createdAt;
  return {
    agentId,
    runId,
    status,
    durationMs:
      typeof finishedAt === 'number' && typeof start === 'number'
        ? Math.max(0, finishedAt - start)
        : null,
  };
}

/** 这些子代理状态比最近一次 run 的结果更要紧 */
const AGENT_STATUS_FIRST = new Set<unknown>(['closed', 'parked', 'creating']);

function toAgentLine(value: unknown): SubagentRunLine | null {
  if (!isRecord(value)) return null;
  const { agentId, status, latestRun } = value;
  if (typeof agentId !== 'string' || typeof status !== 'string') return null;
  const run = AGENT_STATUS_FIRST.has(status) ? null : toRunLine(latestRun);
  return run ?? { agentId, runId: '', status, durationMs: null };
}

/**
 * report / wait / list 回执，及 spawn / send 带 wait:true 时回执附带的等待结果（op 缺省即 spawn / send）；
 * 对不上形状时返回 null，由调用方回退原文
 */
export function parseSubagentReceipt(
  op: SubagentOp | undefined,
  output: string | null | undefined
): SubagentReceiptView | null {
  const receipt = splitTrailingJson(output);
  if (!receipt) return null;
  const { head, value: json } = receipt;
  if (op === 'report') {
    const run = toRunLine(json.run);
    if (!run) return null;
    const { text, value, error, ...rest } = json;
    return {
      kind: 'report',
      head,
      runs: [run],
      text: nonBlank(text),
      value: value === undefined || value === null ? null : JSON.stringify(value, null, 2),
      error: nonBlank(error),
      info: JSON.stringify(rest, null, 2),
    };
  }
  if (op === 'list') {
    if (!Array.isArray(json.agents)) return null;
    const runs = json.agents.flatMap((entry) => toAgentLine(entry) ?? []);
    return runs.length === json.agents.length
      ? { kind: 'list', head, runs, info: JSON.stringify(json, null, 2) }
      : null;
  }
  const waited = op === 'wait' ? json : op === undefined ? json.report : null;
  if (!isRecord(waited) || !Array.isArray(waited.runs)) {
    // 不带 wait 的 spawn / resume 回执：状态是创建那一刻的，不单列，原文收进运行信息
    return (op === undefined || op === 'resume') &&
      json.report === undefined &&
      typeof json.agentId === 'string' &&
      typeof json.runId === 'string'
      ? { kind: 'receipt', head, runs: [], info: JSON.stringify(json, null, 2) }
      : null;
  }
  const runs = waited.runs.flatMap((entry) => toRunLine(entry) ?? []);
  if (runs.length !== waited.runs.length) return null;
  return {
    kind: 'wait',
    head,
    runs,
    timedOut: waited.timedOut === true,
    interrupted: waited.interrupted === true,
    info: JSON.stringify(json, null, 2),
  };
}

const ERROR_REASONS: Record<string, string> = {
  'restart-lost':
    'This subagent was started before EnsoCode restarted, and its record was lost in the restart',
  'other-owner': 'This subagent belongs to another conversation and cannot be controlled here',
  'not-found':
    'This conversation has no subagent with this id (mistyped, or agentId and runId mixed up)',
};

/** 子代理报错「码: 说明」→ 工具行标题的可读说明（i18n 键）；未登记的码返回 null，回退原文 */
export function subagentErrorReason(output: string | null | undefined): string | null {
  const code = /^([a-z][a-z-]*):\s/u.exec(output?.trim() ?? '')?.[1];
  return (code && ERROR_REASONS[code]) || null;
}
