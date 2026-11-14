import type { SessionStatusPayload } from '@shared/extensionPlugins/events';
import { parseProfile } from '@shared/secretary/parse';
import type { RendererAgentEvent } from '@shared/types/agent';
import type {
  PendingDispatch,
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProposal,
  SecretarySchedule,
  SecretaryTodo,
} from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { createSecretaryHost, type SecretaryHost, type SecretaryHostPorts } from './host';

const MINUTE = 60_000;
const idle = { state: 'idle' as const, pendingAsks: 0, pendingApprovals: 0 };
const running = { state: 'running' as const, pendingAsks: 0, pendingApprovals: 0 };
const waiting = { state: 'waiting' as const, pendingAsks: 1, pendingApprovals: 0 };
const error = { state: 'error' as const, pendingAsks: 0, pendingApprovals: 0 };

function emptyFile(extra: Partial<SecretaryDispatchFile> = {}): SecretaryDispatchFile {
  return {
    version: 1,
    dispatched: {
      c1: {
        conversationId: 'c1',
        projectId: 'p1',
        secretaryConversationId: 'sec1',
        createdAt: 0,
        turn: 0,
        lastState: 'running',
        lastEventAt: 0,
      },
    },
    named: [],
    proposals: {},
    outbox: [],
    ...extra,
  };
}

interface Harness {
  ports: SecretaryHostPorts;
  host: SecretaryHost;
  state: {
    file: SecretaryDispatchFile;
    rows: Record<string, Record<string, unknown>>;
    statuses: Record<
      string,
      {
        state: 'running' | 'idle' | 'waiting' | 'error';
        pendingAsks: number;
        pendingApprovals: number;
      }
    >;
    enabled: boolean;
    patrolEnabled: boolean;
    notify: 'needs-user' | 'with-done' | 'off';
    schedules: SecretarySchedule[];
    todos: SecretaryTodo[];
    briefAt?: string;
    now: number;
    notifications: { title: string; body: string }[];
    published: number;
    prompts: string[];
    audit: SecretaryAuditEntry[];
  };
}

function harness(
  options: {
    file?: Partial<SecretaryDispatchFile>;
    enabled?: boolean;
    patrolEnabled?: boolean;
    notify?: Harness['state']['notify'];
  } = {}
): Harness {
  const state: Harness['state'] = {
    file: emptyFile(options.file),
    rows: { c1: { id: 'c1', title: '派出会话', projectId: 'p1', sessionFile: '/tmp/c1.jsonl' } },
    statuses: { c1: running },
    enabled: options.enabled ?? true,
    patrolEnabled: options.patrolEnabled ?? true,
    notify: options.notify ?? 'needs-user',
    schedules: [],
    todos: [],
    now: 0,
    notifications: [],
    published: 0,
    prompts: [],
    audit: [],
  };
  let seq = 0;
  const ports: SecretaryHostPorts = {
    enabled: () => state.enabled,
    file: () => structuredClone(state.file),
    save: (file) => {
      state.file = structuredClone(file);
    },
    rows: () => structuredClone(state.rows),
    conversations: () => [],
    projects: () => [],
    status: (id) => state.statuses[id] ?? idle,
    alive: () => true,
    prompt: (id, text) => {
      state.prompts.push(`${id}:${text}`);
      return { ok: true };
    },
    resume: async () => ({ ok: true }),
    profile: () => {
      const base = parseProfile({});
      if (!base) throw new Error('default profile');
      return {
        ...base,
        patrolEnabled: state.patrolEnabled,
        notify: state.notify,
        ...(state.briefAt ? { dailyBriefAt: state.briefAt } : {}),
      };
    },
    todos: () => structuredClone(state.todos),
    saveTodos: (todos) => {
      state.todos = structuredClone(todos);
    },
    schedules: () => structuredClone(state.schedules),
    saveSchedules: (schedules) => {
      state.schedules = structuredClone(schedules);
    },
    notify: (build) => {
      state.notifications.push(build('zh'));
    },
    publish: () => {
      state.published += 1;
    },
    now: () => state.now,
    newId: () => `id-${++seq}`,
    audit: (entry) => {
      state.audit.push(entry);
    },
  };
  return { ports, host: createSecretaryHost(ports), state };
}

