import type { ConversationsPatch } from '@shared/conversationsPatch';
import type { HeadlessDelivery, HeadlessSessionRuntime } from '@shared/pair/headlessQueue';
import type { RendererAgentEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDispatchDriver, type DispatchDriverPorts } from './driver';

const SID = 'dispatch-1';

interface Harness {
  rows: Record<string, Record<string, unknown>>;
  statuses: Record<string, { state: string; pendingAsks: number; pendingApprovals: number }>;
  alive: Record<string, boolean>;
  prompts: { conversationId: string; delivery: HeadlessDelivery; deliveryId: string }[];
  driver: ReturnType<typeof createDispatchDriver>;
  promptOk: { value: boolean };
}

function harness(row: Record<string, unknown> = {}): Harness {
  const rows: Record<string, Record<string, unknown>> = {
    [SID]: {
      id: SID,
      driver: 'main',
      title: 'Dispatched',
      queuedMessages: [],
      goal: { text: 'ship it', status: 'active', autoTurns: 0, noProgressRuns: 0 },
      ...row,
    },
  };
  const statuses: Harness['statuses'] = {
    [SID]: { state: 'idle', pendingAsks: 0, pendingApprovals: 0 },
  };
  const alive: Record<string, boolean> = { [SID]: true };
  const prompts: Harness['prompts'] = [];
  const promptOk = { value: true };
  let seq = 0;
  const ports: DispatchDriverPorts = {
    row: (id) => rows[id],
    saveRuntime: (id, runtime: HeadlessSessionRuntime) => {
      rows[id] = {
        ...rows[id],
        queuedMessages: runtime.queued,
        ...(runtime.goal ? { goal: runtime.goal } : { goal: undefined }),
      };
    },
    status: (id) => statuses[id] ?? { state: 'idle', pendingAsks: 0, pendingApprovals: 0 },
    alive: (id) => alive[id] === true,
    prompt: (conversationId, delivery, deliveryId) => {
      prompts.push({ conversationId, delivery, deliveryId });
      return promptOk.value ? { ok: true } : { ok: false, error: 'stale session' };
    },
    newId: () => `id-${++seq}`,
  };
  return { rows, statuses, alive, prompts, driver: createDispatchDriver(ports), promptOk };
}

const identity = { sessionId: SID, generation: 'g1' };

function turnCompleted(extra: Record<string, unknown> = {}): RendererAgentEvent {
  return {
    type: 'turn-completed',
    identity,
    seq: 1,
    turnId: 't1',
    ...extra,
  } as unknown as RendererAgentEvent;
}

function digest(assistantText: string): Record<string, unknown> {
  return { digest: { firstUserText: '', userText: '', assistantText } };
}

function goalSignal(kind: 'complete' | 'blocked' | 'wait', note: string): RendererAgentEvent {
  return { type: 'goal-signal', identity, seq: 1, kind, note } as unknown as RendererAgentEvent;
}

function mergedQueued(text: string): ConversationsPatch {
  return {
    upserts: {
      [SID]: { set: { queuedMessages: [{ id: 'q1', text }] }, unset: [] },
    },
    removes: [],
  };
}

function goalOf(h: Harness): Record<string, unknown> {
  return h.rows[SID].goal as Record<string, unknown>;
}

describe('派出会话的目标续跑', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('轮次结束续跑一轮，目标完成后不再续跑', () => {
    h.driver.observe(turnCompleted(digest('step one')));
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].delivery.text).toContain('<goal-continuation>');
    expect(h.prompts[0].delivery.text).toContain('ship it');
    expect(goalOf(h)).toMatchObject({ status: 'active', autoTurns: 1, noProgressRuns: 0 });

    h.driver.observe(goalSignal('complete', 'shipped'));
    // 与桌面会话一致：完成即撤下目标，界面不留一条「已完成」
    expect(goalOf(h)).toBeUndefined();

    h.driver.observe(turnCompleted(digest('step two')));
    expect(h.prompts).toHaveLength(1);
  });

  it('受阻与等待都不再续跑', () => {
    h.driver.observe(goalSignal('blocked', 'needs credentials'));
    h.driver.observe(turnCompleted(digest('blocked')));
    expect(goalOf(h)).toMatchObject({ status: 'blocked' });
    expect(h.prompts).toHaveLength(0);

    const waiting = harness({ goal: { text: 'ship it', status: 'waiting', autoTurns: 0 } });
    waiting.driver.observe(turnCompleted(digest('waiting')));
    expect(waiting.prompts).toHaveLength(0);
  });

  it('到 25 轮自动暂停', () => {
    h.rows[SID].goal = { text: 'ship it', status: 'active', autoTurns: 25, noProgressRuns: 0 };
    h.driver.observe(turnCompleted(digest('step')));
    expect(h.prompts).toHaveLength(0);
    expect(goalOf(h)).toMatchObject({ status: 'paused' });
    expect(String(goalOf(h).note)).toContain('25');
  });

  it('连续 3 次无进展暂停，有进展则清零', () => {
    h.rows[SID].goal = {
      text: 'ship it',
      status: 'active',
      autoTurns: 2,
      noProgressRuns: 2,
      lastOutput: 'same output',
    };
    h.driver.observe(turnCompleted(digest('Same   output')));
    expect(h.prompts).toHaveLength(0);
    expect(goalOf(h)).toMatchObject({ status: 'paused', noProgressRuns: 3 });

    const progressing = harness({
      goal: {
        text: 'ship it',
        status: 'active',
        autoTurns: 2,
        noProgressRuns: 2,
        lastOutput: 'same output',
      },
    });
    progressing.driver.observe(turnCompleted(digest('different output')));
    expect(progressing.prompts).toHaveLength(1);
    expect(goalOf(progressing)).toMatchObject({
      noProgressRuns: 0,
      lastOutput: 'different output',
    });
  });

  it('中断的轮不续跑也不泵队列', () => {
    h.rows[SID].queuedMessages = [{ id: 'q1', text: 'queued' }];
    h.driver.observe(turnCompleted({ aborted: true }));
    expect(h.prompts).toHaveLength(0);
    expect(h.rows[SID].queuedMessages).toHaveLength(1);
  });

  it('有待审批或提问时不续跑', () => {
    h.statuses[SID].pendingApprovals = 1;
    h.driver.observe(turnCompleted(digest('step')));
    expect(h.prompts).toHaveLength(0);

    h.statuses[SID].pendingApprovals = 0;
    h.statuses[SID].pendingAsks = 1;
    h.driver.observe(turnCompleted(digest('step')));
    expect(h.prompts).toHaveLength(0);
  });

  it('非 Main 驱动的行不参与', () => {
    const other = harness({ driver: undefined });
    other.driver.observe(turnCompleted(digest('step')));
    expect(other.prompts).toHaveLength(0);
  });
});

