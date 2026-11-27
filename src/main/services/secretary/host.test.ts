import type { SessionStatusPayload } from '@shared/extensionPlugins/events';
import { parseProfile } from '@shared/secretary/parse';
import type { RendererAgentEvent } from '@shared/types/agent';
import type {
  DispatchRecord,
  PendingDispatch,
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProposal,
  SecretarySchedule,
  SecretaryTodo,
} from '@shared/types/secretary';
import { describe, expect, it, vi } from 'vitest';
import type { ObservedTask } from '../backgroundTaskTracker';
import { createSecretaryHost, type SecretaryHost, type SecretaryHostPorts } from './host';
import { buildBoard } from './results';

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
    /** 会话的后台任务投影 */
    tasks: Record<string, ObservedTask[]>;
    /** 主会话名下还没回来的子代理 Run */
    subagents: Record<string, boolean>;
    /** 上次应用退出打断这一轮的原因（启动恢复用） */
    interruptDetails: Record<string, string>;
    contact: {
      milestones: { kind: string; title: string; conversationId: string; lastText?: string }[];
      asks: { conversationId: string; requestId: string }[];
      resolved: { conversationId: string; requestId: string }[];
      replies: { conversationId: string; text: string; delivery?: boolean; turnId?: string }[];
      silent: { conversationId: string }[];
      turns: { conversationId: string; kind: 'start' | 'end' }[];
      scheduleFired: { scheduleId: string; text: string }[];
    };
  };
}