const identity = { sessionId: 'c1', generation: 'g1' };

function event(type: string, extra: Record<string, unknown> = {}): RendererAgentEvent {
  return { type, identity, seq: 1, turnId: 't1', ...extra } as unknown as RendererAgentEvent;
}

function change(
  state: SessionStatusPayload['state'],
  previous: SessionStatusPayload['previous'],
  extra: Partial<SessionStatusPayload> = {}
): SessionStatusPayload[] {
  return [{ sessionId: 'c1', state, previous, pendingAsks: 0, pendingApprovals: 0, ...extra }];
}

describe('派出会话的结果记录', () => {
  it('无目标的会话轮次结束记一条 turn-ended 并更新状态', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(
      event('turn-completed', {
        digest: { firstUserText: '', userText: '', assistantText: '做完了' },
      }),
      change('idle', 'running')
    );
    expect(h.state.file.dispatched.c1).toMatchObject({
      turn: 1,
      lastState: 'idle',
      lastResult: { kind: 'turn-ended', turn: 1 },
    });
    expect(h.state.file.outbox).toHaveLength(1);
    expect(h.state.file.outbox[0]).toMatchObject({
      kind: 'turn-ended',
      conversationId: 'c1',
      secretaryConversationId: 'sec1',
      lastText: '做完了',
    });
    expect(h.state.published).toBe(1);
  });

  it('带目标的会话轮次结束不报 turn-ended', () => {
    const h = harness({});
    h.state.rows.c1 = { ...h.state.rows.c1, goal: { text: 'g', status: 'active' } };
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.file.dispatched.c1).toMatchObject({ turn: 1, lastState: 'idle' });
    expect(h.state.file.activity).toEqual([
      expect.objectContaining({ conversationId: 'c1', kind: 'turn-ended' }),
    ]);
  });

  it('普通会话的 turn-ended 先攒着，needs-user 和 failed 不推迟', () => {
    const held = harness({});
    held.state.statuses.c1 = idle;
    held.host.onAgentEvent(
      event('turn-completed', { digest: { assistantText: '先这样' } }),
      change('idle', 'running')
    );
    expect(held.state.file.outbox[0]).toMatchObject({ kind: 'turn-ended', deliverAt: 45_000 });
    expect(held.state.prompts).toEqual([]);

    const urgent = harness({});
    urgent.host.onAgentEvent(event('ask-request'), change('waiting', 'running'));
    expect(urgent.state.file.outbox[0]).toMatchObject({ kind: 'needs-user' });
    expect(urgent.state.file.outbox[0]?.deliverAt).toBeUndefined();
  });

  it('同一会话短时间内的更新合并成最新一条，并记下被合并的那条', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    h.state.statuses.c1 = error;
    h.host.onAgentEvent(event('turn-failed', { error: 'boom' }), change('error', 'idle'));
    expect(h.state.file.outbox).toHaveLength(1);
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'failed' });
    expect(h.state.file.activity?.map((entry) => entry.kind)).toEqual(['turn-ended', 'failed']);
    expect(h.state.audit).toEqual([
      expect.objectContaining({
        op: 'update_coalesced',
        targetId: 'c1',
        detail: 'turn-ended -> failed',
      }),
    ]);
  });

  it('静默标记只收系统回传：动态记已查看，用户自己的消息不当静默', () => {
    const h = harness({});
    const digest = {
      firstUserText: '',
      userText: '<session-updates>\n- [turn-ended session:c1] 结束了\n</session-updates>',
      assistantText: '<secretary-silent/>',
    };
    const silent = {
      type: 'turn-completed',
      identity: { sessionId: 'sec1', generation: 'g' },
      seq: 1,
      turnId: 't',
      digest,
    };
    h.host.onAgentEvent(silent as unknown as RendererAgentEvent, []);
    expect(h.state.file.activity).toEqual([
      expect.objectContaining({ conversationId: 'c1', kind: 'seen', text: '秘书已查看' }),
    ]);
    expect(h.state.audit[0]).toMatchObject({ op: 'update_silent' });

    const spoken = harness({});
    spoken.host.onAgentEvent(
      { ...silent, digest: { ...digest, userText: '帮我看看' } } as unknown as RendererAgentEvent,
      []
    );
    expect(spoken.state.file.activity ?? []).toEqual([]);
    expect(spoken.state.audit).toEqual([]);
  });

  it('接管来的会话与派出会话一样回传结束、需要用户与失败', () => {
    const takenOver = (): Partial<SecretaryDispatchFile> => ({
      dispatched: {
        c1: {
          conversationId: 'c1',
          projectId: 'p1',
          secretaryConversationId: 'sec1',
          createdAt: 0,
          turn: 0,
          lastState: 'running',
          lastEventAt: 0,
          takeover: { grantedAt: 0, via: 'user' },
        },
      },
    });
    const ended = harness({ file: takenOver() });
    ended.state.statuses.c1 = idle;
    ended.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(ended.state.file.outbox[0]).toMatchObject({
      kind: 'turn-ended',
      conversationId: 'c1',
      secretaryConversationId: 'sec1',
    });

    const asking = harness({ file: takenOver() });
    asking.state.statuses.c1 = waiting;
    asking.host.onAgentEvent(event('ask-request'), change('waiting', 'running'));
    expect(asking.state.file.outbox[0]).toMatchObject({ kind: 'needs-user' });

    const failed = harness({ file: takenOver() });
    failed.state.statuses.c1 = error;
    failed.host.onAgentEvent(event('turn-failed', { error: 'boom' }), change('error', 'running'));
    expect(failed.state.file.outbox[0]).toMatchObject({ kind: 'failed' });
    expect(failed.state.file.dispatched.c1.takeover).toEqual({ grantedAt: 0, via: 'user' });
  });

  it('只有 goal_blocked 记受阻；goal_complete 等轮次结束后才记完成', () => {
    const done = harness({});
    done.state.statuses.c1 = idle;
    done.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    expect(done.state.file.outbox).toEqual([]);
    done.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(done.state.file.outbox[0]).toMatchObject({ kind: 'goal-complete' });

    const blocked = harness({});
    blocked.host.onAgentEvent(event('goal-signal', { kind: 'blocked', note: '缺凭据' }), []);
    expect(blocked.state.file.outbox[0]).toMatchObject({ kind: 'goal-blocked' });

    const paused = harness({});
    paused.state.rows.c1 = { ...paused.state.rows.c1, goal: { text: 'g', status: 'paused' } };
    paused.state.statuses.c1 = idle;
    paused.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(paused.state.file.outbox).toEqual([]);
  });

  it('目标完成后同一轮结束只留完成，不再补一条 turn-ended', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['goal-complete']);

    // 下一轮再结束就是新结果：未投递的同会话回传只留最新一条
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['turn-ended']);
  });

  it('状态起始时间只在状态变化时更新，流式事件不刷新', () => {
    const h = harness({
      file: { dispatched: { c1: { ...emptyFile().dispatched.c1, stateSince: 0 } } },
    });
    const since = () => h.state.file.dispatched.c1.stateSince;
    h.state.now = 1000;
    h.host.onAgentEvent(event('message-delta', { delta: '写' }), []);
    expect(since()).toBe(0);
    expect(h.state.file.dispatched.c1.lastEventAt).toBe(1000);

    h.state.now = 2000;
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(since()).toBe(2000);

    h.state.now = 3000;
    h.state.statuses.c1 = running;
    h.host.onAgentEvent(event('message-delta', { delta: '再' }), change('running', 'idle'));
    h.state.now = 4000;
    h.host.onAgentEvent(event('message-delta', { delta: '来' }), []);
    expect(since()).toBe(3000);
  });

  it('带目标的派出会话目标撤下后再跑一轮，报新轮次的 turn-ended', () => {
    const h = harness({});
    h.state.file.dispatched.c1.goal = '收尾';
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({
      kind: 'goal-complete',
      turn: 1,
    });
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1).toMatchObject({
      turn: 2,
      lastResult: { kind: 'turn-ended', turn: 2 },
    });
  });

  it('空闲的会话碰上 worker 退出不算失败', () => {
    const h = harness({});
    h.state.file.dispatched.c1.lastState = 'idle';
    h.state.statuses.c1 = error;
    h.host.onAgentEvent({ type: 'worker-exited' } as RendererAgentEvent, change('error', 'idle'));
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
  });

  it('新结果整体替换旧结果，清掉的标记随之失效', () => {
    const h = harness({});
    h.state.file.dispatched.c1.lastResult = { kind: 'failed', turn: 1, at: 5, dismissed: true };
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toEqual({ kind: 'turn-ended', turn: 1, at: 0 });
  });

  it('worker 退出记失败', () => {
    const h = harness({});
    h.state.statuses.c1 = error;
    h.host.onAgentEvent(
      { type: 'worker-exited' } as RendererAgentEvent,
      change('error', 'running')
    );
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'failed' });
    expect(h.state.file.dispatched.c1).toMatchObject({ lastState: 'error' });
  });

  it('等待审批记需要用户，同一状态不重复记', () => {
    const h = harness({});
    h.state.statuses.c1 = waiting;
    h.host.onAgentEvent(event('ask-request'), change('waiting', 'running'));
    expect(h.state.file.outbox).toHaveLength(1);
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'needs-user' });
    h.host.onAgentEvent(event('approval-request'), change('waiting', 'waiting'));
    expect(h.state.file.outbox).toHaveLength(1);
  });

  it('同一次失败只记一条：status=failed 不抢在 turn-failed 前面再推一次', () => {
    const h = harness({});
    h.state.statuses.c1 = error;
    h.host.onAgentEvent(event('status', { status: 'failed' }), change('error', 'running'));
    expect(h.state.file.outbox).toEqual([]);
    h.host.onAgentEvent(event('turn-failed', { error: 'boom' }), change('error', 'running'));
    expect(h.state.file.outbox).toHaveLength(1);
    h.state.file.outbox = [];
    h.host.onAgentEvent(event('status', { status: 'failed' }), change('error', 'error'));
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'failed', turn: 1 });
  });

  it('goal_wait 等后台任务、goal 续跑都不记需要用户；真有提问时才记', () => {
    const h = harness({});
    h.state.rows.c1 = { ...h.state.rows.c1, goal: { text: 'g', status: 'waiting' } };
    h.host.onAgentEvent(event('goal-signal', { kind: 'wait', note: '等后台测试' }), []);
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(
      event('turn-completed', {
        digest: { firstUserText: '', userText: '', assistantText: '真机验收已在后台运行' },
      }),
      change('idle', 'running')
    );
    // 后台任务完成唤醒新一轮，目标回到 active 后自动续跑
    h.state.rows.c1 = { ...h.state.rows.c1, goal: { text: 'g', status: 'active' } };
    h.state.statuses.c1 = running;
    h.host.onAgentEvent(event('status', { status: 'running' }), change('running', 'idle'));
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();

    h.state.statuses.c1 = waiting;
    h.host.onAgentEvent(event('ask-request'), change('waiting', 'running', { pendingAsks: 1 }));
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['needs-user']);
  });

  it('子代理的事件刷新父会话活动时间，不动父会话的轮次与最后一句', () => {
    const h = harness({});
    h.state.now = 20 * MINUTE;
    h.host.onAgentEvent(
      {
        type: 'turn-completed',
        identity: { sessionId: 'c1::cw-1', generation: 'g2', parent: identity },
        seq: 2,
        turnId: 't2',
        digest: { firstUserText: '', userText: '', assistantText: '子代理说的话' },
      } as unknown as RendererAgentEvent,
      []
    );
    expect(h.state.file.dispatched.c1).toMatchObject({ turn: 0, lastEventAt: 20 * MINUTE });
    expect(h.state.file.dispatched.c1.lastText).toBeUndefined();
    expect(h.state.file.outbox).toEqual([]);
    h.host.tick(25 * MINUTE);
    expect(h.state.file.outbox).toEqual([]);
  });

  it('开关关闭时不记录、不发通知、不注入', () => {
    const h = harness({ enabled: false });
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.notifications).toEqual([]);
    expect(h.state.prompts).toEqual([]);
    expect(h.state.published).toBe(0);
  });
});

