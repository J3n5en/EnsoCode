import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalMode,
  ApprovalRequestInfo,
} from '@shared/types/agent';

interface PendingApproval {
  info: ApprovalRequestInfo;
  settle(result: 'allow' | 'deny' | 'cancel'): void;
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
    private readonly onResolve: (requestId: string) => void
  ) {}

  needsApproval(kind: ApprovalKind, tool: string): boolean {
    if (this.mode === 'full') return false;
    if (this.mode === 'auto-edits' && (kind === 'file-edit' || kind === 'file-write')) return false;
    return !this.sessionAllowed.has(tool);
  }

  /** 挂起等待用户决策；signal abort → cancel */
  ask(
    tool: string,
    kind: ApprovalKind,
    summary: string,
    signal: AbortSignal | undefined
  ): Promise<'allow' | 'deny' | 'cancel'> {
    const requestId = `apr-${++this.counter}-${Date.now()}`;
    const info: ApprovalRequestInfo = { requestId, tool, kind, summary };
    return new Promise((resolve) => {
      const settle = (result: 'allow' | 'deny' | 'cancel') => {
        if (!this.pending.delete(requestId)) return;
        signal?.removeEventListener('abort', onAbort);
        this.onResolve(requestId);
        resolve(result);
      };
      const onAbort = () => settle('cancel');
      this.pending.set(requestId, { info, settle });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.onRequest(info);
    });
  }

  /** 渲染层决策入口 */
  respond(requestId: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    if (decision === 'allowSession') this.sessionAllowed.add(entry.info.tool);
    entry.settle(decision === 'deny' ? 'deny' : 'allow');
  }

  /** abort / 会话终止：全部按取消收尾 */
  cancelAll(): void {
    for (const entry of [...this.pending.values()]) entry.settle('cancel');
  }

  snapshot(): ApprovalRequestInfo[] {
    return [...this.pending.values()].map((entry) => entry.info);
  }
}

/** 从工具参数提取审批展示文本：命令全文 / 文件路径 / 参数预览 */
function summarize(kind: ApprovalKind, params: unknown): string {
  const record = (params ?? {}) as Record<string, unknown>;
  if (kind === 'command' && typeof record.command === 'string') return record.command;
  if ((kind === 'file-edit' || kind === 'file-write') && typeof record.path === 'string') {
    return record.path;
  }
  try {
    return JSON.stringify(record).slice(0, 300);
  } catch {
    return '';
  }
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
      if (gate.needsApproval(kind, definition.name)) {
        const result = await gate.ask(definition.name, kind, summarize(kind, params), signal);
        if (result === 'deny') throw new Error('User denied this operation');
        if (result === 'cancel') throw new Error('Approval cancelled');
      }
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