function harness(
  options: {
    file?: Partial<SecretaryDispatchFile>;
    enabled?: boolean;
    patrolEnabled?: boolean;
    notify?: Harness['state']['notify'];
    tasks?: Record<string, ObservedTask[]>;
    /** 这些会话 id 算秘书自己的会话：它们的提问与回复要发到手机 */
    secretaryIds?: string[];
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
    tasks: options.tasks ?? {},
    subagents: {},
    interruptDetails: {},
    contact: {
      milestones: [],
      asks: [],
      resolved: [],
      replies: [],
      silent: [],
      turns: [],
      scheduleFired: [],
    },
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
    tasks: (conversationId) => state.tasks[conversationId] ?? [],
    subagentsRunning: (conversationId) => state.subagents[conversationId] === true,
    interruptDetail: (conversationId) => state.interruptDetails[conversationId],
    newId: () => `id-${++seq}`,
    audit: (entry) => {
      state.audit.push(entry);
    },
    contact: {
      onMilestone: (input) => {
        state.contact.milestones.push(input);
      },
      onScheduleFired: (input) => {
        state.contact.scheduleFired.push(input);
      },
      onAskRequest: (conversationId, ask) => {
        state.contact.asks.push({ conversationId, requestId: ask.requestId });
      },
      onAskResolved: (conversationId, requestId) => {
        state.contact.resolved.push({ conversationId, requestId });
      },
      onTurnReply: (conversationId, text, options) => {
        state.contact.replies.push({
          conversationId,
          text,
          ...(options?.delivery ? { delivery: true } : {}),
          ...(options?.turnId ? { turnId: options.turnId } : {}),
        });
      },
      onTurnStart: (conversationId) => {
        state.contact.turns.push({ conversationId, kind: 'start' });
      },
      onTurnEnd: (conversationId) => {
        state.contact.turns.push({ conversationId, kind: 'end' });
      },
      onTurnSilent: (conversationId) => {
        state.contact.silent.push({ conversationId });
      },
    },
    isSecretaryConversation: (conversationId) =>
      (options.secretaryIds ?? []).includes(conversationId),
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

describe('转交给秘书的提问', () => {
  const relayAsk = (extra: Record<string, unknown> = {}) => ({
    ask: {
      requestId: 'ask-1',
      question: '用哪个方案？',
      options: ['A', 'B'],
      recommended: 'A',
      expiresAt: 30 * MINUTE,
      relay: { name: '小秘' },
      ...extra,
    },
  });

  it('派出会话的 ask_user 转给秘书：不报 needs-user，推一条 ask-relay 并落盘', () => {
    const h = harness({});
    h.state.statuses.c1 = waiting;
    h.host.onAgentEvent(event('ask-request', relayAsk()), change('waiting', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.state.file.outbox).toEqual([
      expect.objectContaining({
        kind: 'ask-relay',
        conversationId: 'c1',
        askId: 'ask-1',
        status: 'pending',
      }),
    ]);
    expect(h.state.file.outbox[0]?.text).toContain('用哪个方案？');
    expect(h.state.file.outbox[0]?.lastText).toContain('默认值：A');
    expect(h.state.file.relays?.['c1|ask-1']).toMatchObject({
      status: 'pending',
      question: '用哪个方案？',
      options: ['A', 'B'],
      defaultOption: 'A',
      expiresAt: 30 * MINUTE,
    });
    expect(h.state.audit).toEqual([expect.objectContaining({ op: 'ask_relay', targetId: 'c1' })]);
  });

  it('用户在原会话里先答：记录 user-answered 并回传一条，秘书那边失效', () => {
    const h = harness({});
    h.state.statuses.c1 = waiting;
    h.host.onAgentEvent(event('ask-request', relayAsk()), change('waiting', 'running'));
    h.state.file.outbox = [];
    h.host.onAgentEvent(event('ask-resolved', { requestId: 'ask-1', by: 'user', answer: 'B' }), []);
    expect(h.state.file.relays?.['c1|ask-1']).toMatchObject({
      status: 'user-answered',
      answer: 'B',
    });
    expect(h.state.file.outbox).toEqual([
      expect.objectContaining({ kind: 'ask-relay', status: 'user-answered' }),
    ]);
    expect(h.state.file.outbox[0]?.text).toContain('用户已直接回答：B');
    expect(h.state.audit.at(-1)).toMatchObject({ op: 'ask_relay_closed', targetId: 'c1' });
  });

  it('秘书代答：记录 answered，不再回传一条', () => {
    const h = harness({});
    h.state.statuses.c1 = waiting;
    h.host.onAgentEvent(event('ask-request', relayAsk()), change('waiting', 'running'));
    h.state.file.outbox = [];
    h.host.onAgentEvent(
      event('ask-resolved', { requestId: 'ask-1', by: 'relay', answer: 'A', name: '小秘' }),
      []
    );
    expect(h.state.file.relays?.['c1|ask-1']).toMatchObject({ status: 'answered', answer: 'A' });
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.audit.at(-1)).toMatchObject({ op: 'ask_relay_answer' });
  });

  it('没人答到点：按超时收尾，有默认值时说明按默认值处理', () => {
    const h = harness({});
    h.state.statuses.c1 = waiting;
    h.host.onAgentEvent(event('ask-request', relayAsk()), change('waiting', 'running'));
    h.state.file.outbox = [];
    h.state.now = 30 * MINUTE;
    h.host.tick();
    expect(h.state.file.relays?.['c1|ask-1']).toMatchObject({ status: 'timed-out' });
    expect(h.state.file.outbox).toEqual([
      expect.objectContaining({ kind: 'ask-relay', status: 'timed-out' }),
    ]);
    expect(h.state.file.outbox[0]?.text).toContain('已按默认值「A」处理');
  });

  it('提问、用户直接答与超时收尾都带上派发记录里的发起秘书会话', () => {
    const h = harness({});
    h.state.statuses.c1 = waiting;
    h.host.onAgentEvent(event('ask-request', relayAsk()), change('waiting', 'running'));
    h.host.onAgentEvent(
      event('ask-request', relayAsk({ requestId: 'ask-2' })),
      change('waiting', 'waiting')
    );
    h.host.onAgentEvent(event('ask-resolved', { requestId: 'ask-1', by: 'user', answer: 'B' }), []);
    h.state.now = 30 * MINUTE;
    h.host.tick();
    const relays = h.state.file.outbox.filter((update) => update.kind === 'ask-relay');
    expect(relays.map((update) => [update.key, update.secretaryConversationId])).toEqual([
      ['relay:c1:ask-1:pending', 'sec1'],
      ['relay:c1:ask-2:pending', 'sec1'],
      ['relay:c1:ask-1:user-answered', 'sec1'],
      ['relay:c1:ask-2:timed-out', 'sec1'],
    ]);
  });

  it('普通会话的 ask_user 不受影响：照旧记 needs-user，不建转交记录', () => {
    const h = harness({});
    h.state.statuses.c1 = waiting;
    h.host.onAgentEvent(
      event('ask-request', { ask: { requestId: 'ask-2', question: '继续吗？' } }),
      change('waiting', 'running')
    );
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'needs-user' });
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'needs-user' });
    expect(h.state.file.relays).toBeUndefined();
  });

  it('重启后 worker 已经不在了：挂起的转交记录作废并记审计', () => {
    const h = harness({});
    h.state.statuses.c1 = waiting;
    h.host.onAgentEvent(event('ask-request', relayAsk()), change('waiting', 'running'));
    expect(h.state.file.relays?.['c1|ask-1']).toBeDefined();
    h.host.recover();
    expect(h.state.file.relays).toBeUndefined();
    expect(h.state.audit.at(-1)).toMatchObject({
      op: 'ask_relay_cancel',
      targetId: 'c1',
      detail: 'ask-1 restart',
    });
  });

  it('审批照旧：无人值守的派出会话等审批仍记 needs-user，不进转交', () => {
    const h = harness({});
    h.state.statuses.c1 = { state: 'waiting', pendingAsks: 0, pendingApprovals: 1 };
    h.host.onAgentEvent(
      event('approval-request', {
        request: { requestId: 'ap-1', tool: 'bash', kind: 'command', summary: 'rm -rf build' },
      }),
      change('waiting', 'running')
    );
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'needs-user' });
    expect(h.state.file.relays).toBeUndefined();
  });
});

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

  it('终态回传带 8000 字以内的完整汇报，一轮结束带 2000 字，工作台与手机仍用短正文', () => {
    const report = `${'过程'.repeat(1500)}\n测试 812 passed，提交 1a2b3c4`;
    const done = harness({ notify: 'with-done' });
    done.state.statuses.c1 = idle;
    done.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    done.host.onAgentEvent(
      event('turn-completed', {
        digest: { assistantText: report.slice(-1500) },
        report: { text: report },
      }),
      change('idle', 'running')
    );
    expect(done.state.file.outbox[0]).toMatchObject({ kind: 'goal-complete', lastText: report });
    // 工作台卡片与手机里程碑仍用短正文
    expect(done.state.file.dispatched.c1.lastText?.length).toBeLessThanOrEqual(501);
    expect(done.state.contact.milestones).toHaveLength(1);
    expect(done.state.contact.milestones[0]?.lastText?.length).toBeLessThanOrEqual(501);

    const progress = harness({});
    progress.state.statuses.c1 = idle;
    progress.host.onAgentEvent(
      event('turn-completed', {
        digest: { assistantText: report.slice(-1500) },
        report: { text: report },
      }),
      change('idle', 'running')
    );
    expect(progress.state.file.outbox[0]?.kind).toBe('turn-ended');
    expect(progress.state.file.outbox[0]?.lastText).toBe(
      `[已截断：前面省略 ${report.length - 2000} 字，以下是结尾]\n${report.slice(-2000)}`
    );
    expect(progress.state.file.dispatched.c1.lastText?.length).toBeLessThanOrEqual(501);
    expect(progress.state.contact.milestones).toEqual([]);
  });

  it('一轮结束 1500 字的正文完整送到秘书', async () => {
    const h = withSecretary(harness({}));
    const text = `${'过程'.repeat(745)}提交 1a2b3c4`;
    h.host.onAgentEvent(
      event('turn-completed', { digest: { assistantText: text }, report: { text } }),
      []
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.prompts[0]).toContain(text);
    expect(h.state.prompts[0]).not.toContain('已截断');
  });

  it('普通会话的 turn-ended 和 needs-user、failed 一样不推迟', () => {
    const held = harness({});
    held.state.statuses.c1 = idle;
    held.host.onAgentEvent(
      event('turn-completed', { digest: { assistantText: '先这样' } }),
      change('idle', 'running')
    );
    expect(held.state.file.outbox[0]).toMatchObject({ kind: 'turn-ended' });
    expect(held.state.file.outbox[0]?.deliverAt).toBeUndefined();

    const urgent = harness({});
    urgent.host.onAgentEvent(event('ask-request'), change('waiting', 'running'));
    expect(urgent.state.file.outbox[0]).toMatchObject({ kind: 'needs-user' });
    expect(urgent.state.file.outbox[0]?.deliverAt).toBeUndefined();
  });

  /** 秘书会话 sec1 在线、派出会话 c1 已空闲：结果一入队就能投 */
  function withSecretary(h: Harness): Harness {
    h.ports.projects = () => [
      { projectId: 'sp', canonicalPath: '/s', kind: 'secretary', state: 'active', version: 1 },
    ];
    h.ports.conversations = () => [
      { conversationId: 'sec1', projectId: 'sp', kind: 'root', lifecycle: 'ready', version: 1 },
    ];
    h.state.rows.sec1 = { id: 'sec1', title: '秘书' };
    h.state.statuses.c1 = idle;
    return h;
  }

  it.each([
    [
      'goal-complete',
      [
        event('goal-signal', { kind: 'complete', note: 'ok' }),
        event('turn-completed', { digest: { assistantText: '修好了' } }),
      ],
    ],
    ['goal-blocked', [event('goal-signal', { kind: 'blocked', note: '缺密钥' })]],
    ['interrupted', [event('turn-failed', { interrupted: { at: 1, kind: 'quit' } })]],
    ['failed', [event('turn-failed', { error: 'boom' })]],
    ['needs-user', [event('approval-request')]],
  ])('终态 %s 产生即投进秘书会话，不等合并窗口', async (kind, events) => {
    const h = withSecretary(harness({}));
    for (const item of events) {
      h.host.onAgentEvent(item, []);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.prompts[0]).toContain(`[${kind} session:c1]`);
    expect(h.state.file.outbox[0]?.deliverAt).toBeUndefined();
  });

  it('秘书空闲、没在等后台命令或子代理：一轮结束马上注入，不等 45 秒', async () => {
    const h = withSecretary(harness({}));
    h.state.now = 5_000;
    h.host.onAgentEvent(event('turn-completed', { digest: { assistantText: '这轮停下了' } }), []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.prompts[0]).toContain('[turn-ended session:c1]');
    expect(h.state.prompts[0]).toContain('这轮停下了');
    expect(h.state.file.outbox.every((entry) => entry.deliverAt !== 50_000)).toBe(true);
  });

  it('停滞等中间进度仍按窗口合并；别的会话终态立即投时不把它带走', async () => {
    const h = withSecretary(harness({}));
    h.state.file.dispatched.c2 = {
      ...h.state.file.dispatched.c1,
      conversationId: 'c2',
    } as DispatchRecord;
    h.state.rows.c2 = { id: 'c2', title: '另一个会话', projectId: 'p1' };
    h.state.statuses.c2 = idle;
    h.ports.backgroundStalls = () => [
      { conversationId: 'c2', taskId: 't1', reason: 'undelivered' },
    ];
    h.host.tick(0);
    h.ports.backgroundStalls = () => [];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.state.prompts).toEqual([]);
    expect(h.state.file.outbox).toHaveLength(1);
    expect(h.state.file.outbox[0]).toMatchObject({
      kind: 'stalled',
      conversationId: 'c2',
      deliverAt: 45_000,
    });

    h.state.now = 10_000;
    h.host.onAgentEvent(event('goal-signal', { kind: 'blocked', note: '缺密钥' }), []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.prompts[0]).toContain('[goal-blocked session:c1]');
    expect(h.state.prompts[0]).not.toContain('session:c2');
    expect(h.state.file.outbox.find((entry) => entry.key.startsWith('c2|'))?.deliverAt).toBe(
      45_000
    );
  });

  it('停滞不马上叫醒秘书，满 45 秒才投', async () => {
    const h = withSecretary(harness({}));
    h.ports.backgroundStalls = () => [
      { conversationId: 'c1', taskId: 't1', reason: 'undelivered' },
    ];
    h.host.tick(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.state.prompts).toEqual([]);
    h.state.now = 44_999;
    h.host.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.state.prompts).toEqual([]);
    h.state.now = 45_000;
    h.host.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.prompts[0]).toContain('[stalled session:c1]');
  });

  describe('一轮停下来是在等后台命令或子代理', () => {
    const build = (extra: Partial<ObservedTask> = {}): ObservedTask => ({
      taskId: 'b1',
      command: 'pnpm build',
      status: 'running',
      startedAt: 0,
      ...extra,
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it.each([
      ['后台命令', (h: Harness) => (h.state.tasks.c1 = [build()])],
      ['子代理', (h: Harness) => (h.state.subagents.c1 = true)],
    ])('还有%s没回来：这一轮结束不送给秘书，过了合并窗口也不补', async (_, arm) => {
      const h = withSecretary(harness({}));
      arm(h);
      h.host.onAgentEvent(event('turn-completed', { digest: { assistantText: '等它跑完' } }), []);
      await settle();
      h.state.now = 60_000;
      h.host.tick();
      await settle();
      expect(h.state.prompts).toEqual([]);
      expect(h.state.file.outbox).toEqual([]);
      expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
    });

    it('后台命令回来后又只等子代理：继续不送；子代理回来后目标完成马上送到', async () => {
      const h = withSecretary(harness({}));
      h.state.tasks.c1 = [build()];
      h.host.onAgentEvent(event('turn-completed'), []);
      // 命令跑完叫醒会话，这一轮又派了子代理
      h.state.tasks.c1 = [build({ status: 'done' })];
      h.state.subagents.c1 = true;
      h.state.now = 10_000;
      h.host.onAgentEvent(event('turn-completed'), []);
      await settle();
      expect(h.state.prompts).toEqual([]);
      expect(h.state.file.outbox).toEqual([]);

      h.state.subagents.c1 = false;
      h.state.now = 20_000;
      h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
      await settle();
      h.host.onAgentEvent(event('turn-completed', { digest: { assistantText: '修好了' } }), []);
      await settle();
      expect(h.state.prompts).toHaveLength(1);
      expect(h.state.prompts[0]).toContain('[goal-complete session:c1]');
    });

    it('等待前排着的上一轮「结束」撤掉，不再按窗口补送', async () => {
      // 没有秘书会话可投：上一轮「结束」还排在队里
      const h = harness({});
      h.state.statuses.c1 = idle;
      h.host.onAgentEvent(event('turn-completed'), []);
      expect(h.state.file.outbox[0]).toMatchObject({ kind: 'turn-ended' });
      h.state.tasks.c1 = [build()];
      h.state.now = 10_000;
      h.host.onAgentEvent(event('turn-completed'), []);
      h.state.now = 60_000;
      h.host.tick();
      await settle();
      expect(h.state.prompts).toEqual([]);
      expect(h.state.file.outbox).toEqual([]);
    });

    it('终态不因还有后台命令被吞：goal-complete 照样马上送，带上还在跑的任务', async () => {
      const h = withSecretary(harness({}));
      h.state.tasks.c1 = [build({ command: 'pnpm test' })];
      h.state.subagents.c1 = true;
      h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
      await settle();
      h.host.onAgentEvent(event('turn-completed'), []);
      await settle();
      expect(h.state.prompts).toHaveLength(1);
      expect(h.state.prompts[0]).toContain('[goal-complete session:c1]');
      expect(h.state.prompts[0]).toContain('还有 1 个后台任务在跑');
    });

    it('没有后台命令也没有子代理（常驻服务不算）：马上送，不等 45 秒', async () => {
      const h = withSecretary(harness({}));
      h.state.tasks.c1 = [
        build({ status: 'done' }),
        build({ taskId: 'srv', command: 'python3 -m http.server 8931' }),
      ];
      h.host.onAgentEvent(event('turn-completed'), []);
      await settle();
      expect(h.state.prompts).toHaveLength(1);
      expect(h.state.prompts[0]).toContain('[turn-ended session:c1]');
    });

    it('子代理自己的回合结束不算主会话结束', async () => {
      const h = withSecretary(harness({}));
      h.state.subagents.c1 = true;
      const child = {
        sessionId: 'c1::child',
        generation: 'gc',
        parent: { sessionId: 'c1', generation: 'g1' },
      };
      h.host.onAgentEvent(event('turn-completed', { identity: child }), []);
      h.state.now = 60_000;
      h.host.tick();
      await settle();
      expect(h.state.prompts).toEqual([]);
      expect(h.state.file.outbox).toEqual([]);
      expect(h.state.file.dispatched.c1.turn).toBe(0);
    });
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

  describe('会话第一轮就失败', () => {
    const kinds = (h: Harness) => (h.state.file.activity ?? []).map((entry) => entry.kind);

    it('空闲直接跳 error 带 turn-failed：记失败并带上错误原因', () => {
      const h = harness({});
      h.state.file.dispatched.c1.lastState = 'idle';
      h.state.statuses.c1 = error;
      h.host.onAgentEvent(event('turn-failed', { error: 'boom' }), change('error', 'idle'));
      expect(h.state.file.outbox).toEqual([
        expect.objectContaining({ kind: 'failed', text: expect.stringContaining('boom') }),
      ]);
      expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'failed', turn: 1 });
    });

    it('只有 status=failed、没有 turn-failed（命令直接抛错）：过了配对窗口照样记失败', () => {
      const h = harness({});
      h.state.file.dispatched.c1.lastState = 'idle';
      h.state.statuses.c1 = error;
      h.host.onAgentEvent(
        event('status', { status: 'failed', error: 'model not found' }),
        change('error', 'idle')
      );
      expect(kinds(h)).toEqual([]);
      h.state.now = 60_000;
      h.host.tick();
      expect(kinds(h)).toEqual(['failed']);
      expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'failed', turn: 1 });
      expect(h.state.file.outbox).toEqual([
        expect.objectContaining({
          kind: 'failed',
          text: expect.stringContaining('model not found'),
        }),
      ]);
      expect(h.state.contact.milestones).toEqual([expect.objectContaining({ kind: 'failed' })]);
      h.state.now = 120_000;
      h.host.tick();
      expect(kinds(h)).toEqual(['failed']);
      expect(h.state.contact.milestones).toHaveLength(1);
    });

    it('status=failed 紧跟 turn-failed：同一次失败只记一条', () => {
      const h = harness({});
      h.state.statuses.c1 = error;
      h.host.onAgentEvent(
        event('status', { status: 'failed', error: 'boom' }),
        change('error', 'idle')
      );
      h.host.onAgentEvent(event('turn-failed', { error: 'boom' }), []);
      h.state.now = 60_000;
      h.host.tick();
      expect(kinds(h)).toEqual(['failed']);
      expect(h.state.contact.milestones).toHaveLength(1);
      expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'failed', turn: 1 });
    });

    it('退出窗口里的 status=failed 随后改判成中断：不补记失败', () => {
      const h = harness({});
      h.state.statuses.c1 = error;
      h.host.onAgentEvent(event('status', { status: 'failed' }), change('error', 'running'));
      h.host.onAgentEvent(
        event('turn-failed', { error: 'terminated', interrupted: { at: 1, kind: 'quit' } }),
        []
      );
      h.state.now = 60_000;
      h.host.tick();
      expect(kinds(h)).toEqual(['interrupted']);
    });

    it('配对窗口内会话已恢复：不再补记失败', () => {
      const h = harness({});
      h.state.statuses.c1 = error;
      h.host.onAgentEvent(event('status', { status: 'failed' }), change('error', 'idle'));
      h.state.statuses.c1 = running;
      h.state.now = 60_000;
      h.host.tick();
      expect(kinds(h)).toEqual([]);
    });

    it('worker 退出把空闲会话打成 error（没有 turn-failed）：巡检后也不记失败', () => {
      const h = harness({});
      h.state.file.dispatched.c1.lastState = 'idle';
      h.state.statuses.c1 = error;
      h.host.onAgentEvent({ type: 'worker-exited' } as RendererAgentEvent, change('error', 'idle'));
      h.state.now = 60_000;
      h.host.tick();
      expect(kinds(h)).toEqual([]);
      expect(h.state.contact.milestones).toEqual([]);
    });

    it('配对窗口到点就补记，不等每分钟的巡检', () => {
      vi.useFakeTimers();
      try {
        const h = harness({});
        h.state.statuses.c1 = error;
        h.host.onAgentEvent(
          event('status', { status: 'failed', error: 'model not found' }),
          change('error', 'idle')
        );
        h.state.now = 4_000;
        vi.advanceTimersByTime(4_000);
        expect(kinds(h)).toEqual([]);
        h.state.now = 5_000;
        vi.advanceTimersByTime(1_000);
        expect(kinds(h)).toEqual(['failed']);
        expect(h.state.file.outbox).toEqual([
          expect.objectContaining({
            kind: 'failed',
            text: expect.stringContaining('model not found'),
          }),
        ]);
        expect(h.state.file.dispatched.c1.failurePending).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('正在跑时的 status=failed 不终止这一轮：不挂起、不补记', () => {
      const h = harness({});
      h.state.statuses.c1 = error;
      h.host.onAgentEvent(
        event('status', { status: 'failed', error: 'x' }),
        change('error', 'running')
      );
      expect(h.state.file.dispatched.c1.failurePending).toBeUndefined();
      h.state.now = 60_000;
      h.host.tick();
      expect(kinds(h)).toEqual([]);
    });

    it('已经收口、秘书没再追加任务的会话：之后的命令出错不报失败', () => {
      const h = harness({});
      h.state.file.dispatched.c1.lastResult = { kind: 'goal-complete', turn: 1, at: 0 };
      h.state.file.dispatched.c1.turn = 1;
      h.state.statuses.c1 = error;
      h.host.onAgentEvent(
        event('status', { status: 'failed', error: 'x' }),
        change('error', 'idle')
      );
      h.state.now = 60_000;
      h.host.tick();
      expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-complete' });
      expect(h.state.file.outbox).toEqual([]);
    });

    it('秘书追加任务后空闲时直接失败：补记失败并结束重新跟踪', () => {
      const h = harness({});
      h.state.file.dispatched.c1.lastResult = { kind: 'goal-complete', turn: 1, at: 0 };
      h.state.file.dispatched.c1.turn = 1;
      h.state.file.dispatched.c1.reopenedAt = 0;
      h.state.statuses.c1 = error;
      h.host.onAgentEvent(
        event('status', { status: 'failed', error: 'x' }),
        change('error', 'idle')
      );
      h.state.now = 60_000;
      h.host.tick();
      expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'failed', turn: 2 });
      expect(h.state.file.dispatched.c1.reopenedAt).toBeUndefined();
    });

    it('错误原因先脱敏再截断', () => {
      const h = harness({});
      h.state.statuses.c1 = error;
      const token = `sk-${'a'.repeat(40)}`;
      h.host.onAgentEvent(
        event('status', { status: 'failed', error: `401 api_key=${token} ${'x'.repeat(500)}` }),
        change('error', 'idle')
      );
      const pending = h.state.file.dispatched.c1.failurePending;
      expect(pending?.detail).not.toContain(token);
      expect(pending?.detail?.length).toBeLessThanOrEqual(200);
      h.state.now = 60_000;
      h.host.tick();
      expect(JSON.stringify(h.state.file)).not.toContain(token);
    });

    it('配对窗口里重启：失败落了盘，启动时补报一次', () => {
      const h = harness({});
      h.state.statuses.c1 = error;
      h.host.onAgentEvent(
        event('status', { status: 'failed', error: 'boom' }),
        change('error', 'idle')
      );
      expect(h.state.file.dispatched.c1.failurePending).toMatchObject({ detail: 'boom' });
      const restarted = harness({ file: structuredClone(h.state.file) });
      restarted.state.statuses.c1 = idle;
      restarted.host.recover();
      expect(restarted.state.file.dispatched.c1.lastResult).toMatchObject({
        kind: 'failed',
        turn: 1,
      });
      expect(restarted.state.file.outbox).toEqual([
        expect.objectContaining({ kind: 'failed', text: expect.stringContaining('boom') }),
      ]);
      expect(restarted.state.file.dispatched.c1.failurePending).toBeUndefined();
      restarted.state.now = 60_000;
      restarted.host.tick();
      expect(restarted.state.file.outbox).toHaveLength(1);
    });

    it('配对窗口里重启但冷启动接着跑：不补报', () => {
      const h = harness({});
      h.state.file.dispatched.c1.lastState = 'error';
      h.state.file.dispatched.c1.failurePending = { at: 0, detail: 'boom' };
      h.ports.coldResumed = () => true;
      h.host.recover();
      expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
      expect(h.state.file.dispatched.c1.failurePending).toBeUndefined();
    });
  });

  describe('会话没能启动（spawn 被拒）', () => {
    const rejected = (reason: string) =>
      ({ type: 'parent-rejected', identity, seq: 0, reason }) as RendererAgentEvent;

    it('非 STALE 的拒绝：记一次失败并带上脱敏后的原因', () => {
      const h = harness({});
      h.state.statuses.c1 = idle;
      const token = `ghp_${'b'.repeat(30)}`;
      h.host.onAgentEvent(rejected(`model unavailable token=${token}`), []);
      expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'failed', turn: 0 });
      expect(h.state.file.outbox).toEqual([
        expect.objectContaining({
          kind: 'failed',
          text: expect.stringContaining('会话没能启动：model unavailable'),
        }),
      ]);
      expect(JSON.stringify(h.state.file)).not.toContain(token);
      expect(h.state.contact.milestones).toEqual([expect.objectContaining({ kind: 'failed' })]);
      // 紧跟着首条消息因会话不在被拒（STALE）：不再记第二次
      h.host.onAgentEvent(rejected('unknown or stale session generation: c1'), []);
      expect(h.state.file.outbox).toHaveLength(1);
      expect(h.state.contact.milestones).toHaveLength(1);
    });

    it('只有 STALE 拒绝：不是会话本身出错，不记', () => {
      const h = harness({});
      h.host.onAgentEvent(rejected('unknown or stale session generation: c1'), []);
      expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
      expect(h.state.file.outbox).toEqual([]);
    });

    it('不是秘书派出或跟踪的会话：不记也不推', () => {
      const h = harness({});
      h.host.onAgentEvent(
        {
          type: 'parent-rejected',
          identity: { sessionId: 'other', generation: 'g' },
          seq: 0,
          reason: 'boom',
        } as RendererAgentEvent,
        []
      );
      expect(h.state.file.outbox).toEqual([]);
      expect(h.state.contact.milestones).toEqual([]);
    });

    it('和冷启动续跑失败的补报只算一次', () => {
      const h = harness({});
      h.host.onAgentEvent(rejected('model unavailable'), []);
      h.host.onRestartResumeFailed('c1', 'model unavailable');
      expect(h.state.file.outbox).toHaveLength(1);
      expect(h.state.contact.milestones).toHaveLength(1);
    });
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
    // 有后台任务但任务卡住：走 20 分钟兜底规则
    h.state.tasks.c1 = [{ taskId: 't1', command: 'pnpm build', status: 'running', startedAt: 0 }];
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
    h.host.tick(2 * MINUTE);
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.notifications).toEqual([]);
  });

  it('goal 会话空闲 3 分钟、没有后台任务就报停住，正文带标题、时长、最后一条与 goal 状态', () => {
    const h = harness({});
    idleWithGoal(h);
    h.state.file.dispatched.c1.lastText = '我仍在运行，检查安装脚本是否真的执行了';
    h.host.tick(3 * MINUTE + 1);
    const stalled = h.state.file.outbox.filter((update) => update.kind === 'stalled');
    expect(stalled).toHaveLength(1);
    // 会话标题、停了多久、goal 状态、有没有后台任务、最后一条摘要
    expect(stalled[0].text).toContain('派出会话');
    expect(stalled[0].text).toContain('已空闲 3 分钟');
    expect(stalled[0].text).toContain('目标 active');
    expect(stalled[0].text).toContain('没有后台任务');
    expect(stalled[0].text).toContain('最后一条：我仍在运行，检查安装脚本是否真的执行了');
    expect(h.state.file.dispatched.c1.patrol).toMatchObject({ reason: 'goal-idle-stalled' });
    // 同一次停住只推一次：20 分钟兜底不再补一条
    h.host.tick(20 * MINUTE + 1);
    expect(h.state.file.outbox.filter((update) => update.kind === 'stalled')).toHaveLength(1);
  });

  it('goal 会话空闲、没有后台任务但挂着没到点的提醒：不报停住；到点 2 分钟后还没被叫醒才照报', () => {
    const h = harness({});
    idleWithGoal(h);
    const due = 30 * MINUTE;
    h.ports.reminders = () => [
      {
        id: 'r00000001',
        sessionId: 'c1',
        dueAt: due,
        createdAt: 0,
        prompt: 'check CI',
        ifIdle: true,
        chain: 1,
      },
    ];
    h.host.tick(3 * MINUTE + 1);
    h.host.tick(25 * MINUTE);
    h.host.tick(due + 1 * MINUTE);
    expect(h.state.file.outbox.filter((update) => update.kind === 'stalled')).toEqual([]);
    h.host.tick(due + 5 * MINUTE);
    expect(h.state.file.outbox.filter((update) => update.kind === 'stalled')).toHaveLength(1);
  });

  it('有存活后台任务的 idle 会话不走 3 分钟规则，20 分钟才兜底报', () => {
    const h = harness({});
    idleWithGoal(h);
    h.state.tasks.c1 = [{ taskId: 't1', command: 'pnpm build', status: 'running', startedAt: 0 }];
    h.host.tick(3 * MINUTE + 1);
    expect(h.state.file.outbox).toEqual([]);
    h.host.tick(20 * MINUTE + 1);
    const stalled = h.state.file.outbox.filter((update) => update.kind === 'stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].text).toContain('有后台任务');
    expect(h.state.file.dispatched.c1.patrol).toMatchObject({ reason: 'idle-stalled' });
  });

  it('追加的目标与派出时同一种：空闲且没完成就按 3 分钟报停住', () => {
    const h = harness({});
    // session_send 带 goal 之后：行上挂着 active 目标，记录记着同一段文本
    h.state.rows.c1 = {
      ...h.state.rows.c1,
      goal: {
        text: '查清安装脚本有没有真的执行',
        status: 'active',
        autoTurns: 0,
        noProgressRuns: 0,
      },
    };
    h.state.file.dispatched.c1.goal = '查清安装脚本有没有真的执行';
    h.state.file.dispatched.c1.lastState = 'idle';
    h.state.statuses.c1 = idle;
    h.host.tick(3 * MINUTE + 1);
    const stalled = h.state.file.outbox.filter((update) => update.kind === 'stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].text).toContain('目标 active');
  });

  it('刚 goal_complete 的会话不报停住', () => {
    const h = harness({});
    idleWithGoal(h);
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete' }), []);
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-complete' });
    h.host.tick(3 * MINUTE + 1);
    expect(h.state.file.outbox.filter((update) => update.kind === 'stalled')).toEqual([]);
  });

  it('刚被 session_send 唤起、还在处理的不报停住', () => {
    const h = harness({});
    idleWithGoal(h);
    // session_send 唤起：记录标回运行中、活动时间刷新，实时状态还是空闲
    h.state.file.dispatched.c1.lastState = 'running';
    h.state.file.dispatched.c1.lastEventAt = 10 * MINUTE;
    h.state.now = 10 * MINUTE;
    h.host.tick(11 * MINUTE);
    expect(h.state.file.outbox).toEqual([]);
    // 这一轮结束、又静了 3 分钟以上：才按停住报
    h.state.file.dispatched.c1.lastState = 'idle';
    h.host.tick(14 * MINUTE + 1);
    expect(h.state.file.outbox.filter((update) => update.kind === 'stalled')).toHaveLength(1);
  });

  it('等用户回答的会话不报停住', () => {
    const h = harness({});
    idleWithGoal(h);
    h.state.statuses.c1 = { state: 'waiting', pendingAsks: 1, pendingApprovals: 0 };
    h.host.tick(3 * MINUTE + 1);
    expect(h.state.file.outbox).toEqual([]);
  });

  it('最后一条是完成汇报的不走 3 分钟规则，仍按 20 分钟兜底', () => {
    const h = harness({});
    idleWithGoal(h);
    h.state.file.dispatched.c1.lastText = '已完成：打包并安装 EnsoCode';
    h.host.tick(3 * MINUTE + 1);
    expect(h.state.file.outbox).toEqual([]);
    h.host.tick(20 * MINUTE + 1);
    expect(h.state.file.outbox.filter((update) => update.kind === 'stalled')).toHaveLength(1);
  });

  it('会话有了新事件就算恢复，之后再次停住会重新推', () => {
    const h = harness({});
    idleWithGoal(h);
    h.host.tick(3 * MINUTE + 1);
    expect(h.state.file.dispatched.c1.patrol).toBeDefined();
    // 4 分钟时来了一次事件：下一次巡检把标记清掉，且因为刚动过不报
    h.state.now = 4 * MINUTE;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    h.state.statuses.c1 = idle;
    h.host.tick(6 * MINUTE + 1);
    expect(h.state.file.dispatched.c1.patrol).toBeUndefined();
    expect(h.state.file.outbox.filter((update) => update.kind === 'stalled')).toHaveLength(1);
    // 之后又静了 3 分钟以上：按新的一轮重新推一次（同一会话只留最新一条）
    h.host.tick(10 * MINUTE);
    expect(h.state.file.dispatched.c1.patrol).toMatchObject({
      reason: 'goal-idle-stalled',
      turn: 1,
      at: 10 * MINUTE,
    });
    expect(h.state.file.outbox.map((update) => update.key)).toEqual(['c1|stalled|1']);
  });

  it('旧档案里的停住阈值不再生效：固定按 3 分钟报', () => {
    const h = harness({});
    const legacy = h.ports.profile;
    h.ports.profile = () => ({ ...legacy(), patrolIdleGoalMinutes: 10 }) as never;
    idleWithGoal(h);
    h.host.tick(3 * MINUTE + 1);
    expect(h.state.file.outbox.filter((update) => update.kind === 'stalled')).toHaveLength(1);
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

  it('出问题的等待派发满 24 小时由巡检清掉并写审计；未满的、等待中的不动', () => {
    const DAY = 24 * 60 * MINUTE;
    const base: PendingDispatch = {
      id: 'x',
      projectId: 'p1',
      secretaryConversationId: 'sec1',
      createdAt: 0,
      updatedAt: 0,
      status: 'failed',
      problem: 'dependency-failed',
      after: ['c1'],
      draft: { projectId: 'p1', prompt: '接着改', worktree: false },
    };
    const h = harness({
      file: {
        pending: {
          old: { ...base, id: 'old' },
          fresh: { ...base, id: 'fresh', updatedAt: MINUTE, problem: 'dispatch-failed' },
          wait: { ...base, id: 'wait', status: 'waiting', problem: undefined },
        },
      },
    });
    h.ports.startPending = () => undefined;
    h.host.tick(DAY - 1);
    expect(Object.keys(h.state.file.pending ?? {}).sort()).toEqual(['fresh', 'old', 'wait']);
    expect(h.state.audit.filter((entry) => entry.op === 'pending_expire')).toEqual([]);

    h.host.tick(DAY);
    expect(Object.keys(h.state.file.pending ?? {}).sort()).toEqual(['fresh', 'wait']);
    expect(h.state.audit.filter((entry) => entry.op === 'pending_expire')).toEqual([
      {
        at: DAY,
        secretaryConversationId: 'sec1',
        op: 'pending_expire',
        targetId: 'old',
        ok: true,
        detail: 'dependency-failed',
      },
    ]);

    h.host.tick(DAY + MINUTE);
    expect(Object.keys(h.state.file.pending ?? {})).toEqual(['wait']);
  });
});

describe('被 session_send 重新唤起后的收口', () => {
  /** 秘书追加任务后的记录：旧终态已撤下，reopenedAt 已记，lastState 标回运行中 */
  const reopened = (over: Partial<DispatchRecord> = {}) => ({
    dispatched: {
      c1: {
        ...emptyFile().dispatched.c1,
        turn: 2,
        lastState: 'running' as const,
        reopenedAt: 20,
        ...over,
      },
    },
  });

  it('这一轮以 turn-ended 收尾：照常推给秘书', () => {
    const h = harness({ file: reopened() });
    h.state.statuses.c1 = idle;
    h.state.now = 30;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'turn-ended', turn: 3 });
    expect(h.state.file.dispatched.c1.reopenedAt).toBeUndefined();
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['turn-ended']);
  });

  it('旧终态还留在记录上（goal-complete 后再发消息）：这一轮结束照样推，不回到旧终态', () => {
    const h = harness({
      file: reopened({ lastResult: { kind: 'goal-complete', turn: 2, at: 10 } }),
    });
    h.state.statuses.c1 = idle;
    h.state.now = 30;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'turn-ended', turn: 3 });
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['turn-ended']);
  });

  it('目标停在受阻或暂停：不会续跑，这一轮结束报 turn-ended', () => {
    for (const status of ['blocked', 'paused']) {
      const h = harness({ file: reopened() });
      h.state.rows.c1.goal = { text: '旧目标', status, autoTurns: 0 };
      h.state.statuses.c1 = idle;
      h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
      expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'turn-ended', turn: 3 });
      expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['turn-ended']);
    }
  });

  it('这一轮又调了 goal_blocked：报受阻，不被随后的轮次结束盖掉', () => {
    const h = harness({ file: reopened() });
    h.state.rows.c1.goal = { text: '新目标', status: 'active', autoTurns: 0 };
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'blocked', note: '缺 token' }), []);
    h.state.rows.c1.goal = { text: '新目标', status: 'blocked', autoTurns: 0 };
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-blocked' });
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['goal-blocked']);
  });

  it('挂上的新目标还在跑：这一轮结束不推，目标完成时推完成', () => {
    const h = harness({ file: reopened() });
    h.state.rows.c1.goal = { text: '新目标', status: 'active', autoTurns: 0 };
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.outbox).toEqual([]);
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    delete h.state.rows.c1.goal;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({
      kind: 'goal-complete',
      turn: 4,
    });
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['goal-complete']);
  });

  it('这一轮失败：更新成失败', () => {
    const h = harness({ file: reopened() });
    h.state.statuses.c1 = error;
    h.host.onAgentEvent(event('turn-failed', { error: 'boom' }), change('error', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'failed', turn: 3 });
    expect(h.state.file.dispatched.c1.reopenedAt).toBeUndefined();
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'failed' });
  });

  it('这一轮又调了 goal_complete：照常记完成', () => {
    const h = harness({ file: reopened() });
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({
      kind: 'goal-complete',
      turn: 3,
    });
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['goal-complete']);
  });

  it('不是重新唤起的那一轮照旧记 turn-ended', () => {
    const h = harness({ file: reopened({ reopenedAt: undefined }) });
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'turn-ended', turn: 3 });
  });
});