describe('每分钟检查', () => {
  it('运行中十分钟无事件报一次停滞，同一轮不再报', () => {
    const h = harness({});
    h.state.file.dispatched.c1.lastEventAt = 0;
    h.host.tick(10 * MINUTE);
    expect(h.state.file.outbox).toHaveLength(1);
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'stalled' });
    expect(h.state.file.dispatched.c1.stalledTurn).toBe(0);
    h.host.tick(30 * MINUTE);
    expect(h.state.file.outbox).toHaveLength(1);
  });

  it('等待审批的会话不报停滞', () => {
    const h = harness({});
    h.state.statuses.c1 = waiting;
    h.host.tick(30 * MINUTE);
    expect(h.state.file.outbox).toEqual([]);
  });

  it('空闲等后台任务失败时报停滞，同一轮不重复', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.state.file.dispatched.c1.lastState = 'idle';
    h.ports.backgroundStalls = () => [
      { conversationId: 'c1', taskId: 't1', reason: 'undelivered' },
    ];
    h.host.tick(1_000);
    expect(h.state.file.outbox).toHaveLength(1);
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'stalled' });
    expect(h.state.file.outbox[0].text).toContain('后台任务已完成但没有唤醒');
    h.host.tick(30 * MINUTE);
    expect(h.state.file.outbox).toHaveLength(1);
  });

  it('待确认提案超过 24 小时过期并进回传队列', () => {
    const proposal: SecretaryProposal = {
      id: 'prop1',
      secretaryConversationId: 'sec1',
      createdAt: 0,
      updatedAt: 0,
      status: 'pending',
      kind: 'dispatch',
      draft: { projectId: 'p1', prompt: 'do it', worktree: false },
    };
    const h = harness({ file: { proposals: { prop1: proposal } } });
    h.state.statuses.c1 = idle;
    h.host.tick(24 * 60 * MINUTE);
    expect(h.state.file.proposals.prop1.status).toBe('expired');
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'proposal', status: 'expired' });
  });
});