describe('派出会话的排队消息', () => {
  it('排队消息先于续跑投递，且不消耗目标轮数', () => {
    const h = harness({ queuedMessages: [{ id: 'q1', text: 'do this first' }] });
    h.driver.observe(turnCompleted(digest('step')));
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].delivery.text).toBe('do this first');
    expect(h.rows[SID].queuedMessages).toEqual([]);
    expect(goalOf(h)).toMatchObject({ autoTurns: 0 });
  });

  it('合并写回带来排队消息时，等写回落盘后投递一次并清掉队列', async () => {
    const h = harness();
    const patch = mergedQueued('from the desktop');
    // 与 SETTINGS_WRITE_KEY 同序：先通知，写回方随后才把合并值落盘
    h.driver.onConversationsMerged(patch);
    h.rows[SID] = { ...h.rows[SID], ...patch.upserts[SID].set };
    await Promise.resolve();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].delivery.text).toBe('from the desktop');
    expect(h.rows[SID].queuedMessages).toEqual([]);
  });

  it('运行中的会话不在合并写回时抢投', async () => {
    const h = harness();
    h.statuses[SID].state = 'running';
    h.driver.onConversationsMerged(mergedQueued('later'));
    await Promise.resolve();
    expect(h.prompts).toHaveLength(0);
  });

  it('压缩进行中不投递，压缩结束后补投', () => {
    const h = harness({ queuedMessages: [{ id: 'q1', text: 'after compact' }] });
    h.driver.observe({
      type: 'compaction',
      identity,
      seq: 1,
      state: 'start',
    } as unknown as RendererAgentEvent);
    h.driver.observe(turnCompleted(digest('step')));
    expect(h.prompts).toHaveLength(0);

    h.driver.observe({
      type: 'compaction',
      identity,
      seq: 2,
      state: 'end',
    } as unknown as RendererAgentEvent);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].delivery.text).toBe('after compact');
  });

  it('投递失败时排队消息回到队首、目标暂停', () => {
    const h = harness({ queuedMessages: [{ id: 'q1', text: 'keep me' }] });
    h.promptOk.value = false;
    h.driver.observe(turnCompleted(digest('step')));
    expect(h.rows[SID].queuedMessages).toMatchObject([{ text: 'keep me' }]);
    expect(goalOf(h)).toMatchObject({ status: 'paused', note: 'stale session' });
  });
});

describe('派出会话的失败轮', () => {
  it('失败轮暂停目标但仍投递排队消息', () => {
    const h = harness({ queuedMessages: [{ id: 'q1', text: 'next' }] });
    h.driver.observe({
      type: 'turn-failed',
      identity,
      seq: 1,
      turnId: 't1',
      error: 'boom',
    } as unknown as RendererAgentEvent);
    expect(h.prompts.map((prompt) => prompt.delivery.text)).toEqual(['next']);
    expect(goalOf(h)).toMatchObject({ status: 'paused', note: 'boom' });
  });
});

describe('界面改目标走 Main', () => {
  it('设目标立即落盘并在空闲时投递 kickoff', () => {
    const h = harness();
    expect(h.driver.goalAction(SID, 'set', 'fix the build').ok).toBe(true);
    expect(goalOf(h)).toMatchObject({ text: 'fix the build', status: 'active' });
    expect(h.prompts[0].delivery.text).toContain('fix the build');
  });

  it('暂停后轮次结束不续跑，恢复后清零安全计数再续跑', () => {
    const h = harness();
    h.driver.goalAction(SID, 'pause');
    expect(goalOf(h)).toMatchObject({ status: 'paused' });
    h.driver.observe(turnCompleted(digest('step')));
    expect(h.prompts).toHaveLength(0);

    h.rows[SID].goal = {
      text: 'ship it',
      status: 'paused',
      autoTurns: 7,
      noProgressRuns: 2,
      lastOutput: 'same',
    };
    h.driver.goalAction(SID, 'resume');
    expect(goalOf(h)).toMatchObject({ status: 'active', autoTurns: 1, noProgressRuns: 0 });
    expect(h.prompts).toHaveLength(1);
  });

  it('清除目标后不再续跑', () => {
    const h = harness();
    h.driver.goalAction(SID, 'clear');
    expect(h.rows[SID].goal).toBeUndefined();
    h.driver.observe(turnCompleted(digest('step')));
    expect(h.prompts).toHaveLength(0);
  });

  it('非 Main 驱动的会话拒绝改目标', () => {
    const h = harness({ driver: undefined });
    expect(h.driver.goalAction(SID, 'pause')).toMatchObject({ ok: false });
  });
});