describe('静默收工', () => {
  const toolTurn = (extra: Record<string, unknown> = {}) =>
    event('turn-completed', {
      digest: {
        firstUserText: '查安装脚本',
        userText: '查安装脚本',
        assistantText: '',
        lastTool: { name: 'read', ok: true },
      },
      ...extra,
    });

  it('一轮结束没有任何文字回复：推 stalled，带上最后一个工具名和成败', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(toolTurn(), change('idle', 'running'));
    const stalled = h.state.file.outbox.filter((update) => update.kind === 'stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].text).toContain('read');
    expect(stalled[0].text).toContain('成功');
    expect(h.state.file.outbox.some((update) => update.kind === 'turn-ended')).toBe(false);
  });

  it('最后一个工具失败时推送里标明失败', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(
      event('turn-completed', {
        digest: {
          firstUserText: '查安装脚本',
          userText: '查安装脚本',
          assistantText: '',
          lastTool: { name: 'bash', ok: false },
        },
      }),
      change('idle', 'running')
    );
    const stalled = h.state.file.outbox.filter((update) => update.kind === 'stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].text).toContain('bash');
    expect(stalled[0].text).toContain('失败');
  });

  it('正常写了文字再结束：照旧推 turn-ended，不报 stalled', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(
      event('turn-completed', { digest: { assistantText: '安装脚本确实执行了' } }),
      change('idle', 'running')
    );
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['turn-ended']);
  });

  it('带目标的会话静默收工同样推 stalled', () => {
    const h = harness({});
    h.state.rows.c1 = { ...h.state.rows.c1, goal: { text: 'g', status: 'active' } };
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(toolTurn(), change('idle', 'running'));
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['stalled']);
  });

  it('被中断的一轮不报静默收工', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(toolTurn({ aborted: true }), change('idle', 'running'));
    expect(h.state.file.outbox).toEqual([]);
  });
});

