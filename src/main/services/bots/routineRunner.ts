import { parseChildSessionIdentity } from '../../../shared/builtinAgents';
import type { AgentWorkerEvent, SessionIdentity } from '../../../shared/types/agent';
import type { BotRoutine } from '../../../shared/types/bot';
import type { BotSessionHost } from './botSessionHost';
import type { BotChatStore } from './chatStore';
import type { GroupChatService } from './groupChat';
import type { RoutineRunOptions, RoutineRunResult } from './routineScheduler';

type Result = RoutineRunResult;
const DRY_RUN_NOTE =
  '[Dry run] The user triggered this routine manually as a trial run; it does not affect the schedule. Do the task as you normally would.';
const attr = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export class RoutineRunner {
  private readonly unsubscribe: () => void;
  private disposed = false;
  private pending = new Map<string, (result: Result) => void>();
  private approvals = new Map<
    string,
    { conversationId: string; deliveryId: string; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    private readonly deps: {
      host: BotSessionHost;
      chats: BotChatStore;
      groups: GroupChatService;
      deny: (identity: SessionIdentity, requestId: string) => void;
    }
  ) {
    this.unsubscribe = deps.host.onTurnFinished((event) => {
      if (event.deliveryId) {
        this.pending.get(event.deliveryId)?.({
          ok: event.ok,
          ...(event.error ? { error: event.error } : {}),
          conversationId: event.conversationId,
        });
        this.pending.delete(event.deliveryId);
      }
      for (const [key, approval] of this.approvals)
        if (
          approval.conversationId === event.conversationId &&
          approval.deliveryId === event.deliveryId
        ) {
          clearTimeout(approval.timer);
          this.approvals.delete(key);
        }
    });
  }

  /** 以 executorId 的身份投进 routine.chatId；deliveryId 由调度器按 (routineId, scheduledFor) 派生 */
  run(routine: BotRoutine, { deliveryId, executorId, dryRun }: RoutineRunOptions): Promise<Result> {
    if (this.disposed) return Promise.resolve({ ok: false, error: 'disabled' });
    const text = dryRun
      ? `<routine title="${attr(routine.title)}" dry-run="true">${DRY_RUN_NOTE}\n\n${routine.prompt}</routine>`
      : `<routine title="${attr(routine.title)}">${routine.prompt}</routine>`;
    const options = { deliveryId, queueIfBusy: true, source: 'background' as const };
    return new Promise((resolve) => {
      this.pending.set(deliveryId, resolve);
      const sent =
        this.deps.chats.get(routine.chatId)?.kind === 'group'
          ? this.deps.groups.runAs(
              routine.chatId,
              executorId,
              text,
              dryRun ? `${routine.title}（试运行）` : routine.title,
              options
            )
          : this.deps.host.deliver(routine.chatId, executorId, text, options);
      void sent
        .then((result) => {
          // 同一 deliveryId 已处理过（占用之外的兜底）：不会再有结束事件
          const duplicate = result.ok && 'duplicate' in result && result.duplicate;
          if (!result.ok || duplicate) {
            this.pending.delete(deliveryId);
            resolve(
              result.ok
                ? { ok: false, error: 'duplicate', conversationId: result.conversationId }
                : result
            );
          }
        })
        .catch((error) => {
          this.pending.delete(deliveryId);
          resolve({ ok: false, error: String(error) });
        });
    });
  }

  observe(event: AgentWorkerEvent | { type: 'worker-exited' }): void {
    if (this.disposed) return;
    if (event.type !== 'approval-request' && event.type !== 'approval-resolved') return;
    const requestId = event.type === 'approval-request' ? event.request.requestId : event.requestId;
    const key = `${event.identity.sessionId}:${event.identity.generation}:${requestId}`;
    if (event.type === 'approval-resolved') {
      clearTimeout(this.approvals.get(key)?.timer);
      this.approvals.delete(key);
      return;
    }
    const conversationId =
      parseChildSessionIdentity(event.identity)?.parent.sessionId ?? event.identity.sessionId;
    const delivery = this.deps.host.activeDeliveryId(conversationId);
    if (!delivery || !this.pending.has(delivery) || this.approvals.has(key)) return;
    const timer = setTimeout(
      () => {
        this.approvals.delete(key);
        this.deps.deny(event.identity, requestId);
      },
      30 * 60 * 1000
    );
    timer.unref?.();
    this.approvals.set(key, { conversationId, deliveryId: delivery, timer });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const resolve of this.pending.values()) resolve({ ok: false, error: 'canceled' });
    this.pending.clear();
    for (const approval of this.approvals.values()) clearTimeout(approval.timer);
    this.approvals.clear();
  }
}