describe('自动巡检', () => {
  const idleWithGoal = (h: Harness) => {
    h.state.statuses.c1 = idle;
    h.state.rows.c1 = { ...h.state.rows.c1, goal: { text: 'g', status: 'active' } };
    h.state.file.dispatched.c1.lastState = 'idle';
  };

  it('空闲超过 20 分钟、目标没完成时推一条 stalled，同一原因不重复', () => {
    const h = harness({});
    idleWithGoal(h);
    h.host.tick(20 * MINUTE + 1);
    const stalled = h.state.file.outbox.filter((update) => update.kind === 'stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].text).toContain('自动巡检');
    expect(h.state.file.dispatched.c1.patrol).toMatchObject({ reason: 'idle-stalled' });
    // 下一次巡检：同一个异常不再推
    h.host.tick(45 * MINUTE);
    expect(h.state.file.outbox.filter((update) => update.kind === 'stalled')).toHaveLength(1);
  });

  it('正常时不推任何东西', () => {
    const h = harness({});
    idleWithGoal(h);
    h.host.tick(5 * MINUTE);
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.notifications).toEqual([]);
  });

  it('会话有了新事件就算恢复，之后再次卡住会重新推', () => {
    const h = harness({});
    idleWithGoal(h);
    h.host.tick(20 * MINUTE + 1);
    expect(h.state.file.dispatched.c1.patrol).toBeDefined();
    // 21 分钟时来了一次事件：下一次巡检把标记清掉，且因为刚动过不报
    h.state.now = 21 * MINUTE;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    h.state.statuses.c1 = idle;
    h.host.tick(36 * MINUTE);
    expect(h.state.file.dispatched.c1.patrol).toBeUndefined();
    expect(h.state.file.outbox.filter((update) => update.kind === 'stalled')).toHaveLength(1);
    // 之后又静了 20 分钟以上：同一种异常按新的一轮重新推一次（同一会话只留最新一条）
    h.host.tick(60 * MINUTE);
    expect(h.state.file.dispatched.c1.patrol).toMatchObject({
      reason: 'idle-stalled',
      turn: 1,
      at: 60 * MINUTE,
    });
    expect(h.state.file.outbox.map((update) => update.key)).toEqual(['c1|stalled|1']);
  });

  it('没有进行中的会话时巡检不跑', () => {
    const h = harness({});
    idleWithGoal(h);
    h.state.file.dispatched.c1.lastResult = { kind: 'goal-complete', turn: 0, at: 0 };
    h.host.tick(60 * MINUTE);
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.file.dispatched.c1.patrol).toBeUndefined();
  });

  it('设置里关掉巡检后什么都不推', () => {
    const h = harness({});
    idleWithGoal(h);
    h.state.patrolEnabled = false;
    h.host.tick(60 * MINUTE);
    expect(h.state.file.outbox).toEqual([]);
  });

  it('等依赖的派发每轮交给 dispatch 判定，出问题的不再交过去', () => {
    const pending: PendingDispatch = {
      id: 'pend-1',
      projectId: 'p1',
      secretaryConversationId: 'sec1',
      createdAt: 0,
      updatedAt: 0,
      status: 'waiting',
      after: ['c1'],
      draft: { projectId: 'p1', prompt: '接着改', worktree: false },
    };
    const h = harness({ file: { pending: { 'pend-1': pending } } });
    const started: string[][] = [];
    h.ports.startPending = (ids) => started.push([...ids]);
    h.host.tick(1_000);
    expect(started).toEqual([['pend-1']]);
    h.state.file.pending = { 'pend-1': { ...pending, status: 'failed', problem: 'cancelled' } };
    h.host.tick(2_000);
    expect(started).toEqual([['pend-1']]);
  });
});