describe('发了消息后没有可见回复', () => {
  const quiet = (h: ReturnType<typeof harness>, over: Partial<DispatchRecord> = {}) => {
    h.state.file.dispatched.c1 = {
      ...h.state.file.dispatched.c1,
      lastEventAt: 0,
      lastText: '我去查一下',
      sentAt: 0,
      // 秘书刚发过消息：记录标回运行中，实时状态还是空闲
      lastState: 'running' as const,
      ...over,
    };
    h.state.statuses.c1 = idle;
  };

  it('秘书发过消息的会话静了 3 分钟：推 stalled', () => {
    const h = harness({});
    quiet(h);
    h.state.now = 3 * MINUTE + 1;
    h.host.tick(3 * MINUTE + 1);
    const stalled = h.state.file.outbox.filter((update) => update.kind === 'stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].text).toContain('没有任何回复');
    // 同一轮只推一次
    h.host.tick(20 * MINUTE);
    expect(h.state.file.outbox.filter((update) => update.kind === 'stalled')).toHaveLength(1);
  });

  it('秘书没发过消息的会话不走这条兜底', () => {
    const h = harness({});
    quiet(h, { sentAt: undefined });
    h.host.tick(60 * MINUTE);
    expect(h.state.file.outbox).toEqual([]);
  });

  it('3 分钟内有过回复就不报', () => {
    const h = harness({});
    quiet(h, { lastEventAt: 1 * MINUTE });
    h.host.tick(3 * MINUTE);
    expect(h.state.file.outbox).toEqual([]);
  });

  it('等用户回答、等审批、有后台任务时不报', () => {
    const asking = harness({});
    quiet(asking);
    asking.state.statuses.c1 = { state: 'waiting', pendingAsks: 1, pendingApprovals: 0 };
    asking.host.tick(20 * MINUTE);
    expect(asking.state.file.outbox).toEqual([]);

    const approving = harness({});
    quiet(approving);
    approving.state.statuses.c1 = { state: 'idle', pendingAsks: 0, pendingApprovals: 1 };
    approving.host.tick(20 * MINUTE);
    expect(approving.state.file.outbox).toEqual([]);

    const busy = harness({});
    quiet(busy);
    busy.state.tasks.c1 = [{ taskId: 't1', command: 'pnpm test', status: 'running', startedAt: 0 }];
    busy.host.tick(20 * MINUTE);
    expect(busy.state.file.outbox).toEqual([]);
  });

  it('有了新的助手文字或工具调用就不报', () => {
    const h = harness({});
    quiet(h);
    h.state.now = 2 * MINUTE;
    h.host.onAgentEvent(event('message-update'), []);
    h.state.statuses.c1 = idle;
    h.host.tick(4 * MINUTE);
    expect(h.state.file.outbox).toEqual([]);
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

  it('中断回传带上退出原因，不报成失败', () => {
    const h = harness({});
    h.state.interruptDetails.c1 = '应用在 20:26:52 被关闭（安装更新），这一轮被中断。';
    h.host.recover();
    const update = h.state.file.outbox[0];
    expect(update).toMatchObject({ kind: 'interrupted' });
    expect(update.text).toContain('20:26:52');
    expect(update.text).toContain('安装更新');
  });

  it('退出窗口内的断流事件按 interrupted 回传，不报 failed', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(
      {
        type: 'turn-failed',
        identity: { sessionId: 'c1', generation: 'g1' },
        seq: 2,
        turnId: 't1',
        error: 'OpenAI Responses stream ended before a terminal response event',
        interrupted: { at: 1_700_000_000_000, kind: 'quit' },
      } as RendererAgentEvent,
      change('idle', 'running')
    );
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'interrupted' });
    expect(h.state.file.outbox.map((entry) => entry.kind)).toEqual(['interrupted']);
  });

  it('存量脏数据：记录还写着进行中、会话已空闲且已有终态，启动时直接收口', () => {
    const h = harness({});
    h.state.file.dispatched.c1.lastResult = { kind: 'goal-complete', turn: 2, at: 900 };
    h.state.file.dispatched.c1.reopenedAt = 950;
    h.state.statuses.c1 = idle;
    h.state.now = 5000;
    h.host.recover();
    expect(h.state.file.dispatched.c1).toMatchObject({
      lastState: 'idle',
      stateSince: 5000,
      lastResult: { kind: 'goal-complete', turn: 2, at: 900 },
    });
    expect(h.state.file.dispatched.c1.reopenedAt).toBeUndefined();
    // 不报中断，也不重复推一条回传
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.audit.filter((entry) => entry.op === 'dispatch_settle')).toEqual([
      {
        at: 5000,
        secretaryConversationId: 'sec1',
        op: 'dispatch_settle',
        targetId: 'c1',
        ok: true,
        detail: 'startup goal-complete',
      },
    ]);
  });

  it('没有终态、还有后台任务或待处理项时不收口，仍按中断处理', () => {
    const noResult = harness({});
    noResult.state.statuses.c1 = idle;
    noResult.host.recover();
    expect(noResult.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'interrupted' });
    expect(noResult.state.audit).toEqual([]);

    const background = harness({});
    background.state.file.dispatched.c1.lastResult = { kind: 'goal-complete', turn: 2, at: 900 };
    background.state.file.dispatched.c1.backgroundRunning = true;
    background.state.statuses.c1 = idle;
    background.host.recover();
    expect(background.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'interrupted' });
    expect(background.state.audit).toEqual([]);

    const pending = harness({});
    pending.state.file.dispatched.c1.lastResult = { kind: 'goal-complete', turn: 2, at: 900 };
    pending.state.statuses.c1 = waiting;
    pending.host.recover();
    expect(pending.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'interrupted' });
    expect(pending.state.audit).toEqual([]);
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

  it('有别名时回传与通知用别名称呼项目', () => {
    const h = harness({ notify: 'needs-user' });
    h.ports.projects = () => [
      { projectId: 'p1', canonicalPath: '/repo/alpha', state: 'active', version: 1 },
    ];
    h.ports.projectAliases = () => ({ p1: '官网前端' });
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'blocked', note: 'no creds' }), []);
    expect(h.state.file.outbox[0]?.text).toContain('官网前端');
    expect(h.state.notifications[0]?.body).toContain('官网前端');
    expect(h.state.file.outbox[0]?.text).not.toContain('alpha');
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
    started: true,
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

  it('静默回合不打扰手机，批次照常结算', () => {
    const h = harness({
      secretaryIds: ['sec1'],
      file: { ...pending(), inflight: { ...inflight, keys: ['a', 'b', 'c'] } },
    });
    h.host.onAgentEvent(
      {
        type: 'turn-completed',
        identity: { sessionId: 'sec1', generation: 'g' },
        seq: 1,
        turnId: 't',
        silent: true,
      } as unknown as RendererAgentEvent,
      []
    );
    expect(h.state.contact.silent).toEqual([{ conversationId: 'sec1' }]);
    expect(h.state.contact.replies).toEqual([]);
    expect(h.state.file.inflight).toBeUndefined();
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

  it('这一批没进 worker（delivery-rejected）时按失败重投，别的投递的回执不算', () => {
    const h = harness({ file: { ...pending(), inflight: { ...inflight, started: false } } });
    const receipt = (type: string, deliveryId: string) =>
      ({
        type,
        identity: { sessionId: 'sec1', generation: 'g' },
        seq: 1,
        deliveryId,
      }) as unknown as RendererAgentEvent;
    h.host.onAgentEvent(receipt('delivery-rejected', 'other'), []);
    expect(h.state.file.inflight).toMatchObject({ attempt: 1 });
    h.host.onAgentEvent(receipt('delivery-rejected', 'd1'), []);
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

  it('手机关注的定时到点推一次手机：交给联系方式，由它决定推不推', () => {
    const h = harness({});
    h.state.schedules = [onceSchedule()];
    h.host.tick(localAt(9));
    expect(h.state.contact.scheduleFired).toEqual([{ scheduleId: 'sch1', text: '提醒：看看进展' }]);
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

describe('联系方式转发', () => {
  it('里程碑按 notify 走：with-done 发完成，off 一条不发', () => {
    const loud = harness({ notify: 'with-done' });
    loud.state.statuses.c1 = idle;
    loud.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    loud.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(loud.state.contact.milestones).toEqual([
      expect.objectContaining({ kind: 'goal-complete', conversationId: 'c1' }),
    ]);

    const quiet = harness({ notify: 'off' });
    quiet.state.statuses.c1 = idle;
    quiet.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    quiet.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(quiet.state.contact.milestones).toEqual([]);
  });

  it('中间进度（一轮结束）不转发', () => {
    const h = harness({ notify: 'with-done' });
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['turn-ended']);
    expect(h.state.contact.milestones).toEqual([]);
  });

  it('手机关注中的任务不受 notify 降噪：完成也回推，一轮结束仍然不发', () => {
    const h = harness({ notify: 'needs-user' });
    if (h.ports.contact) h.ports.contact.follows = (conversationId) => conversationId === 'c1';
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.contact.milestones).toEqual([]);
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.contact.milestones).toEqual([
      expect.objectContaining({ kind: 'goal-complete', conversationId: 'c1' }),
    ]);
  });

  it('手机关注的任务完成：发起渠道收到的同时，桌面秘书会话也马上收到一条，不等合并窗口', async () => {
    const desktop = async (follows: boolean) => {
      const h = harness({ notify: 'needs-user' });
      if (h.ports.contact && follows)
        h.ports.contact.follows = (conversationId) => conversationId === 'c1';
      h.ports.projects = () => [
        { projectId: 'sp', canonicalPath: '/s', kind: 'secretary', state: 'active', version: 1 },
      ];
      h.ports.conversations = () => [
        { conversationId: 'sec1', projectId: 'sp', kind: 'root', lifecycle: 'ready', version: 1 },
      ];
      h.state.rows.sec1 = { id: 'sec1', title: '秘书' };
      h.state.statuses.c1 = idle;
      h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
      // 上一次投递检查收尾后再来下一个事件，与真实事件流一致
      await new Promise((resolve) => setTimeout(resolve, 0));
      h.host.onAgentEvent(
        event('turn-completed', { digest: { assistantText: '修好了，提交 1a2b3c4' } }),
        change('idle', 'running')
      );
      return h;
    };

    const followed = await desktop(true);
    expect(followed.state.contact.milestones).toHaveLength(1);
    expect(followed.state.prompts).toHaveLength(1);
    expect(followed.state.prompts[0]).toMatch(/^sec1:<session-updates>/u);
    expect(followed.state.prompts[0]).toContain('[goal-complete session:c1]');
    expect(followed.state.prompts[0]).toContain('修好了，提交 1a2b3c4');
    // 同一结果再来一次事件也不重投
    await new Promise((resolve) => setTimeout(resolve, 0));
    followed.host.onAgentEvent(event('status', { status: 'idle' }), []);
    expect(followed.state.prompts).toHaveLength(1);

    // 没人在手机上等的完成结果也是终态，同样马上给秘书，只是不推手机
    const quiet = await desktop(false);
    expect(quiet.state.contact.milestones).toEqual([]);
    expect(quiet.state.prompts).toHaveLength(1);
    expect(quiet.state.prompts[0]).toContain('[goal-complete session:c1]');
  });

  it('系统回传注入的回合带上 delivery 与 turnId，应用里自己聊的不带', () => {
    const h = harness({ secretaryIds: ['sec-1'] });
    const secretary = (extra: Record<string, unknown> = {}) =>
      ({
        type: 'turn-completed',
        identity: { sessionId: 'sec-1', generation: 'g1' },
        seq: 1,
        ...extra,
      }) as unknown as RendererAgentEvent;
    h.state.file.inflight = {
      deliveryId: 'd1',
      secretaryConversationId: 'sec-1',
      keys: ['k1'],
      attempt: 1,
      nextAttemptAt: 0,
      started: true,
    };
    h.host.onAgentEvent(
      secretary({ turnId: 't9', digest: { userText: '回传', assistantText: '修好了' } }),
      []
    );
    h.host.onAgentEvent(
      secretary({ turnId: 't10', digest: { userText: '在吗', assistantText: '在' } }),
      []
    );
    expect(h.state.contact.replies).toEqual([
      { conversationId: 'sec-1', text: '修好了', delivery: true, turnId: 't9' },
      { conversationId: 'sec-1', text: '在', turnId: 't10' },
    ]);
  });

  it('派出会话的提问转给秘书时不打扰用户：手机渠道与桌面通知都不发', () => {
    const h = harness({});
    h.state.statuses.c1 = waiting;
    h.host.onAgentEvent(
      event('ask-request', {
        ask: {
          requestId: 'ask-1',
          question: '用哪个方案？',
          options: ['A', 'B'],
          relay: { name: '小秘' },
        },
      }),
      change('waiting', 'running')
    );
    h.host.onAgentEvent(
      event('ask-resolved', { requestId: 'ask-1', by: 'relay', answer: 'A', name: '小秘' }),
      change('running', 'waiting')
    );
    expect(Object.values(h.state.contact).flat()).toEqual([]);
    expect(h.state.notifications).toEqual([]);
  });

  it('秘书带关联转问 needsUser、用户答复后交给 answerNeedsUser；不带关联、非用户收尾、非秘书会话都不交', () => {
    const base = harness({ secretaryIds: ['sec-1'] });
    const answered: unknown[] = [];
    const host = createSecretaryHost({
      ...base.ports,
      answerNeedsUser: (link, answer, askedAt) => {
        answered.push({ link, answer, askedAt });
      },
    });
    const resolved = (sessionId: string, extra: Record<string, unknown>) =>
      ({
        type: 'ask-resolved',
        identity: { sessionId, generation: 'g1' },
        seq: 1,
        requestId: 'ask-9',
        ...extra,
      }) as unknown as RendererAgentEvent;
    const relatesTo = { conversationId: 'c1', needsUserIndex: 0 };

    host.onAgentEvent(resolved('sec-1', { by: 'user', answer: '清理' }), []);
    host.onAgentEvent(
      resolved('sec-1', { by: 'timeout', answer: '清理', relatesTo, askedAt: 5 }),
      []
    );
    host.onAgentEvent(resolved('sec-1', { relatesTo, askedAt: 5 }), []);
    host.onAgentEvent(resolved('c1', { by: 'user', answer: '清理', relatesTo, askedAt: 5 }), []);
    expect(answered).toEqual([]);

    host.onAgentEvent(resolved('sec-1', { by: 'user', answer: '清理', relatesTo, askedAt: 5 }), []);
    expect(answered).toEqual([{ link: relatesTo, answer: '清理', askedAt: 5 }]);
  });

  it('秘书带关联提问时就把那条 needsUser 升级给用户；不带关联、非秘书会话不升级', () => {
    const base = harness({ secretaryIds: ['sec-1'] });
    const escalated: unknown[] = [];
    const host = createSecretaryHost({
      ...base.ports,
      escalateNeedsUser: (link, text) => {
        escalated.push({ link, text });
      },
    });
    const request = (sessionId: string, ask: Record<string, unknown>) =>
      ({
        type: 'ask-request',
        identity: { sessionId, generation: 'g1' },
        seq: 1,
        ask: { requestId: 'ask-9', question: '要清理孤儿进程吗？', ...ask },
      }) as unknown as RendererAgentEvent;
    const relatesTo = { conversationId: 'c1', needsUserIndex: 0 };

    host.onAgentEvent(request('sec-1', {}), []);
    host.onAgentEvent(request('c1', { relatesTo }), []);
    expect(escalated).toEqual([]);

    host.onAgentEvent(request('sec-1', { relatesTo }), []);
    expect(escalated).toEqual([{ link: relatesTo, text: '要清理孤儿进程吗？' }]);
  });

  it('needsUser 筛选到点没处理：tick 重新发布一次工作台，让兜底卡片出现', () => {
    const h = harness({
      file: {
        dispatched: {
          c1: {
            conversationId: 'c1',
            projectId: 'p1',
            secretaryConversationId: 'sec-1',
            createdAt: 0,
            turn: 1,
            lastState: 'idle',
            lastEventAt: 0,
            lastResult: { kind: 'goal-complete', turn: 1, at: 1_000 },
            goalResult: { at: 1_000, result: { needsUser: ['删临时文件'] } },
          },
        },
      },
    });
    h.state.statuses.c1 = { state: 'idle', pendingAsks: 0, pendingApprovals: 0 };
    h.host.tick(1_000 + 10 * 60_000);
    const before = h.state.published;
    h.host.tick(1_000 + 20 * 60_000);
    expect(h.state.published).toBe(before);
    h.host.tick(1_000 + 30 * 60_000);
    expect(h.state.published).toBe(before + 1);
    h.host.tick(1_000 + 31 * 60_000);
    expect(h.state.published).toBe(before + 1);
  });

  it('秘书自己会话里的提问、收尾与审批都转发；别的会话不转发', () => {
    const h = harness({ secretaryIds: ['sec-1'] });
    const secretaryEvent = (type: string, extra: Record<string, unknown> = {}) =>
      ({
        type,
        identity: { sessionId: 'sec-1', generation: 'g1' },
        seq: 1,
        ...extra,
      }) as unknown as RendererAgentEvent;

    h.host.onAgentEvent(
      secretaryEvent('ask-request', {
        ask: { requestId: 'ask-9', question: '发版吗？', options: ['发', '不发'] },
      }),
      []
    );
    expect(h.state.contact.asks).toEqual([{ conversationId: 'sec-1', requestId: 'ask-9' }]);

    h.host.onAgentEvent(secretaryEvent('ask-resolved', { requestId: 'ask-9', by: 'user' }), []);
    expect(h.state.contact.resolved).toEqual([{ conversationId: 'sec-1', requestId: 'ask-9' }]);

    h.host.onAgentEvent(
      secretaryEvent('turn-completed', {
        digest: { userText: '在吗', assistantText: '在，刚把登录修完' },
      }),
      []
    );
    expect(h.state.contact.replies).toEqual([
      { conversationId: 'sec-1', text: '在，刚把登录修完' },
    ]);

    // 静默回合不发正文，一条都不推给手机
    h.host.onAgentEvent(
      secretaryEvent('turn-completed', {
        silent: true,
        digest: { userText: '巡检', assistantText: '巡检正常' },
      }),
      []
    );
    expect(h.state.contact.replies).toHaveLength(1);
    expect(h.state.contact.silent).toEqual([{ conversationId: 'sec-1' }]);

    // 不是秘书会话：一个都不发
    h.host.onAgentEvent(
      event('ask-request', { ask: { requestId: 'ask-2', question: '继续吗？' } }),
      change('waiting', 'running')
    );
    expect(h.state.contact.asks).toHaveLength(1);
  });

  it('回合开始与收尾都通知联系方式：running 起 typing，idle/failed 收掉', () => {
    const h = harness({ secretaryIds: ['sec-1'] });
    const secretary = (type: string, extra: Record<string, unknown> = {}) =>
      ({
        type,
        identity: { sessionId: 'sec-1', generation: 'g1' },
        seq: 1,
        ...extra,
      }) as unknown as RendererAgentEvent;
    const status = (value: string) =>
      h.host.onAgentEvent(secretary('status', { status: value }), []);

    h.host.onAgentEvent(
      secretary('message-upsert', {
        index: 0,
        message: { role: 'user', content: [{ type: 'text', text: '在吗' }] },
      }),
      []
    );
    status('running');
    status('idle');
    // 出错同样要收掉，不能留着续发
    status('running');
    status('failed');
    expect(h.state.contact.turns).toEqual([
      { conversationId: 'sec-1', kind: 'start' },
      { conversationId: 'sec-1', kind: 'end' },
      { conversationId: 'sec-1', kind: 'start' },
      { conversationId: 'sec-1', kind: 'end' },
    ]);

    // 别的会话的状态变化不碰联系方式
    h.host.onAgentEvent(
      { type: 'status', identity, seq: 2, status: 'running' } as unknown as RendererAgentEvent,
      []
    );
    expect(h.state.contact.turns).toHaveLength(4);
  });

  it('纯系统回传的回合不亮 typing：静默回合本来就不打扰', () => {
    const h = harness({ secretaryIds: ['sec-1'] });
    const secretary = (type: string, extra: Record<string, unknown> = {}) =>
      ({
        type,
        identity: { sessionId: 'sec-1', generation: 'g1' },
        seq: 1,
        ...extra,
      }) as unknown as RendererAgentEvent;

    h.host.onAgentEvent(
      secretary('message-upsert', {
        index: 0,
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<session-updates>\n- [goal-complete a] 完成\n</session-updates>',
            },
          ],
        },
      }),
      []
    );
    h.host.onAgentEvent(secretary('status', { status: 'running' }), []);
    expect(h.state.contact.turns.filter((turn) => turn.kind === 'start')).toEqual([]);

    // 用户自己打的字照常亮
    h.host.onAgentEvent(secretary('status', { status: 'idle' }), []);
    h.host.onAgentEvent(
      secretary('message-upsert', {
        index: 1,
        message: { role: 'user', content: [{ type: 'text', text: '在吗' }] },
      }),
      []
    );
    h.host.onAgentEvent(secretary('status', { status: 'running' }), []);
    expect(h.state.contact.turns.filter((turn) => turn.kind === 'start')).toEqual([
      { conversationId: 'sec-1', kind: 'start' },
    ]);
  });
});

