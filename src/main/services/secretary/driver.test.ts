import { BACKGROUND_WAKE_GRACE_MS } from '@shared/backgroundWatch';
import type { ConversationsPatch } from '@shared/conversationsPatch';
import type { HeadlessDelivery, HeadlessSessionRuntime } from '@shared/pair/headlessQueue';
import type { RendererAgentEvent } from '@shared/types/agent';
import type { SecretaryAuditEntry } from '@shared/types/secretary';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDispatchDriver, type DispatchDriverPorts } from './driver';

const SID = 'dispatch-1';

interface Harness {
  rows: Record<string, Record<string, unknown>>;
  statuses: Record<string, { state: string; pendingAsks: number; pendingApprovals: number }>;
  alive: Record<string, boolean>;
  prompts: { conversationId: string; delivery: HeadlessDelivery; deliveryId: string }[];
  audits: SecretaryAuditEntry[];
  driver: ReturnType<typeof createDispatchDriver>;
  promptOk: { value: boolean };
}

function harness(row: Record<string, unknown> = {}): Harness {
  return harnessAt(row);
}

function harnessAt(row: Record<string, unknown> = {}, clock?: { now: number }): Harness {
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
  const audits: SecretaryAuditEntry[] = [];
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
    audit: (entry) => audits.push(entry),
    now: () => clock?.now ?? Date.now(),
  };
  return { rows, statuses, alive, prompts, audits, driver: createDispatchDriver(ports), promptOk };
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

  it('后台任务还在跑时不续跑，任务结束后的下一轮才续跑', () => {
    h.driver.observe({
      type: 'task-started',
      identity,
      seq: 1,
      task: { taskId: 't1', command: 'sleep 20', status: 'running', tail: '', startedAt: 1 },
    } as unknown as RendererAgentEvent);
    h.driver.observe(turnCompleted(digest('等验收跑完')));
    expect(h.prompts).toHaveLength(0);
    expect(goalOf(h)).toMatchObject({ status: 'active', autoTurns: 0 });

    h.driver.observe({
      type: 'task-ended',
      identity,
      seq: 2,
      taskId: 't1',
      status: 'done',
      exitCode: 0,
    } as unknown as RendererAgentEvent);
    h.driver.observe(turnCompleted(digest('验收结束')));
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].delivery.text).toContain('<goal-continuation>');
  });

  it('行上已经在跑的后台任务同样挡住续跑', () => {
    const waiting = harness({
      backgroundTasks: [
        { taskId: 't1', command: 'sleep 20', status: 'running', tail: '', startedAt: 1 },
      ],
    });
    waiting.driver.observe(turnCompleted(digest('等通知')));
    expect(waiting.prompts).toHaveLength(0);
  });

  it('同一轮空闲只续跑一次，压缩结束不再投第二遍', () => {
    h.driver.observe(turnCompleted(digest('step one')));
    expect(h.prompts).toHaveLength(1);
    h.driver.observe({
      type: 'compaction',
      identity,
      seq: 2,
      state: 'end',
    } as unknown as RendererAgentEvent);
    expect(h.prompts).toHaveLength(1);
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

describe('派出会话的后台任务看门狗', () => {
  const clock = { now: 1_000 };

  function started(task: Record<string, unknown>, at = clock.now): RendererAgentEvent {
    clock.now = at;
    return {
      type: 'task-started',
      identity,
      seq: 1,
      task: {
        taskId: 't1',
        command: 'sleep 30',
        status: 'running',
        tail: '',
        startedAt: at,
        ...task,
      },
    } as unknown as RendererAgentEvent;
  }

  function ended(status: 'done' | 'failed', at: number): RendererAgentEvent {
    clock.now = at;
    return {
      type: 'task-ended',
      identity,
      seq: 2,
      taskId: 't1',
      status,
    } as unknown as RendererAgentEvent;
  }

  function level(tasks: Record<string, unknown>[], at: number): RendererAgentEvent {
    clock.now = at;
    return {
      type: 'background-tasks-level',
      identity,
      seq: 3,
      tasks,
    } as unknown as RendererAgentEvent;
  }

  function task(
    taskId: string,
    status: 'running' | 'done' | 'failed',
    startedAt: number,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return { taskId, command: 'sleep 30', status, tail: '', startedAt, ...extra };
  }

  it('还在跑且未到截止时间时不唤醒', () => {
    const h = harnessAt({}, clock);
    h.driver.observe(started({ deadlineAt: 60_000 }));
    h.driver.observe(turnCompleted(digest('等着')));
    expect(h.prompts).toHaveLength(0);
    expect(h.driver.watch(30_000)).toEqual([]);
    expect(h.prompts).toHaveLength(0);
  });

  it('超时先告诉秘书，宽限过后会话仍空闲才唤醒，且不重复报', () => {
    const h = harnessAt({}, clock);
    h.driver.observe(started({ deadlineAt: 5_000 }, 1_000));
    h.driver.observe(turnCompleted(digest('等着')));
    expect(h.driver.watch(5_000)).toEqual([
      { conversationId: SID, taskId: 't1', reason: 'timeout' },
    ]);
    expect(h.prompts).toHaveLength(0);
    expect(h.driver.watch(5_000 + BACKGROUND_WAKE_GRACE_MS)).toEqual([]);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].delivery.text).toContain('t1');
    expect(h.prompts[0].delivery.text).toContain('timeout');
    expect(h.prompts[0].delivery.text).toContain('<background-task-watchdog>');
  });

  it('进程已死时同样报停滞并在宽限后唤醒', () => {
    const h = harnessAt({}, clock);
    h.driver.observe(started({}, 1_000));
    h.driver.observe(turnCompleted(digest('等着')));
    clock.now = 4_000;
    h.driver.observe({
      type: 'background-tasks-level',
      identity,
      seq: 3,
      tasks: [
        {
          taskId: 't1',
          command: 'sleep 30',
          status: 'running',
          tail: '',
          startedAt: 1_000,
          alive: false,
        },
      ],
    } as unknown as RendererAgentEvent);
    expect(h.driver.watch(4_000)).toEqual([{ conversationId: SID, taskId: 't1', reason: 'dead' }]);
    expect(h.driver.watch(4_000 + BACKGROUND_WAKE_GRACE_MS)).toEqual([]);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].delivery.text).toContain('process is gone');
  });

  it('alive 为 null（还没探测）时不报进程已死', () => {
    const h = harnessAt({}, clock);
    h.driver.observe(started({}, 1_000));
    h.driver.observe(turnCompleted(digest('等着')));
    h.driver.observe(level([task('t1', 'running', 1_000, { alive: null })], 4_000));
    expect(h.driver.watch(4_000 + BACKGROUND_WAKE_GRACE_MS)).toEqual([]);
    expect(h.prompts).toHaveLength(0);
  });

  it('还有任务在跑时，不拿已经死掉的旧任务报停住', () => {
    // 真实误报：会话等 task-33（running，alive 未探测），旧任务 task-28 的进程早就没了
    const h = harnessAt({}, clock);
    h.driver.observe(started({ taskId: 'task-28' }, 1_000));
    h.driver.observe(started({ taskId: 'task-33' }, 2_000));
    h.driver.observe(turnCompleted(digest('等 verify-secretary')));
    h.driver.observe(
      level(
        [
          task('task-33', 'running', 2_000, { alive: null }),
          task('task-28', 'failed', 1_000, { alive: false }),
        ],
        158_000
      )
    );
    expect(h.driver.watch(158_000 + BACKGROUND_WAKE_GRACE_MS)).toEqual([]);
    expect(h.prompts).toHaveLength(0);
  });

  it('任务全部退出后才报没唤醒', () => {
    const h = harnessAt({}, clock);
    h.driver.observe(started({ taskId: 'a' }, 1_000));
    h.driver.observe(started({ taskId: 'b' }, 1_000));
    h.driver.observe(turnCompleted(digest('等两个')));
    h.driver.observe(
      level(
        [task('a', 'done', 1_000, { exitCode: 0 }), task('b', 'failed', 1_000, { alive: false })],
        5_000
      )
    );
    expect(h.driver.watch(5_000)).toEqual([]);
    expect(h.driver.watch(5_000 + BACKGROUND_WAKE_GRACE_MS)).toEqual([
      { conversationId: SID, taskId: 'a', reason: 'undelivered' },
    ]);
  });

  it('任务结束后仍空闲，过了宽限才当没唤醒；期间会话跑起来就不报', () => {
    const h = harnessAt({}, clock);
    h.driver.observe(started({}, 1_000));
    h.driver.observe(turnCompleted(digest('等通知')));
    h.driver.observe(ended('done', 2_000));
    expect(h.driver.watch(2_000)).toEqual([]);
    expect(h.prompts).toHaveLength(0);
    expect(h.driver.watch(2_000 + BACKGROUND_WAKE_GRACE_MS)).toEqual([
      { conversationId: SID, taskId: 't1', reason: 'undelivered' },
    ]);
    expect(h.prompts).toHaveLength(1);

    const woke = harnessAt({}, clock);
    woke.driver.observe(started({}, 1_000));
    woke.driver.observe(turnCompleted(digest('等通知')));
    woke.driver.observe(ended('done', 2_000));
    woke.statuses[SID].state = 'running';
    expect(woke.driver.watch(2_000 + BACKGROUND_WAKE_GRACE_MS)).toEqual([]);
    expect(woke.prompts).toHaveLength(0);
  });

  it('还有待审批时不把后台等待报成停滞', () => {
    const h = harnessAt({}, clock);
    h.statuses[SID].pendingApprovals = 1;
    h.driver.observe(started({ deadlineAt: 1_000 }, 1_000));
    h.driver.observe(turnCompleted(digest('等着')));
    expect(h.driver.watch(10_000)).toEqual([]);
    expect(h.prompts).toHaveLength(0);
  });

  it('超时通知已经把会话跑完一轮时仍报停滞，但不再唤醒', () => {
    const h = harnessAt({}, clock);
    h.driver.observe(started({ deadlineAt: 5_000 }, 1_000));
    h.driver.observe(turnCompleted(digest('等着')));
    h.driver.observe(ended('failed', 5_000));
    h.driver.observe(turnCompleted(digest('看到超时了')));
    const before = h.prompts.length;
    expect(h.driver.watch(5_000 + BACKGROUND_WAKE_GRACE_MS)).toEqual([
      { conversationId: SID, taskId: 't1', reason: 'timeout' },
    ]);
    expect(h.prompts).toHaveLength(before);
  });

  it('会话被停止后 forget：看门狗不再报停滞，也不再唤醒', () => {
    const h = harnessAt({}, clock);
    h.driver.observe(started({ deadlineAt: 5_000 }, 1_000));
    h.driver.observe(turnCompleted(digest('等着')));
    h.driver.forget(SID);
    expect(h.driver.watch(5_000 + BACKGROUND_WAKE_GRACE_MS)).toEqual([]);
    expect(h.prompts).toHaveLength(0);
  });

  it('停止后被 forget 的会话，目标暂停后不再续跑', () => {
    const h = harnessAt({}, clock);
    h.driver.observe(turnCompleted(digest('这一轮')));
    expect(h.prompts).toHaveLength(1);
    h.driver.forget(SID);
    // 目标被暂停后，后续任何收束都不会再投续跑
    h.rows[SID].goal = { text: 'ship it', status: 'paused', autoTurns: 1 };
    h.driver.observe(turnCompleted(digest('停了')));
    expect(h.prompts).toHaveLength(1);
  });
});