describe('启动恢复', () => {
  it('重启时仍在运行的派出会话报中断', () => {
    const h = harness({});
    h.state.now = 5000;
    h.host.recover();
    expect(h.state.file.dispatched.c1).toMatchObject({
      lastState: 'idle',
      stateSince: 5000,
      lastResult: { kind: 'interrupted' },
    });
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'interrupted' });
  });

  it('已经空闲的会话重启后不报中断', () => {
    const h = harness({});
    h.state.file.dispatched.c1.lastState = 'idle';
    h.host.recover();
    expect(h.state.file.outbox).toEqual([]);
  });
});

describe('系统通知', () => {
  it('仅需要你处理时只通知受阻与停滞', () => {
    const h = harness({ notify: 'needs-user' });
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    expect(h.state.notifications).toEqual([]);
    h.host.onAgentEvent(event('goal-signal', { kind: 'blocked', note: 'no creds' }), []);
    expect(h.state.notifications).toHaveLength(1);
  });

  it('含完成时完成也通知，关闭时一律不通知', () => {
    const withDone = harness({ notify: 'with-done' });
    withDone.state.statuses.c1 = idle;
    withDone.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    expect(withDone.state.notifications).toEqual([]);
    withDone.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(withDone.state.notifications).toHaveLength(1);

    const off = harness({ notify: 'off' });
    off.state.statuses.c1 = idle;
    off.host.onAgentEvent(event('goal-signal', { kind: 'blocked', note: 'no creds' }), []);
    expect(off.state.notifications).toEqual([]);
  });
});

