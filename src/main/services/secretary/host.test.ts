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
import { describe, expect, it } from 'vitest';
import type { ObservedTask } from '../backgroundTaskTracker';
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
    /** 会话的后台任务投影 */
    tasks: Record<string, ObservedTask[]>;
    /** 主会话名下还没回来的子代理 Run */
    subagents: Record<string, boolean>;
    /** 上次应用退出打断这一轮的原因（启动恢复用） */
    interruptDetails: Record<string, string>;
    contact: {
      milestones: { kind: string; title: string; conversationId: string; lastText?: string }[];
      relayAsks: { conversationId: string; question: string; label: string }[];
      asks: { conversationId: string; requestId: string }[];
      resolved: { conversationId: string; requestId: string }[];
      replies: { conversationId: string; text: string; delivery?: boolean; turnId?: string }[];
      silent: { conversationId: string; updates: number }[];
      turns: { conversationId: string; kind: 'start' | 'end' }[];
      cards: { count: number; approval?: boolean; conversationId?: string }[];
      approvalsResolved: string[];
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
      relayAsks: [],
      asks: [],
      resolved: [],
      replies: [],
      silent: [],
      turns: [],
      cards: [],
      approvalsResolved: [],
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
      onRelayAsk: (input) => {
        state.contact.relayAsks.push(input);
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
      onTurnSilent: (conversationId, updates) => {
        state.contact.silent.push({ conversationId, updates });
      },
      onCardWaiting: (input) => {
        state.contact.cards.push(input);
      },
      onApprovalResolved: (conversationId) => {
        state.contact.approvalsResolved.push(conversationId);
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
});

describe('被 session_send 重新唤起后的收口', () => {
  /** 已经 goal-complete 的会话又被唤起：reopenedAt 已记，lastState 标回运行中 */
  const reopened = (over: Partial<DispatchRecord> = {}) => ({
    dispatched: {
      c1: {
        ...emptyFile().dispatched.c1,
        turn: 2,
        lastState: 'running' as const,
        lastResult: { kind: 'goal-complete' as const, turn: 2, at: 10 },
        reopenedAt: 20,
        ...over,
      },
    },
  });

  it('这一轮以 turn-ended 收尾、会话空闲：回到原来的完成，不重复推送', () => {
    const h = harness({ file: reopened() });
    h.state.statuses.c1 = idle;
    h.state.now = 30;
    h.host.onAgentEvent(event('turn-completed'), change('idle', 'running'));
    expect(h.state.file.dispatched.c1.lastResult).toEqual({
      kind: 'goal-complete',
      turn: 3,
      at: 30,
    });
    expect(h.state.file.dispatched.c1.lastState).toBe('idle');
    expect(h.state.file.dispatched.c1.reopenedAt).toBeUndefined();
    expect(h.state.file.outbox).toEqual([]);
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

  it('静默回合把这一批回传的条数交给手机，批次照常结算', () => {
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
    expect(h.state.contact.silent).toEqual([{ conversationId: 'sec1', updates: 3 }]);
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

  it('派出会话的提问转给秘书时，手机上也提示一条', () => {
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
    expect(h.state.contact.relayAsks).toEqual([
      expect.objectContaining({ conversationId: 'c1', question: '用哪个方案？' }),
    ]);
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

    h.host.onAgentEvent(secretaryEvent('approval-request', { request: { requestId: 'ap-1' } }), []);
    expect(h.state.contact.cards).toEqual([{ count: 1, approval: true, conversationId: 'sec-1' }]);

    h.host.onAgentEvent(
      secretaryEvent('turn-completed', {
        digest: { userText: '在吗', assistantText: '在，刚把登录修完' },
      }),
      []
    );
    expect(h.state.contact.replies).toEqual([
      { conversationId: 'sec-1', text: '在，刚把登录修完' },
    ]);

    // 静默回合不发正文，只把这一批回传的条数交出去
    h.host.onAgentEvent(
      secretaryEvent('turn-completed', {
        silent: true,
        digest: { userText: '巡检', assistantText: '巡检正常' },
      }),
      []
    );
    expect(h.state.contact.replies).toHaveLength(1);
    expect(h.state.contact.silent).toEqual([{ conversationId: 'sec-1', updates: 0 }]);

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
    expect(h.state.file.outbox).toEqual([]);
  });

  it('续跑没接上：报 failed 并说明原因', () => {
    const h = harness({});
    h.state.statuses.c1 = idle;
    h.state.now = 7000;
    h.host.onRestartResumeFailed('c1', 'spawn rejected: no model');
    h.host.onRestartResumeFailed('ghost', 'x');
    expect(h.state.file.dispatched.c1.lastResult).toMatchObject({ kind: 'failed', at: 7000 });
    expect(h.state.file.outbox).toHaveLength(1);
    expect(h.state.file.outbox[0].text).toContain('spawn rejected: no model');
  });
});
