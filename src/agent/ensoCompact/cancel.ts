import { DEFAULT_CONTEXT_WINDOW } from './budget';

export interface CompactCancel {
  reason: 'uncompressible' | 'no_saving';
  budget: number;
  estimatedAfter: number;
  tokensBefore: number;
  contextWindow?: number;
}

/** pi 对扩展取消只给 aborted、不带原因；钩子按会话暂存，supervisor 在 compaction_end 取走 */
const pending = new WeakMap<object, CompactCancel>();

export function recordCompactCancel(sessionManager: object, cancel: CompactCancel): void {
  pending.set(sessionManager, cancel);
}

export function takeCompactCancel(sessionManager: object): CompactCancel | undefined {
  const cancel = pending.get(sessionManager);
  pending.delete(sessionManager);
  return cancel;
}

export function formatCompactCancel(cancel: CompactCancel): string {
  const window = cancel.contextWindow ?? `未知，按默认 ${DEFAULT_CONTEXT_WINDOW}`;
  return cancel.reason === 'no_saving'
    ? `压缩已取消（no_saving）：压缩后约 ${cancel.estimatedAfter} tokens，相比压缩前 ${cancel.tokensBefore} 节省不足 10%`
    : `压缩已取消（uncompressible）：最短可保留尾巴约 ${cancel.estimatedAfter} tokens，超过发送预算 ${cancel.budget}（上下文窗口 ${window}，压缩前 ${cancel.tokensBefore}）`;
}
