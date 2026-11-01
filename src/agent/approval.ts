import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ApprovalReviewFallback, ApprovalReviewRecord } from '@shared/approvalReviewRecord';
import { APPROVAL_TIMEOUT_ERROR } from '@shared/humanRequestTimeout';
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalMode,
  ApprovalRequestInfo,
  ProtectedActionCategory,
} from '@shared/types/agent';
import { rememberApprovalReview } from './approvalReviewRecords';
import type { CommandGuard, CommandGuardHit } from './dcg';
import { classifyProtectedTool } from './protectedActions';
import { extractWriteTargetPaths } from './writeScope';

type ApprovalResult = 'allow' | 'deny' | 'block' | 'cancel' | 'timeout' | 'unattended';

/** unattended 档的拒绝文案：不指名工具，避免同一句文案因工具不同而被归成不同错误族 */
export const APPROVAL_UNATTENDED_ERROR =
  'Blocked: this session runs unattended, so any action that needs approval is rejected without asking. ' +
  'Do not retry the same call; use an action that needs no approval, or ask the user to switch the approval mode.';

interface PendingApproval {
  info: ApprovalRequestInfo;
  settle(result: ApprovalResult): void;
}

export type ApprovalReviewResult =
  | { decision: 'auto_allow' | 'block'; rationale?: string; record?: ApprovalReviewRecord }
  /** 托管拒绝：只拒这一条，message 作为工具错误交回模型 */
  | { decision: 'deny'; message: string; record?: ApprovalReviewRecord }
  /** fallback：托管判定无效，退回人工并在卡片上说明 */
  | { decision: 'ask_user'; rationale?: string; fallback?: ApprovalReviewFallback };

export type ApprovalReviewFn = (
  info: ApprovalRequestInfo,
  signal: AbortSignal | undefined
) => Promise<ApprovalReviewResult>;

export interface ApprovalGateOptions {
  review?: ApprovalReviewFn;
  /** 受保护动作底线：开启时对外发送 / 删除 / 付款 / 部署 / 密钥类动作无视档位与会话白名单，强制真人确认 */
  protectedFloor?: boolean;
  /** bot 模式：档位为 full 时底线不生效（完全放行即真放行），按当前档位实时判断 */
  exemptFull?: boolean;
  /** 等真人处理的时限：真人阶段的请求带 expiresAt，由 Main 到期发 request-timeout */
  humanTimeoutMs?: number;
  /** dcg 命令守卫：命中即按 destructive 强制真人确认；豁免规则同底线 */
  commandGuard?: CommandGuard;
}

/**
 * 会话级审批门：worker 侧持有 pending 与「本会话总是允许」记忆。
 * fail-closed：cancelAll / abort 一律按取消收尾，绝不放行。
 */
export class ApprovalGate {
  private sessionAllowed = new Set<string>();
  private pending = new Map<string, PendingApproval>();
  private counter = 0;

  constructor(
    public mode: ApprovalMode,
    private readonly onRequest: (info: ApprovalRequestInfo) => void,
    private readonly onResolve: (requestId: string) => void,
    private readonly options?: ApprovalGateOptions
  ) {}

  get protectedFloor(): boolean {
    if (this.options?.protectedFloor !== true) return false;
    return !(this.options.exemptFull === true && this.mode === 'full');
  }

  /** 子会话沿用底线配置，再按自身档位判断 */
  get floorOptions(): Pick<
    ApprovalGateOptions,
    'protectedFloor' | 'exemptFull' | 'humanTimeoutMs' | 'commandGuard'
  > {
    return {
      protectedFloor: this.options?.protectedFloor === true,
      exemptFull: this.options?.exemptFull === true,
      humanTimeoutMs: this.options?.humanTimeoutMs,
      commandGuard: this.options?.commandGuard,
    };
  }

  get commandGuard(): CommandGuard | undefined {
    if (this.options?.exemptFull === true && this.mode === 'full') return undefined;
    return this.options?.commandGuard;
  }