describe('遗留后台任务', () => {
  const settledFile = (extra: Partial<DispatchRecord> = {}) => ({
    dispatched: {
      c1: {
        ...emptyFile().dispatched.c1,
        lastState: 'idle' as const,
        lastResult: { kind: 'goal-complete' as const, turn: 0, at: 0 },
        ...extra,
      },
    },
  });

  const task = (extra: Partial<ObservedTask> = {}): ObservedTask => ({
    taskId: 't1',
    command: 'python3 -m http.server 8931 --directory /tmp',
    status: 'running',
    startedAt: 0,
    ...extra,
  });

  it('已完成会话的常驻服务标成遗留，每小时只推一次', () => {
    const h = harness({ file: settledFile(), tasks: { c1: [task()] } });
    h.state.statuses.c1 = idle;
    h.state.now = 11 * MINUTE;
    h.host.tick();
    expect(h.state.file.dispatched.c1.leftoverTasks).toMatchObject({ count: 1 });
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['leftover']);
    expect(h.state.file.outbox[0]?.text).toContain('python3 -m http.server 8931');
    expect(h.state.file.outbox[0]?.text).toContain('已跑 11 分钟');

    // 同一批任务再扫一次：不重复推
    h.state.now = 12 * MINUTE;
    h.host.tick();
    expect(h.state.file.outbox).toHaveLength(1);
  });

  it('进程已不在的普通任务也算遗留，换了一批任务才再推', () => {
    const h = harness({
      file: settledFile(),
      tasks: { c1: [task({ command: 'pnpm typecheck && pnpm test', alive: false })] },
    });
    h.state.statuses.c1 = idle;
    h.state.now = 5 * MINUTE;
    h.host.tick();
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['leftover']);
    expect(h.state.file.outbox[0]?.text).toContain('进程已不在');

    // 换了任务：下一个小时点再推一条
    h.state.tasks.c1 = [task({ taskId: 't2', command: 'pnpm dev', startedAt: 0 })];
    h.state.now = 70 * MINUTE;
    h.host.tick();
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['leftover', 'leftover']);
  });

  it('遗留任务巡检跟着巡检开关走：关掉巡检后不再推', () => {
    const h = harness({ file: settledFile(), tasks: { c1: [task()] }, patrolEnabled: false });
    h.state.statuses.c1 = idle;
    h.state.now = 11 * MINUTE;
    h.host.tick();
    expect(h.state.file.outbox).toEqual([]);
  });

  it('旧档案里单独关掉的遗留任务巡检不再生效，巡检开着就推', () => {
    const h = harness({ file: settledFile(), tasks: { c1: [task()] } });
    const legacy = h.ports.profile;
    h.ports.profile = () => ({ ...legacy(), orphanTaskPatrol: false }) as never;
    h.state.statuses.c1 = idle;
    h.state.now = 11 * MINUTE;
    h.host.tick();
    expect(h.state.file.outbox.map((update) => update.kind)).toEqual(['leftover']);
  });

  it('会话还在跑时不标遗留，后台任务照常算在跑', () => {
    const h = harness({ file: settledFile({ lastResult: undefined }), tasks: { c1: [task()] } });
    h.state.statuses.c1 = running;
    h.state.now = MINUTE;
    h.host.tick();
    expect(h.state.file.dispatched.c1.leftoverTasks).toBeUndefined();
    expect(h.state.file.outbox).toEqual([]);
  });

  it('goal-complete 回传带上还在跑的后台任务', () => {
    const h = harness({ tasks: { c1: [task({ command: 'pnpm test' })] } });
    h.state.now = 5 * MINUTE;
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'goal-complete' });
    expect(h.state.file.outbox[0]?.text).toContain('还有 1 个后台任务在跑');
    expect(h.state.file.outbox[0]?.text).toContain('pnpm test');
  });
});

