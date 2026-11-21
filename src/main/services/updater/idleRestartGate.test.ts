import { AUTO_RESTART_IDLE_MS } from '@shared/updater/idleRestart';
import { describe, expect, it } from 'vitest';
import { IdleRestartGate } from './idleRestartGate';

const ready = {
  agentBusy: false,
  userActive: false,
  unsentDraft: false,
  queuedCount: 0,
  pendingAskCount: 0,
  pendingApprovalCount: 0,
  windowFocused: false,
};

describe('IdleRestartGate', () => {
  it('连续空闲满 5 分钟才放行，打断后重计', () => {
    const gate = new IdleRestartGate();
    expect(gate.evaluate(ready, 'idle', 0)).toBe(false);
    expect(gate.evaluate(ready, 'idle', AUTO_RESTART_IDLE_MS - 1)).toBe(false);
    expect(gate.evaluate(ready, 'idle', AUTO_RESTART_IDLE_MS)).toBe(true);
    expect(gate.evaluate({ ...ready, agentBusy: true }, 'idle', AUTO_RESTART_IDLE_MS + 1)).toBe(
      false
    );
    expect(gate.evaluate(ready, 'idle', AUTO_RESTART_IDLE_MS + 2)).toBe(false);
    expect(gate.evaluate(ready, 'idle', AUTO_RESTART_IDLE_MS + 2 + AUTO_RESTART_IDLE_MS)).toBe(
      true
    );
    const waiting = new IdleRestartGate();
    expect(waiting.evaluate(ready, 'idle', 10)).toBe(false);
    expect(waiting.delayUntilReadyMs(10)).toBe(AUTO_RESTART_IDLE_MS);
    expect(waiting.delayUntilReadyMs(10 + 1_000)).toBe(AUTO_RESTART_IDLE_MS - 1_000);
  });

  it('失败后不再自动重试', () => {
    const gate = new IdleRestartGate();
    expect(gate.evaluate(ready, 'idle', 0)).toBe(false);
    expect(gate.evaluate(ready, 'idle', AUTO_RESTART_IDLE_MS)).toBe(true);
    gate.markFailed();
    expect(gate.evaluate(ready, 'idle', AUTO_RESTART_IDLE_MS * 3)).toBe(false);
    expect(gate.delayUntilReadyMs(AUTO_RESTART_IDLE_MS * 3)).toBeNull();
    gate.reset();
    expect(gate.evaluate(ready, 'idle', AUTO_RESTART_IDLE_MS * 4)).toBe(false);
    expect(gate.evaluate(ready, 'idle', AUTO_RESTART_IDLE_MS * 5)).toBe(true);
  });

  it('不等空闲：不等满 5 分钟；前台有输入时先等，输入停了再放行', () => {
    const gate = new IdleRestartGate();
    expect(gate.evaluate({ ...ready, agentBusy: true, windowFocused: true }, 'immediate', 0)).toBe(
      true
    );
    expect(gate.evaluate({ ...ready, userActive: true }, 'immediate', 1)).toBe(false);
    expect(gate.delayUntilReadyMs(1)).toBeNull();
    expect(gate.evaluate(ready, 'immediate', 2)).toBe(true);
    expect(gate.evaluate(ready, 'off', 3)).toBe(false);
  });
});
