import { describe, expect, it } from 'vitest';
import { type FlowEvent, initialTurnFlow, stepTurnFlow, type TurnFlow } from './turnFlow';

function run(events: FlowEvent[], from: TurnFlow = initialTurnFlow()) {
  let flow = from;
  let timer = 'none';
  for (const event of events) {
    const next = stepTurnFlow(flow, event);
    flow = next.flow;
    timer = next.timer;
  }
  return { flow, timer };
}

const text: FlowEvent = { type: 'update', kind: 'agent_message_chunk', background: false };
const usage: FlowEvent = { type: 'update', kind: 'usage_update', background: false };
const endTurn = (withUsage: boolean, background = false): FlowEvent => ({
  type: 'response',
  stopReason: 'end_turn',
  withUsage,
  background,
});

describe('agy turn flow', () => {
  it('closes a plain reply when its prompt returns', () => {
    expect(run([text, usage, endTurn(true)]).flow.closed).toBe(true);
  });

  it('closes on cancel or error even with background work', () => {
    const cancelled: FlowEvent = {
      type: 'response',
      stopReason: 'cancelled',
      withUsage: false,
      background: true,
    };
    expect(run([text, cancelled]).flow.closed).toBe(true);
  });

  it('keeps a steered reply open past its early end_turn until the next usage_update', () => {
    // agy 1.5.18：第一个 prompt 在插话发出后 23ms 返回 end_turn（无 usage），剩余文字照流
    const steered = run([text, { type: 'steer' }, endTurn(false), text, text]);
    expect(steered.flow.closed).toBe(false);
    expect(run([usage], steered.flow).flow.closed).toBe(true);
  });

  it('closes at once when the steer came after the reply had already finished', () => {
    expect(run([text, usage, { type: 'steer' }, endTurn(true)]).flow.closed).toBe(true);
  });

  it('does not treat a usage_update before the prompt returns as the steer boundary', () => {
    const early = run([text, { type: 'steer' }, usage]);
    expect(early.flow.closed).toBe(false);
  });

  it('holds a reply whose prompt ended while a background command still runs', () => {
    const held = run([text, endTurn(true, true)]);
    expect(held.flow.closed).toBe(false);
    expect(held.timer).toBe('hold');
  });

  it('waits for the wake reply after the background work ends, then settles on quiet', () => {
    const held = run([text, endTurn(true, true)]);
    const finished = run(
      [{ type: 'update', kind: 'tool_call_update', background: false }],
      held.flow
    );
    // 命令结束后 agy 自己接着回复：输出没以 usage_update 收口前多等一会
    expect(finished.timer).toBe('reply');
    const replied = run([text, usage], finished.flow);
    expect(replied.flow.closed).toBe(false);
    expect(replied.timer).toBe('settle');
    expect(run([{ type: 'quiet' }], replied.flow).flow.closed).toBe(true);
  });

  it('ends the hold when nothing arrives for the hold limit', () => {
    const held = run([text, endTurn(true, true)]);
    expect(run([{ type: 'quiet' }], held.flow).flow.closed).toBe(true);
  });

  it('ends a held reply when the user steers', () => {
    const held = run([text, endTurn(true, true)]);
    expect(run([{ type: 'steer' }], held.flow).flow.closed).toBe(true);
  });

  it('ignores quiet before the prompt returns', () => {
    expect(run([text, { type: 'quiet' }]).flow.closed).toBe(false);
  });
});