  get humanTimeoutMs(): number | undefined {
    return this.options?.humanTimeoutMs;
  }

  needsApproval(kind: ApprovalKind, tool: string): boolean {
    // 无人值守：需要确认的一律要「确认」，只是确认会被拒绝而不是等人
    if (this.mode === 'unattended') return true;
    if (this.mode === 'full') return false;
    if (this.mode === 'auto-edits' && (kind === 'file-edit' || kind === 'file-write')) return false;
    return !this.sessionAllowed.has(tool);
  }

  /** 挂起等待用户决策；signal abort → cancel */
  ask(
    tool: string,
    kind: ApprovalKind,
    summary: string,
    signal: AbortSignal | undefined,
    toolCallId?: string,
    filePaths?: string[],
    protectedCategory?: ProtectedActionCategory,
    guard?: CommandGuardHit
  ): Promise<ApprovalResult> {
    // 无人值守：不建 pending、不占人，直接拒绝
    if (this.mode === 'unattended') return Promise.resolve('unattended');
    const requestId = `apr-${++this.counter}-${Date.now()}`;
    let info: ApprovalRequestInfo = {
      requestId,
      tool,
      kind,
      summary,
      ...(filePaths?.length ? { filePaths: [...filePaths] } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(protectedCategory ? { protected: protectedCategory } : {}),
      ...(guard ? { guard: { ...guard } } : {}),
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (result: ApprovalResult, denial?: Error) => {
        if (settled) return;
        settled = true;
        this.pending.delete(requestId);
        signal?.removeEventListener('abort', onAbort);
        this.onResolve(requestId);
        if (denial) reject(denial);
        else resolve(result);
      };
      const onAbort = () => settle('cancel');
      const askHuman = (fallback?: ApprovalReviewFallback) => {
        info = { ...info, phase: undefined, ...(fallback ? { reviewFallback: fallback } : {}) };
        const timeoutMs = this.options?.humanTimeoutMs;
        if (timeoutMs) info = { ...info, expiresAt: Date.now() + timeoutMs };
        this.pending.set(requestId, { info, settle });
        this.onRequest(info);
      };
      this.pending.set(requestId, { info, settle });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        settle('cancel');
        return;
      }
      // 受保护动作不交给代审模型放行，直接等真人
      const review =
        this.mode === 'assistant' && !protectedCategory ? this.options?.review : undefined;
      if (!review) {
        askHuman();
        return;
      }
      info = { ...info, phase: 'reviewing' };
      this.pending.set(requestId, { info, settle });
      this.onRequest(info);
      void Promise.resolve()
        .then(() => review(info, signal))
        .then((result) => {
          if (settled) return;
          // 代审期间档位被改过：旧档的结论不再算数，按当前档位重新路由
          if (this.mode !== 'assistant') {
            if (this.mode === 'unattended') {
              settle('unattended');
              return;
            }
            if (!info.protected && !this.needsApproval(info.kind, info.tool)) {
              settle('allow');
              return;
            }
            askHuman();
            return;
          }
          if (result.decision !== 'ask_user' && result.record && toolCallId) {
            rememberApprovalReview(toolCallId, result.record);
          }
          if (result.decision === 'auto_allow') {
            settle('allow');
            return;
          }
          if (result.decision === 'block') {
            settle('block');
            return;
          }
          if (result.decision === 'deny') {
            settle('block', new Error(result.message));
            return;
          }
          askHuman(result.decision === 'ask_user' ? result.fallback : undefined);
        })
        .catch(() => {
          if (!settled) askHuman();
        });
    });
  }

  /** 渲染层决策入口 */
  respond(requestId: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    if (decision === 'allowSession' && !entry.info.protected) {
      this.sessionAllowed.add(entry.info.tool);
    }
    entry.settle(decision === 'deny' ? 'deny' : 'allow');
  }

  /** Main 判定等人超时：按超时拒绝（区别于用户主动拒绝） */
  expire(requestId: string): void {
    this.pending.get(requestId)?.settle('timeout');
  }

  /** abort / 会话终止：全部按取消收尾 */
  cancelAll(): void {
    for (const entry of [...this.pending.values()]) entry.settle('cancel');
  }

  /** 档位变更后重判挂起请求：切档即时生效，不让卡片一直等到超时 */
  reconsider(): void {
    for (const entry of [...this.pending.values()]) {
      if (this.mode === 'unattended') {
        entry.settle('unattended');
        continue;
      }
      // 受保护动作永远要真人，不随档位放行
      if (!entry.info.protected && !this.needsApproval(entry.info.kind, entry.info.tool)) {
        entry.settle('allow');
      }
    }
  }

  snapshot(): ApprovalRequestInfo[] {
    return [...this.pending.values()].map((entry) => entry.info);
  }
}