describe('派出会话的流式事件', () => {
  it('只刷新事件时刻时不逐条落盘和广播，过一段时间才补存一次', () => {
    const h = harness();
    let saves = 0;
    const save = h.ports.save;
    h.ports.save = (file) => {
      saves += 1;
      save(file);
    };
    h.state.now = 1_000;
    h.host.onAgentEvent(event('message-update'), []);
    const first = { saves, published: h.state.published };
    for (let i = 0; i < 20; i++) {
      h.state.now += 100;
      h.host.onAgentEvent(event('message-update'), []);
    }
    expect(saves).toBe(first.saves);
    expect(h.state.published).toBe(first.published);
    h.state.now += MINUTE;
    h.host.onAgentEvent(event('message-update'), []);
    expect(saves).toBe(first.saves + 1);
    expect(h.state.file.dispatched.c1?.lastEventAt).toBe(h.state.now);
  });

  it('补存由别的会话触发时，间隔里其他会话的事件时刻也一起落盘', () => {
    const c2 = { ...emptyFile().dispatched.c1, conversationId: 'c2' } as DispatchRecord;
    const h = harness({ file: { dispatched: { ...emptyFile().dispatched, c2 } } });
    h.state.rows.c2 = { id: 'c2', title: '另一个', projectId: 'p1', sessionFile: '/tmp/c2.jsonl' };
    h.state.statuses.c2 = running;
    const c2Event = (type: string) =>
      ({ type, identity: { sessionId: 'c2', generation: 'g2' }, seq: 1, turnId: 't2' }) as never;
    h.state.now = 1_000;
    h.host.onAgentEvent(event('message-update'), []);
    h.host.onAgentEvent(c2Event('message-update'), []);
    h.state.now = 20_000;
    h.host.onAgentEvent(c2Event('message-update'), []);
    h.state.now = 1_000 + MINUTE;
    h.host.onAgentEvent(event('message-update'), []);
    expect(h.state.file.dispatched.c1?.lastEventAt).toBe(1_000 + MINUTE);
    expect(h.state.file.dispatched.c2?.lastEventAt).toBe(20_000);
  });

  it('与派出、在途投递都无关的会话流式事件不读派发记录（整份近 1MB）', () => {
    const h = harness();
    let reads = 0;
    const file = h.ports.file;
    h.ports.file = () => {
      reads += 1;
      return file();
    };
    h.ports.peekFile = () => h.state.file;
    const other = (type: string) =>
      ({ type, identity: { sessionId: 'zz', generation: 'g9' }, seq: 1, turnId: 't9' }) as never;
    h.state.now = 1_000;
    for (const type of ['message-upsert', 'message-update', 'tool-output', 'session-meta'])
      h.host.onAgentEvent(other(type), []);
    expect(reads).toBe(0);
    // 派出会话的流式事件照常处理
    h.host.onAgentEvent(event('message-update'), []);
    expect(reads).toBeGreaterThan(0);
    expect(h.state.file.dispatched.c1?.lastEventAt).toBe(1_000);
  });
});

