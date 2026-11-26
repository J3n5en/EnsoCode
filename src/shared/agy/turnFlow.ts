/**
 * 一段 agy 回复（Enso 里的一条 assistant）什么时候收尾。一次 session/prompt 对应一段；
 * 插话（轮中再发 session/prompt）会让前一段的 prompt 提早返回、剩余文字照流，
 * end_turn 时还在跑的后台命令 / 子任务让这一段在 prompt 返回后继续收 agy 自己的回复。
 */
export interface TurnFlow {
  /** session/prompt 已返回 */
  response?: { stopReason: unknown; withUsage: boolean };
  /** 本段还在流时又发了一次 session/prompt */
  steered: boolean;
  /** prompt 已 end_turn，但还有后台工作：只由安静计时器或插话收尾 */
  held: boolean;
  /** 上一个 usage_update 之后又来了输出（agy 每段回复以 usage_update 收口） */
  replyOpen: boolean;
  closed: boolean;
}

export type FlowEvent =
  | { type: 'response'; stopReason: unknown; withUsage: boolean; background: boolean }
  | { type: 'steer' }
  | { type: 'update'; kind: string; background: boolean }
  | { type: 'quiet' };

/** hold：后台工作还在；reply：后台工作结束、agy 的回复还没收口；settle：回复已收口，稍等再收尾 */
export type FlowTimer = 'none' | 'hold' | 'reply' | 'settle';

/** 对照 t3：postSettleCommandHold 30 分钟、ACP_OPEN_REPLY_QUIET_LIMIT 2 分钟、ACP_DEFERRED_FINALIZE_DEBOUNCE 3 秒 */
export const FLOW_TIMER_MS: Record<Exclude<FlowTimer, 'none'>, number> = {
  hold: 30 * 60_000,
  reply: 2 * 60_000,
  settle: 3_000,
};

const OUTPUT_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
]);

export function initialTurnFlow(): TurnFlow {
  return { steered: false, held: false, replyOpen: false, closed: false };
}

function close(flow: TurnFlow): TurnFlow {
  return { ...flow, closed: true };
}

function next(flow: TurnFlow, event: FlowEvent): TurnFlow {
  switch (event.type) {
    case 'response': {
      const settled = {
        ...flow,
        response: { stopReason: event.stopReason, withUsage: event.withUsage },
      };
      if (event.stopReason !== 'end_turn') return close(settled);
      // 被插话的 prompt 提早返回且不带 usage：这段回复还没流完，等下一个 usage_update
      if (flow.steered) return event.withUsage ? close(settled) : settled;
      return event.background ? { ...settled, held: true } : close(settled);
    }
    case 'steer':
      return flow.response ? close(flow) : { ...flow, steered: true };
    case 'update':
      if (event.kind === 'usage_update') {
        const quiet = { ...flow, replyOpen: false };
        return flow.steered && flow.response ? close(quiet) : quiet;
      }
      return OUTPUT_UPDATES.has(event.kind) ? { ...flow, replyOpen: true } : flow;
    case 'quiet':
      return flow.held ? close(flow) : flow;
  }
}

/** 走一步，并给出接下来该挂的安静计时器（每个事件都重挂：t3 也按“多久没动静”计）。 */
export function stepTurnFlow(
  flow: TurnFlow,
  event: FlowEvent
): { flow: TurnFlow; timer: FlowTimer } {
  if (flow.closed) return { flow, timer: 'none' };
  const after = next(flow, event);
  if (after.closed || !after.held) return { flow: after, timer: 'none' };
  if ((event.type === 'response' || event.type === 'update') && event.background) {
    return { flow: after, timer: 'hold' };
  }
  return { flow: after, timer: after.replyOpen ? 'reply' : 'settle' };
}