describe('投递结算', () => {
  const inflight = {
    deliveryId: 'd1',
    secretaryConversationId: 'sec1',
    keys: ['sec1|turn-ended|0'],
    attempt: 1,
    nextAttemptAt: 0,
  };

  function pending(): Partial<SecretaryDispatchFile> {
    return {
      outbox: [
        {
          key: 'sec1|turn-ended|0',
          at: 0,
          text: 'line',
          kind: 'turn-ended',
          conversationId: 'c1',
          secretaryConversationId: 'sec1',
        },
      ],
      inflight,
    };
  }

  it('秘书这一轮正常结束才清空在途批次', () => {
    const h = harness({ file: pending() });
    h.host.onAgentEvent(
      {
        type: 'turn-completed',
        identity: { sessionId: 'sec1', generation: 'g' },
        seq: 1,
        turnId: 't',
      } as unknown as RendererAgentEvent,
      []
    );
    expect(h.state.file.inflight).toBeUndefined();
    expect(h.state.file.outbox).toEqual([]);
  });

  it('秘书这一轮失败时批次留着重投', () => {
    const h = harness({ file: pending() });
    h.host.onAgentEvent(
      {
        type: 'turn-failed',
        identity: { sessionId: 'sec1', generation: 'g' },
        seq: 1,
        turnId: 't',
        error: 'boom',
      } as unknown as RendererAgentEvent,
      []
    );
    expect(h.state.file.inflight).toMatchObject({ attempt: 2, nextAttemptAt: 30_000 });
    expect(h.state.file.outbox).toHaveLength(1);
  });
});