describe('优雅重启续跑的会话', () => {
  it('写进恢复清单、重启后接着跑：退出时的中断不报 interrupted / failed；清单外被杀掉的仍报 failed', () => {
    const h = harness({});
    h.ports.continuesAfterExit = (conversationId) => conversationId === 'c1';
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(
      event('turn-failed', { error: 'aborted', interrupted: { at: 1, kind: 'update' } }),
      change('idle', 'running')
    );
    h.host.onAgentEvent(
      { type: 'worker-exited' } as RendererAgentEvent,
      change('error', 'running')
    );
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.state.file.outbox).toEqual([]);

    const killed = harness({});
    killed.ports.continuesAfterExit = (conversationId) => conversationId === 'other';
    killed.state.statuses.c1 = error;
    killed.host.onAgentEvent(
      { type: 'worker-exited' } as RendererAgentEvent,
      change('error', 'running')
    );
    expect(killed.state.file.outbox[0]).toMatchObject({ kind: 'failed' });
  });

  it('启动恢复：冷启动正在续跑的会话不报中断', () => {
    const h = harness({});
    h.ports.coldResumed = (conversationId) => conversationId === 'c1';
    h.state.statuses.c1 = idle;
    h.host.recover();
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.state.file.dispatched.c1.lastState).toBe('running');
    expect(h.state.file.outbox).toEqual([]);
  });

  it('启动恢复：清单内会话在超时前保持进行中，恢复活轮次后走正常完成路径', () => {
    const h = harness({});
    h.state.todos = [
      { id: 't1', text: '监听事件按组认领', createdAt: 1, updatedAt: 1, conversationId: 'c1' },
    ];
    h.ports.coldResumed = (conversationId) => conversationId === 'c1';
    h.state.statuses.c1 = idle;
    h.state.now = 1_000;
    h.host.recover();
    expect(h.state.todos[0].problem).toBeUndefined();
    // 启动早期收到 parent-ready / tick 仍空闲：超时前不翻成 idle，也不报中断
    h.host.onAgentEvent(event('parent-ready'), []);
    h.state.now = 1_000 + 60_000;
    h.host.tick();
    expect(h.state.file.dispatched.c1.lastState).toBe('running');
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.state.todos[0].problem).toBeUndefined();
    expect(h.state.file.outbox).toEqual([]);
    const board = buildBoard(h.state.file, {
      rows: { c1: { ...h.state.rows.c1, sessionFile: '/tmp/c1.jsonl' } },
      statuses: h.state.statuses,
      projects: [],
      todos: h.state.todos,
    });
    expect(
      board.running.map((card) => (card.kind === 'session' ? card.conversationId : card.kind))
    ).toEqual(['c1']);
    expect(board.done).toEqual([]);
    expect(board.todos[0]).toMatchObject({ id: 't1', phase: 'active', sessionState: 'running' });
    expect(board.todos[0].problem).toBeUndefined();
    // 恢复成活的轮次后，正常完结照常走 goal-complete
    h.state.statuses.c1 = running;
    h.host.onAgentEvent(event('status', { status: 'running' }), change('running', 'idle'));
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', summary: '搞定' }), []);
    h.host.onAgentEvent(
      event('turn-completed', { digest: { assistantText: '全部完成' } }),
      change('idle', 'running')
    );
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-complete' });
    expect(h.state.file.outbox.map((u) => u.kind)).toEqual(['goal-complete']);
    expect(h.state.todos[0].doneAt).toBeDefined();
    expect(h.state.todos[0].problem).toBeUndefined();
  });

  it('启动恢复：清单内会话超过超时仍未恢复活轮次，推 interrupted 并说明原因', () => {
    const h = harness({});
    h.state.todos = [
      { id: 't1', text: '超时待办', createdAt: 1, updatedAt: 1, conversationId: 'c1' },
    ];
    h.ports.coldResumed = (conversationId) => conversationId === 'c1';
    h.state.statuses.c1 = idle;
    h.state.now = 1_000;
    h.host.recover();
    expect(h.state.todos[0].problem).toBeUndefined();
    h.state.now = 1_000 + 3 * 60_000;
    h.host.tick();
    expect(h.state.file.dispatched.c1.lastState).toBe('idle');
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'interrupted' });
    expect(h.state.todos[0].problem).toBe('stopped');
    expect(h.state.file.outbox).toHaveLength(1);
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'interrupted' });
    expect(h.state.file.outbox[0].text).toContain('超时');
  });

  it('启动恢复：不在恢复清单里（崩溃退出未写清单）立即推 interrupted 并说明原因', () => {
    const h = harness({});
    h.state.todos = [
      { id: 't1', text: '清单外待办', createdAt: 1, updatedAt: 1, conversationId: 'c1' },
    ];
    h.ports.coldResumed = () => false;
    h.state.statuses.c1 = idle;
    h.host.recover();
    expect(h.state.file.dispatched.c1.lastState).toBe('idle');
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'interrupted' });
    expect(h.state.todos[0].problem).toBe('stopped');
    expect(h.state.file.outbox).toHaveLength(1);
    expect(h.state.file.outbox[0].text).toContain('恢复清单');
  });

  it('已被误标成 problem/interrupted 的待办与会话：恢复运行后自动回到 active 与进行中，完成后回到 done', () => {
    const h = harness({
      file: emptyFile({
        dispatched: {
          c1: {
            conversationId: 'c1',
            projectId: 'p1',
            secretaryConversationId: 'sec1',
            createdAt: 0,
            turn: 1,
            lastState: 'idle',
            lastEventAt: 500,
            lastResult: { kind: 'interrupted', turn: 1, at: 500 },
          },
        },
      }),
    });
    h.state.todos = [
      {
        id: 't1',
        text: '被误标成出问题的待办',
        createdAt: 1,
        updatedAt: 500,
        conversationId: 'c1',
        problem: 'stopped',
      },
    ];
    h.state.statuses.c1 = running;
    h.state.now = 2_000;
    h.host.onAgentEvent(event('status', { status: 'running' }), change('running', 'idle'));
    expect(h.state.file.dispatched.c1.lastState).toBe('running');
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.state.todos[0].problem).toBeUndefined();
    const runningBoard = buildBoard(h.state.file, {
      rows: { c1: { ...h.state.rows.c1, sessionFile: '/tmp/c1.jsonl' } },
      statuses: h.state.statuses,
      projects: [],
      todos: h.state.todos,
    });
    expect(runningBoard.running).toHaveLength(1);
    expect(runningBoard.done).toEqual([]);
    expect(runningBoard.todos[0]).toMatchObject({
      id: 't1',
      phase: 'active',
      sessionState: 'running',
    });
    expect(runningBoard.todos[0].problem).toBeUndefined();

    // 之后完成目标 -> 自动回到 done
    h.state.statuses.c1 = idle;
    h.state.now = 3_000;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', summary: '完成' }), []);
    h.host.onAgentEvent(
      event('turn-completed', { digest: { assistantText: '已完成' } }),
      change('idle', 'running')
    );
    expect(h.state.todos[0].doneAt).toBe(3_000);
    expect(h.state.todos[0].problem).toBeUndefined();
  });

  it('父会话空闲但在等运行中的子代理时，tick 自动清掉误标的 problem/interrupted', () => {
    const h = harness({
      file: emptyFile({
        dispatched: {
          c1: {
            conversationId: 'c1',
            projectId: 'p1',
            secretaryConversationId: 'sec1',
            createdAt: 0,
            turn: 1,
            lastState: 'idle',
            lastEventAt: 500,
            lastResult: { kind: 'interrupted', turn: 1, at: 500 },
          },
        },
      }),
    });
    h.state.todos = [
      {
        id: 't1',
        text: '监听事件按组认领 + 需求线程关联表',
        createdAt: 1,
        updatedAt: 500,
        conversationId: 'c1',
        problem: 'stopped',
      },
    ];
    h.state.statuses.c1 = idle;
    h.ports.subagentsRunning = (id) => id === 'c1';
    h.state.now = 2_000;
    h.host.tick();
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.state.todos[0].problem).toBeUndefined();
  });

  it('自动巡检：父会话空闲但在等运行中的子代理时，不误判停滞', () => {
    const h = harness({});
    h.state.patrolEnabled = true;
    h.state.statuses.c1 = idle;
    h.state.subagents.c1 = true;
    h.state.rows.c1 = {
      ...h.state.rows.c1,
      goal: { text: '完成任务', status: 'active', autoTurns: 0 },
    };
    h.state.file.dispatched.c1.lastState = 'idle';
    h.state.file.dispatched.c1.lastEventAt = 1_000;
    h.state.now = 1_000 + 25 * 60_000;
    h.host.tick();
    expect(h.state.file.dispatched.c1.patrol).toBeUndefined();
    expect(h.state.file.outbox).toEqual([]);
  });

  it('续跑没接上：推 interrupted 并说明原因', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.state.now = 7000;
    h.host.onRestartResumeFailed('c1', 'spawn rejected: no model');
    h.host.onRestartResumeFailed('ghost', 'x');
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'interrupted', at: 7000 });
    expect(h.state.file.outbox).toHaveLength(1);
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'interrupted' });
    expect(h.state.file.outbox[0].text).toContain('spawn rejected: no model');
  });

  it('清单内会话续跑时 spawn 被 worker 拒绝：报一次 interrupted 并说明原因，不重复推送', () => {
    const h = harness({});
    h.ports.coldResumed = (conversationId) => conversationId === 'c1';
    h.state.statuses.c1 = idle;
    h.host.recover();
    h.host.onAgentEvent(
      {
        type: 'parent-rejected',
        identity: { sessionId: 'c1', generation: 'g1' },
        seq: 0,
        reason: 'model unavailable',
      } as RendererAgentEvent,
      []
    );
    h.host.onRestartResumeFailed('c1', 'model unavailable');
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'interrupted' });
    expect(h.state.file.outbox).toHaveLength(1);
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'interrupted' });
    expect(h.state.file.outbox[0].text).toContain('model unavailable');
  });
});

describe('派出会话完成后不再自动归档', () => {
  /** 接上归档端口：写进和用户手动归档同一份会话行 */
  function archiving(options: Parameters<typeof harness>[0] = {}) {
    const h = harness(options);
    h.state.rows.c1 = { ...h.state.rows.c1, secretaryOrigin: { secretaryConversationId: 'sec1' } };
    let viewing: string | null = null;
    h.ports.archive = (conversationId, at) => {
      h.state.rows[conversationId] = {
        ...h.state.rows[conversationId],
        archived: true,
        archivedAt: at,
      };
    };
    h.ports.unarchive = (conversationId) => {
      const { archived: _a, archivedAt: _b, ...rest } = h.state.rows[conversationId] ?? {};
      h.state.rows[conversationId] = rest;
    };
    h.ports.viewed = (conversationId) => viewing === conversationId;
    return {
      ...h,
      view: (conversationId: string | null) => {
        viewing = conversationId;
      },
    };
  }

  function complete(h: Harness, now: number): void {
    h.state.now = now;
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    h.host.onAgentEvent(
      event('turn-completed', { digest: { assistantText: '做完了' } }),
      change('idle', 'running')
    );
  }

  function wake(h: Harness, now: number): void {
    h.state.now = now;
    h.state.statuses.c1 = running;
    h.host.onAgentEvent(event('status', { status: 'running' }), change('running', 'idle'));
  }

  it('满足原自动归档的全部条件也不归档：完成、空闲、无待处理、无任务、无提醒、没在看', () => {
    const h = archiving();
    h.state.rows.c1 = { ...h.state.rows.c1, archived: false };
    h.ports.reminders = () => [];
    complete(h, 1000);
    h.host.tick(2000);
    h.host.sweepAutoArchive(3000);
    h.host.recover();
    expect(h.state.rows.c1.archived).toBe(false);
    expect(h.state.rows.c1.archivedAt).toBeUndefined();
    expect(h.state.file.dispatched.c1.lastResult?.kind).toBe('goal-complete');
    expect(h.state.file.dispatched.c1.autoArchivedAt).toBeUndefined();
    expect(h.state.audit.some((entry) => entry.op.startsWith('auto_archive'))).toBe(false);
  });

  it('用户手动归档的：被唤醒也不自动恢复', () => {
    const h = archiving();
    h.state.rows.c1 = { ...h.state.rows.c1, archived: true, archivedAt: 500 };
    complete(h, 1000);
    expect(h.state.rows.c1.archivedAt).toBe(500);
    wake(h, 2000);
    expect(h.state.rows.c1).toMatchObject({ archived: true, archivedAt: 500 });
  });

  const runningTask = (overrides: Partial<ObservedTask> = {}): ObservedTask => ({
    taskId: 't1',
    status: 'running',
    command: 'node host.mjs',
    startedAt: 0,
    ...overrides,
  });

  /** 回退前已经被自动归档的派出会话：历史归档原样保留，只在被唤醒或有任务在跑时收回 */
  function misarchived(tasks: ObservedTask[]) {
    const h = archiving({ tasks: { c1: tasks } });
    h.state.statuses.c1 = idle;
    h.state.rows.c1 = { ...h.state.rows.c1, archived: true, archivedAt: 1000 };
    h.state.file.dispatched.c1 = {
      ...h.state.file.dispatched.c1,
      lastState: 'idle',
      lastResult: { kind: 'goal-complete', turn: 1, at: 900 },
      autoArchivedAt: 1000,
      autoArchiveResultAt: 900,
    };
    return h;
  }

  it('以前自动归档的会话：没被唤醒、没有任务时保持归档', () => {
    const h = misarchived([]);
    h.host.recover();
    h.host.tick(2000);
    h.host.sweepAutoArchive(3000);
    expect(h.state.rows.c1).toMatchObject({ archived: true, archivedAt: 1000 });
  });

  it('以前自动归档的会话被唤醒：回到活跃中，这一轮再完成也不归档', () => {
    const h = misarchived([]);
    wake(h, 2000);
    expect(h.state.rows.c1.archived).toBeUndefined();
    expect(h.state.rows.c1.archivedAt).toBeUndefined();
    expect(h.state.file.dispatched.c1.autoArchivedAt).toBeUndefined();
    expect(h.state.audit.some((entry) => entry.op === 'auto_unarchive')).toBe(true);
    complete(h, 3000);
    h.host.tick(4000);
    expect(h.state.rows.c1.archived).toBeUndefined();
  });

  it('以前自动归档后用户又手动归档过：时间对不上，不算自动归档，唤醒不恢复', () => {
    const h = misarchived([]);
    h.state.rows.c1 = { ...h.state.rows.c1, archived: true, archivedAt: 1500 };
    wake(h, 2000);
    expect(h.state.rows.c1).toMatchObject({ archived: true, archivedAt: 1500 });
  });

  it('被误归档、仍有任务在跑：启动时恢复到活跃中并记审计，任务结束后也不再归档', () => {
    const h = misarchived([runningTask({ kept: true })]);
    h.state.now = 5000;
    h.host.recover();
    expect(h.state.rows.c1.archived).toBeUndefined();
    expect(h.state.file.dispatched.c1.autoArchivedAt).toBeUndefined();
    const restored = h.state.audit.filter((entry) => entry.op === 'auto_unarchive');
    expect(restored).toHaveLength(1);
    expect(restored[0].detail).toContain('t1');
    h.state.tasks.c1 = [runningTask({ status: 'done' })];
    h.host.tick(6000);
    expect(h.state.rows.c1.archived).toBeUndefined();
  });

  it('被误归档的会话：后台任务状态一变（没打开的会话也算）就恢复', () => {
    const h = misarchived([]);
    h.host.tick(2000);
    expect(h.state.rows.c1.archived).toBe(true);
    h.state.tasks.c1 = [runningTask()];
    h.state.now = 3000;
    h.host.onAgentEvent(
      {
        type: 'unopened-background-tasks',
        sessionId: 'c1',
        tasks: [],
      } as unknown as RendererAgentEvent,
      []
    );
    expect(h.state.rows.c1.archived).toBeUndefined();
    expect(h.state.audit.some((entry) => entry.op === 'auto_unarchive')).toBe(true);
  });

  it('worker 还没报上来任务表：不按空任务表恢复或收走', () => {
    const h = misarchived([runningTask()]);
    h.ports.tasksReported = () => false;
    h.host.recover();
    expect(h.state.rows.c1).toMatchObject({ archived: true, archivedAt: 1000 });
  });

  it('用户手动归档的：有任务在跑也不自动恢复', () => {
    const h = misarchived([runningTask()]);
    delete h.state.file.dispatched.c1.autoArchivedAt;
    h.state.rows.c1 = { ...h.state.rows.c1, archived: true, archivedAt: 700 };
    h.host.recover();
    h.host.tick(2000);
    expect(h.state.rows.c1).toMatchObject({ archived: true, archivedAt: 700 });
    expect(h.state.audit.some((entry) => entry.op === 'auto_unarchive')).toBe(false);
  });
});