/** 从工具参数提取审批展示文本：命令全文 / 文件路径 / 参数预览 */
export function summarizeApproval(kind: ApprovalKind, params: unknown, toolName = 'edit'): string {
  const record = (params ?? {}) as Record<string, unknown>;
  if (kind === 'command' && typeof record.command === 'string') return record.command;
  if (kind === 'file-edit' || kind === 'file-write') {
    const targets = extractWriteTargetPaths(toolName, params);
    if (targets.length > 0) return targets.join('\n');
  }
  try {
    return JSON.stringify(record).slice(0, 300);
  } catch {
    return '';
  }
}

export function throwUnlessAllowed(result: ApprovalResult): void {
  if (result === 'unattended') throw new Error(APPROVAL_UNATTENDED_ERROR);
  if (result === 'block') throw new Error('Assistant approval blocked this operation');
  if (result === 'deny') throw new Error('User denied this operation');
  if (result === 'cancel') throw new Error('Approval cancelled');
  if (result === 'timeout') throw new Error(APPROVAL_TIMEOUT_ERROR);
}

/** 给工具包一道审批门：deny/cancel 抛错（pi 转 isError 工具结果，轮继续） */
export function withApproval(
  gate: ApprovalGate,
  kind: ApprovalKind,
  definition: ToolDefinition
): ToolDefinition {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const floorCategory = gate.protectedFloor
        ? classifyProtectedTool(definition.name, kind, params)
        : null;
      const command = (params as { command?: unknown } | undefined)?.command;
      const guard =
        kind === 'command' && typeof command === 'string'
          ? await gate.commandGuard?.(definition.name, command, signal)
          : undefined;
      const protectedCategory = floorCategory ?? (guard ? 'destructive' : null);
      if (protectedCategory || gate.needsApproval(kind, definition.name)) {
        const filePaths =
          kind === 'file-edit' || kind === 'file-write'
            ? extractWriteTargetPaths(definition.name, params)
            : undefined;
        throwUnlessAllowed(
          await gate.ask(
            definition.name,
            kind,
            summarizeApproval(kind, params, definition.name),
            signal,
            toolCallId,
            filePaths,
            protectedCategory ?? undefined,
            guard ?? undefined
          )
        );
      }
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/** 平时免审的只读工具：只在底线开启且读取密钥文件时要求确认 */
export function withProtectedFloor(
  gate: ApprovalGate,
  kind: 'read',
  definition: ToolDefinition
): ToolDefinition {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const protectedCategory = gate.protectedFloor
        ? classifyProtectedTool(definition.name, kind, params)
        : null;
      if (protectedCategory) {
        const record = (params ?? {}) as Record<string, unknown>;
        throwUnlessAllowed(
          await gate.ask(
            definition.name,
            'command',
            `${definition.name} ${String(record.path ?? record.file_path ?? '')}`,
            signal,
            toolCallId,
            undefined,
            protectedCategory
          )
        );
      }
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