const localAt = (hour: number, minute = 0): number =>
  new Date(2026, 10, 13, hour, minute, 0, 0).getTime();

function onceSchedule(extra: Partial<SecretarySchedule> = {}): SecretarySchedule {
  return {
    id: 'sch1',
    name: '提醒',
    prompt: '看看进展',
    createdAt: localAt(8),
    at: new Date(localAt(9)).toISOString(),
    ...extra,
  } as SecretarySchedule;
}

function cronSchedule(extra: Partial<SecretarySchedule> = {}): SecretarySchedule {
  return {
    id: 'sch2',
    name: '每日简报',
    prompt: '写简报',
    createdAt: localAt(8),
    cron: '0 9 * * *',
    ...extra,
  } as SecretarySchedule;
}

describe('定时', () => {
  const scheduleUpdates = (h: Harness) =>
    h.state.file.outbox.filter((update) => update.kind === 'schedule');

  it('到点的定时进回传队列，一次性任务随后删除', () => {
    const h = harness({});
    h.state.schedules = [onceSchedule()];
    h.host.tick(localAt(9));
    expect(scheduleUpdates(h)).toHaveLength(1);
    expect(scheduleUpdates(h)[0]).toMatchObject({ scheduleId: 'sch1' });
    expect(h.state.schedules).toEqual([]);
    expect(h.state.published).toBe(1);
  });

  it('开关关闭时不触发定时', () => {
    const h = harness({ enabled: false });
    h.state.schedules = [onceSchedule()];
    h.state.now = localAt(9);
    h.host.tick(localAt(9));
    h.host.recover();
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.schedules).toHaveLength(1);
  });

  it('启动补投错过的一次性任务，cron 只算下一次', () => {
    const h = harness({});
    h.state.schedules = [onceSchedule(), cronSchedule()];
    h.state.now = localAt(10);
    h.host.recover();
    expect(scheduleUpdates(h)).toHaveLength(1);
    expect(scheduleUpdates(h)[0]).toMatchObject({ scheduleId: 'sch1' });
    expect(h.state.schedules).toEqual([
      expect.objectContaining({ id: 'sch2', lastFiredAt: localAt(10) }),
    ]);
  });

  it('启动时只跳过错过的 cron 也推送面板刷新上次运行时间', () => {
    const h = harness({ file: { dispatched: {} } });
    h.state.schedules = [cronSchedule()];
    h.state.now = localAt(10);
    h.host.recover();
    expect(h.state.schedules[0]).toMatchObject({ lastFiredAt: localAt(10) });
    expect(h.state.published).toBe(1);
  });

  it('每分钟重算出新的系统定时也推送面板刷新', () => {
    const h = harness({ file: { dispatched: {} } });
    h.state.briefAt = '09:00';
    h.state.now = localAt(8);
    h.host.tick(localAt(8));
    expect(h.state.schedules).toHaveLength(1);
    expect(h.state.published).toBe(1);
  });

  it('每日简报按档案生成，到点后进队列', () => {
    const h = harness({});
    h.state.briefAt = '09:00';
    h.state.now = localAt(8);
    h.host.tick(localAt(8));
    expect(h.state.schedules).toEqual([
      expect.objectContaining({ id: 'system:daily-brief', cron: '0 9 * * *' }),
    ]);
    h.state.now = localAt(9);
    h.host.tick(localAt(9));
    expect(scheduleUpdates(h)).toHaveLength(1);
  });

  it('待办到期时进回传队列，提醒不会在到点前被重算删掉', () => {
    const h = harness({});
    h.state.todos = [
      { id: 'td1', text: '交周报', createdAt: 0, updatedAt: 0, dueAt: localAt(9) + 30_000 },
    ];
    h.state.now = localAt(9);
    h.host.tick(localAt(9));
    expect(h.state.schedules).toHaveLength(1);
    h.state.now = localAt(9) + 60_000;
    h.host.tick(localAt(9) + 60_000);
    expect(scheduleUpdates(h)).toEqual([
      expect.objectContaining({ scheduleId: 'system:todo:td1' }),
    ]);
    h.host.tick(localAt(9) + 120_000);
    expect(scheduleUpdates(h)).toHaveLength(1);
  });

  it('目标完成且会话结束后待办自动打勾，还在跑时不打', () => {
    const h = harness({});
    h.state.file.dispatched.c1.todoId = 'td1';
    h.state.todos = [
      { id: 'td1', text: '看构建', createdAt: 0, updatedAt: 0, conversationId: 'c1' },
    ];
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    expect(h.state.todos[0].doneAt).toBeUndefined();
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.todos[0].doneAt).toBe(0);
  });

  it('会话失败、被中断或删除时待办离开进行中', () => {
    const failed = harness({});
    failed.state.todos = [
      { id: 'td1', text: '看构建', createdAt: 0, updatedAt: 0, conversationId: 'c1' },
    ];
    failed.state.statuses.c1 = error;
    failed.host.onAgentEvent(event('turn-failed', { error: 'boom' }), change('error', 'running'));
    expect(failed.state.todos[0].problem).toBe('failed');

    const stopped = harness({});
    stopped.state.todos = [
      { id: 'td1', text: '看构建', createdAt: 0, updatedAt: 0, conversationId: 'c1' },
    ];
    stopped.state.statuses.c1 = idle;
    stopped.host.onAgentEvent(
      event('turn-completed', { aborted: true }),
      change('idle', 'running')
    );
    expect(stopped.state.todos[0].problem).toBe('stopped');

    const gone = harness({});
    gone.state.todos = [
      { id: 'td1', text: '看构建', createdAt: 0, updatedAt: 0, conversationId: 'c1' },
    ];
    delete gone.state.rows.c1;
    gone.host.tick(1_000);
    expect(gone.state.todos[0].problem).toBe('deleted');
  });

  it('后台任务还在时记在派发记录上，清空后抹掉', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(
      event('background-tasks-level', {
        tasks: [{ taskId: 't', command: 'sleep 30', status: 'running', tail: '', startedAt: 0 }],
      }),
      []
    );
    expect(h.state.file.dispatched.c1.backgroundRunning).toBe(true);
    h.host.onAgentEvent(
      event('background-tasks-level', {
        tasks: [{ taskId: 't', command: 'sleep 30', status: 'done', tail: '', startedAt: 0 }],
      }),
      []
    );
    expect(h.state.file.dispatched.c1.backgroundRunning).toBeUndefined();
  });

  it('实时状态和派发记录不一致时，下一分钟对齐', () => {
    const h = harness({});
    h.state.file.dispatched.c1.lastState = 'idle';
    h.state.statuses.c1 = running;
    h.host.tick(1_000);
    expect(h.state.file.dispatched.c1.lastState).toBe('running');
  });

  it('目标完成收口后，残留的后台任务记录一并清掉', () => {
    const h = harness({});
    h.state.file.dispatched.c1.backgroundRunning = true;
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult?.kind).toBe('goal-complete');
    expect(h.state.file.dispatched.c1.backgroundRunning).toBeUndefined();
  });

  it('会话报错后，残留的后台任务记录一并清掉', () => {
    const h = harness({});
    h.state.file.dispatched.c1.backgroundRunning = true;
    h.state.statuses.c1 = error;
    h.host.onAgentEvent(event('turn-failed', { error: 'boom' }), change('error', 'running'));
    expect(h.state.file.dispatched.c1.backgroundRunning).toBeUndefined();
  });
});