describe('排队会话', () => {
  const queuedRow = (extra: Record<string, unknown> = {}) => ({
    id: 'c1',
    title: '排队的',
    projectId: 'p1',
    secretaryOrigin: { secretaryConversationId: 'sec1' },
    queuedStart: { queuedAt: 0, text: '修构建', ...extra },
  });
  const queuedFile = () => ({
    dispatched: {
      c1: {
        conversationId: 'c1',
        projectId: 'p1',
        secretaryConversationId: 'sec1',
        createdAt: 0,
        turn: 0,
        lastState: 'idle' as const,
        lastEventAt: 0,
      },
    },
  });

  it('每分钟检查时让启动泵补位', () => {
    const h = harness({});
    let drains = 0;
    h.ports.drainQueued = () => {
      drains += 1;
    };
    h.host.tick(MINUTE);
    expect(drains).toBe(1);
  });

  it('派出会话一轮结束：可能空出名额，让启动泵补位', () => {
    const h = harness({});
    let drains = 0;
    h.ports.drainQueued = () => {
      drains += 1;
    };
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(drains).toBe(1);
  });

  it('排队会话的 spawn 被拒：由启动泵标失败并回传，这里不再记一次', () => {
    const h = harness({ file: queuedFile() });
    h.state.rows.c1 = queuedRow({ startingAt: 0 });
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(
      {
        type: 'parent-rejected',
        identity,
        seq: 0,
        reason: 'model unavailable',
      } as RendererAgentEvent,
      []
    );
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.state.file.outbox).toEqual([]);
  });

  it('巡检不把排队很久的会话报成停住或空闲', () => {
    const h = harness({ file: queuedFile() });
    h.state.rows.c1 = queuedRow();
    h.state.statuses.c1 = idle;
    h.host.tick(5 * 60 * MINUTE);
    h.host.tick(6 * 60 * MINUTE);
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.state.file.dispatched.c1.patrol).toBeUndefined();
    expect(h.state.file.outbox).toEqual([]);
  });

  it('启动恢复不把排队会话报成中断', () => {
    const h = harness({ file: queuedFile() });
    h.state.rows.c1 = queuedRow();
    h.state.statuses.c1 = idle;
    h.host.recover();
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.state.file.outbox).toEqual([]);
  });

  it('排队会话不自动归档', () => {
    const h = harness({ file: queuedFile() });
    const archived: string[] = [];
    h.ports.archive = (conversationId) => {
      archived.push(conversationId);
    };
    h.state.rows.c1 = queuedRow();
    h.state.file.dispatched.c1.lastResult = { kind: 'goal-complete', turn: 0, at: 0 };
    h.state.statuses.c1 = idle;
    h.host.tick(MINUTE);
    expect(archived).toEqual([]);
  });
});

describe('结构化目标结果', () => {
  const result = { summary: 'shipped', commits: ['abc1234'] };
  const checks = [{ kind: 'commit' as const, ref: 'abc1234', status: 'verified' as const }];

  it('核验先完成时，完成回传带上 result 和 checks', async () => {
    const h = harness({});
    const daily: unknown[] = [];
    const archived: unknown[][] = [];
    h.ports.verifyGoalResult = async () => checks;
    h.ports.recordDaily = (entry) => {
      daily.push(entry);
    };
    h.ports.archiveReport = (...args) => {
      archived.push(args);
    };
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok', result }), []);
    await Promise.resolve();
    await Promise.resolve();
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.outbox[0]).toMatchObject({
      kind: 'goal-complete',
      goalResult: { result, checks, at: 0 },
    });
    expect(h.state.file.dispatched.c1.goalResult).toMatchObject({ result, checks });
    expect(daily[0]).toMatchObject({ kind: 'goal-complete', goalResult: { result, checks } });
    expect(archived[0]?.[3]).toMatchObject({ goalResult: { result, checks } });
  });

  it('goal-complete 带 goalResult 时，动态末条记下 needsUser 和 summary', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(
      event('goal-signal', {
        kind: 'complete',
        note: 'ok',
        result: {
          summary: `shipped ${secret}`,
          needsUser: [`确认 ${secret}`],
        },
      }),
      []
    );
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    const last = h.state.file.activity?.at(-1);
    expect(last).toMatchObject({
      kind: 'goal-complete',
      conversationId: 'c1',
      needsUser: ['确认 [REDACTED]'],
      summary: 'shipped [REDACTED]',
    });
    expect(JSON.stringify(last)).not.toContain(secret);
  });

  it('核验一直不返回时，到点仍记完成并标核验超时', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({});
      h.ports.verifyGoalResult = () => new Promise(() => {});
      h.state.statuses.c1 = idle;
      h.state.rows.c1 = { ...h.state.rows.c1, goal: { text: 'g', status: 'complete' } };
      h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok', result }), []);
      h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
      expect(h.state.file.outbox).toEqual([]);
      expect((h.state.file.activity ?? []).map((entry) => entry.kind)).not.toContain('turn-ended');
      await vi.advanceTimersByTimeAsync(8_000);
      expect(h.state.file.outbox[0]).toMatchObject({
        kind: 'goal-complete',
        goalResult: {
          result,
          checks: [{ kind: 'commit', ref: 'abc1234', status: 'unverifiable', detail: '核验超时' }],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('没有 result 时完成回传不带 goalResult', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok' }), []);
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.outbox[0]).toMatchObject({ kind: 'goal-complete' });
    expect(h.state.file.outbox[0]).not.toHaveProperty('goalResult');
  });

  it('轮次被中止后，迟到的核验不再记完成', async () => {
    const h = harness({});
    let resolveVerify: (value: typeof checks) => void = () => {};
    h.ports.verifyGoalResult = () =>
      new Promise((resolve) => {
        resolveVerify = resolve;
      });
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'ok', result }), []);
    h.host.onAgentEvent(event('turn-completed', { aborted: true }), change('idle', 'running'));
    resolveVerify(checks);
    await Promise.resolve();
    expect(h.state.file.outbox.map((update) => update.kind)).not.toContain('goal-complete');
  });
});

describe('看板与终态防回拉/防误报失败', () => {
  it('手动标完成后，后续迟到的 goal-blocked / turn-ended / failed 不把状态拉回也不写 daily', () => {
    const daily: unknown[] = [];
    const h = harness({});
    h.ports.recordDaily = (entry) => daily.push(entry);
    h.state.file.dispatched.c1.lastResult = {
      kind: 'goal-complete',
      turn: 1,
      at: 500,
      manual: true,
    };
    h.state.file.dispatched.c1.lastState = 'idle';
    h.state.statuses.c1 = idle;

    h.host.onAgentEvent(event('goal-signal', { kind: 'blocked', note: '核验缺输出' }), []);
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    h.state.statuses.c1 = error;
    h.host.onAgentEvent(event('turn-failed', { error: 'late' }), change('error', 'running'));

    expect(h.state.file.dispatched.c1.lastResult).toEqual({
      kind: 'goal-complete',
      turn: 1,
      at: 500,
      manual: true,
    });
    expect(daily).toEqual([]);
  });

  it('主动停止（stoppedAt）后滞后的 turn-failed / worker 报错不记 failed；用户手动 abort 也记 stoppedAt', () => {
    const daily: unknown[] = [];
    const h = harness({});
    h.ports.recordDaily = (entry) => daily.push(entry);
    h.state.file.dispatched.c1.stoppedAt = 800;
    h.state.statuses.c1 = error;
    h.host.onAgentEvent(
      event('turn-failed', { error: 'aborted by user' }),
      change('error', 'running')
    );
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();
    expect(daily).toEqual([]);

    // 用户在界面手动 abort：记 stoppedAt，不算失败
    const h2 = harness({});
    h2.state.statuses.c1 = idle;
    h2.host.onAgentEvent(event('turn-completed', { aborted: true }), change('idle', 'running'));
    expect(h2.state.file.dispatched.c1.stoppedAt).toBe(h2.state.now);
    expect(h2.state.file.dispatched.c1.lastResult).toBeUndefined();
  });

  it('上游 503 failed 后重试重新运行并完成：重跑时清掉旧 failed，最终以 goal-complete 为准', () => {
    const daily: { kind: string; at: number }[] = [];
    const h = harness({});
    h.ports.recordDaily = (entry) => daily.push({ kind: entry.kind, at: entry.at });
    h.state.statuses.c1 = error;
    h.host.onAgentEvent(
      event('turn-failed', { error: '503 Service Unavailable' }),
      change('error', 'running')
    );
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'failed' });

    // 重试开始跑：立刻清掉旧 failed
    h.state.now += 1000;
    h.state.statuses.c1 = running;
    h.host.onAgentEvent(event('status', { status: 'running' }), change('running', 'error'));
    expect(h.state.file.dispatched.c1.lastResult).toBeUndefined();

    // 重试成功并完成
    h.state.now += 5000;
    h.state.statuses.c1 = idle;
    h.host.onAgentEvent(event('goal-signal', { kind: 'complete', note: 'done' }), []);
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-complete' });
    expect(daily.map((d) => d.kind)).toEqual(['failed', 'goal-complete']);
  });

  it('会话处于 running（含重启续跑无边沿变化与旧 goal-complete(needsUser) 重跑）时清掉过时 lastResult', () => {
    // 场景 1：重启续跑时 status 已经是 running 且无 previous !== running 边沿事件，旧 needs-user 仍会被清掉
    const h1 = harness({});
    h1.state.file.dispatched.c1.lastState = 'running';
    h1.state.file.dispatched.c1.lastResult = { kind: 'needs-user', turn: 1, at: 100 };
    h1.state.statuses.c1 = running;
    h1.host.onAgentEvent(event('text-delta', { text: '继续跑测试' }), []);
    expect(h1.state.file.dispatched.c1.lastResult).toBeUndefined();

    // 场景 2：上一轮 goal-complete 带 needsUser，随后重新进入 running 时清掉旧结果与 goalResult
    const h2 = harness({});
    h2.state.file.dispatched.c1.lastState = 'idle';
    h2.state.file.dispatched.c1.lastResult = { kind: 'goal-complete', turn: 1, at: 100 };
    h2.state.file.dispatched.c1.goalResult = {
      at: 100,
      result: { summary: '待拍板', needsUser: ['确认方案'] },
    };
    h2.state.statuses.c1 = running;
    h2.host.onAgentEvent(event('status', { status: 'running' }), change('running', 'idle'));
    expect(h2.state.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h2.state.file.dispatched.c1.goalResult).toBeUndefined();
  });

  it('手动标完成或后续新 goal-complete(无 needsUser) 后，旧 goalResult.needsUser 和迟到核验不会把卡片拉回需要你', async () => {
    // 场景 1：在途 goalVerify 还没返回前被手动标记完成，迟到的核验结果不能覆写 manual: true
    const h1 = harness({});
    let resolveVerify: (value: { kind: 'commit'; ref: string; status: 'verified' }[]) => void =
      () => {};
    h1.ports.verifyGoalResult = () =>
      new Promise((resolve) => {
        resolveVerify = resolve;
      });
    h1.state.statuses.c1 = idle;
    h1.host.onAgentEvent(
      event('goal-signal', {
        kind: 'complete',
        note: 'ok',
        result: { summary: '待拍板', needsUser: ['确认部署'] },
      }),
      []
    );
    h1.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    h1.state.now += 1000;
    h1.state.file.dispatched.c1.lastResult = {
      kind: 'goal-complete',
      turn: h1.state.file.dispatched.c1.turn,
      at: h1.state.now,
      manual: true,
    };
    resolveVerify([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h1.state.file.dispatched.c1.lastResult).toMatchObject({
      kind: 'goal-complete',
      manual: true,
    });
    expect(h1.state.file.dispatched.c1.goalResult).toBeUndefined();

    // 场景 2：上一轮 goal-complete 带 needsUser 且已「知道了」，新结果 goal-complete 不带 goalResult 时清除旧 goalResult
    const h2 = harness({});
    h2.state.file.dispatched.c1.turn = 1;
    h2.state.file.dispatched.c1.lastResult = {
      kind: 'goal-complete',
      turn: 1,
      at: 100,
      dismissed: true,
    };
    h2.state.file.dispatched.c1.goalResult = {
      at: 100,
      result: { summary: '旧结果', needsUser: ['旧待确认'] },
    };
    h2.state.statuses.c1 = idle;
    h2.host.onAgentEvent(
      event('goal-signal', { kind: 'complete', note: '新结果无 needsUser' }),
      []
    );
    h2.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h2.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-complete' });
    expect(h2.state.file.dispatched.c1.goalResult).toBeUndefined();
  });
});