describe('投递被拒的消息不丢', () => {
  function rejected(deliveryId: string): RendererAgentEvent {
    return {
      type: 'delivery-rejected',
      identity,
      seq: 2,
      deliveryId,
    } as unknown as RendererAgentEvent;
  }

  it('worker 回执拒收：排队的消息放回队首，审计记一条', () => {
    const h = harness({
      queuedMessages: [{ id: 'q1', text: 'queued', origin: 'secretary', by: 'sec-1' }],
    });
    h.driver.observe(turnCompleted(digest('step one')));
    expect(h.prompts).toHaveLength(1);
    expect(h.rows[SID].queuedMessages).toEqual([]);

    h.driver.observe(rejected(h.prompts[0].deliveryId));

    expect(h.rows[SID].queuedMessages).toEqual([
      expect.objectContaining({ text: 'queued', origin: 'secretary', by: 'sec-1' }),
    ]);
    // 排队消息被拒不该连累目标：worker 还在跑，续跑状态照旧
    expect(goalOf(h).status).toBe('active');
    expect(h.audits).toEqual([
      expect.objectContaining({
        op: 'delivery-rejected',
        targetId: SID,
        ok: false,
        secretaryConversationId: 'sec-1',
        detail: 'requeued',
      }),
    ]);
  });

  it('续跑被拒：目标暂停并记审计，不留空转的 active 目标', () => {
    const h = harness();
    h.driver.observe(turnCompleted(digest('step one')));
    expect(h.prompts[0].delivery.text).toContain('<goal-continuation>');

    h.driver.observe(rejected(h.prompts[0].deliveryId));

    expect(goalOf(h)).toMatchObject({ status: 'paused', note: 'delivery rejected' });
    expect(h.audits).toEqual([
      expect.objectContaining({ op: 'delivery-rejected', detail: 'goal-paused' }),
    ]);
  });

  it('已回执送达的投递不再按拒收回退，消息不会投两遍', () => {
    const h = harness({
      queuedMessages: [{ id: 'q1', text: 'queued', origin: 'secretary' }],
    });
    h.driver.observe(turnCompleted(digest('step one')));
    const deliveryId = h.prompts[0].deliveryId;
    h.driver.observe({
      type: 'delivery-settled',
      identity,
      seq: 2,
      deliveryId,
    } as unknown as RendererAgentEvent);

    h.driver.observe(rejected(deliveryId));

    expect(h.rows[SID].queuedMessages).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});
