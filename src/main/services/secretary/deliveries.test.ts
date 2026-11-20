import type { ConversationAuthority, ProjectAuthority } from '@shared/types/agent';
import type { SecretaryDispatchFile, SecretaryUpdate } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_IDLE_GRACE_MS,
  type DeliveryPorts,
  flushDeliveries,
  recoverDeliveries,
  resolveTarget,
  settleDelivery,
} from './deliveries';
import { closeRelayAsk, openRelayAsk } from './relay';

const idle = { state: 'idle' as const, pendingAsks: 0, pendingApprovals: 0 };
const running = { state: 'running' as const, pendingAsks: 0, pendingApprovals: 0 };

const projects: ProjectAuthority[] = [
  { projectId: 'sec', canonicalPath: '/tmp/sec', state: 'active', kind: 'secretary' },
  { projectId: 'p1', canonicalPath: '/tmp/p1', state: 'active' },
] as ProjectAuthority[];

function conversations(...ids: string[]): ConversationAuthority[] {
  return ids.map((conversationId) => ({
    conversationId,
    projectId: conversationId.startsWith('sec') ? 'sec' : 'p1',
    kind: 'root',
    version: 1,
  })) as unknown as ConversationAuthority[];
}

function update(extra: Partial<SecretaryUpdate> = {}): SecretaryUpdate {
  return {
    key: 'k1',
    at: 0,
    text: 'line',
    kind: 'turn-ended',
    conversationId: 'c1',
    secretaryConversationId: 'sec1',
    ...extra,
  } as SecretaryUpdate;
}

function emptyFile(extra: Partial<SecretaryDispatchFile> = {}): SecretaryDispatchFile {
  return { version: 1, dispatched: {}, named: [], proposals: {}, outbox: [], ...extra };
}

interface Harness {
  ports: DeliveryPorts;
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
    alive: Record<string, boolean>;
    prompts: { conversationId: string; text: string; deliveryId: string }[];
    resumed: string[];
  };
}

function harness(options: {
  file?: Partial<SecretaryDispatchFile>;
  rows?: Record<string, Record<string, unknown>>;
  statuses?: Harness['state']['statuses'];
  alive?: Record<string, boolean>;
  conversations?: ConversationAuthority[];
}): Harness {
  const state: Harness['state'] = {
    file: emptyFile(options.file),
    rows: options.rows ?? {
      sec1: { id: 'sec1', title: '秘书', projectId: 'sec', lastActiveAt: 10 },
      sec2: { id: 'sec2', title: '另一个秘书', projectId: 'sec', lastActiveAt: 20 },
    },
    statuses: options.statuses ?? { sec1: idle, sec2: idle },
    alive: options.alive ?? { sec1: true, sec2: true },
    prompts: [],
    resumed: [],
  };
  let seq = 0;
  const ports: DeliveryPorts = {
    file: () => structuredClone(state.file),
    save: (file) => {
      state.file = structuredClone(file);
    },
    rows: () => structuredClone(state.rows),
    conversations: () => options.conversations ?? conversations('sec1', 'sec2'),
    projects: () => projects,
    status: (id) => state.statuses[id] ?? idle,
    alive: (id) => state.alive[id] === true,
    prompt: (conversationId, text, deliveryId) => {
      state.prompts.push({ conversationId, text, deliveryId });
      return { ok: true };
    },
    resume: async (id) => {
      state.resumed.push(id);
      state.alive[id] = true;
      return { ok: true };
    },
    newId: () => `id-${++seq}`,
  };
  return { ports, state };
}

describe('目标秘书会话解析', () => {
  it('优先投给发起者', () => {
    const h = harness({});
    expect(resolveTarget(h.ports, 'sec1')).toBe('sec1');
  });

  it('发起者已归档或删除时改投最近活跃的秘书会话', () => {
    const h = harness({
      rows: {
        sec1: { id: 'sec1', projectId: 'sec', archived: true, lastActiveAt: 99 },
        sec2: { id: 'sec2', projectId: 'sec', lastActiveAt: 20 },
      },
    });
    expect(resolveTarget(h.ports, 'sec1')).toBe('sec2');
    expect(resolveTarget(h.ports, 'gone')).toBe('sec2');
  });

  it('一个秘书会话都没有时返回空', () => {
    const h = harness({ rows: {}, conversations: [] });
    expect(resolveTarget(h.ports, 'sec1')).toBeNull();
  });

  it('多秘书：回落只在本秘书的会话里找，不投给别的秘书', () => {
    const projectsWithTwo = [
      ...projects,
      { projectId: 'sec-b', canonicalPath: '/tmp/sec-b', state: 'active', kind: 'secretary' },
    ] as ProjectAuthority[];
    const h = harness({
      rows: {
        sec1: { id: 'sec1', projectId: 'sec', archived: true, lastActiveAt: 5 },
        other: { id: 'other', projectId: 'sec-b', lastActiveAt: 99 },
      },
      conversations: [
        ...conversations('sec1'),
        { conversationId: 'other', projectId: 'sec-b', kind: 'root', version: 1 },
      ] as unknown as ConversationAuthority[],
    });
    const own = { ...h.ports, projects: () => projectsWithTwo, secretaryProjectId: () => 'sec' };
    // 发起会话已归档、本秘书没有别的会话：只更新工作台，不改投给 B 的会话
    expect(resolveTarget(own, 'sec1')).toBeNull();
    const other = { ...own, secretaryProjectId: () => 'sec-b' };
    expect(resolveTarget(other, 'sec1')).toBe('other');
  });
});

describe('注入', () => {
  it('目标空闲时合并注入一条 session-updates，并记下在途批次', async () => {
    const h = harness({ file: { outbox: [update()] } });
    await flushDeliveries(h.ports, 1000);
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.prompts[0]).toMatchObject({ conversationId: 'sec1', deliveryId: 'id-1' });
    expect(h.state.prompts[0].text).toContain('<session-updates>');
    expect(h.state.file.inflight).toMatchObject({
      secretaryConversationId: 'sec1',
      keys: ['k1'],
      attempt: 1,
      nextAttemptAt: 31_000,
    });
  });

  it('静音的派出会话照样把结果推给秘书', async () => {
    const h = harness({
      file: { outbox: [update()] },
      rows: {
        sec1: { id: 'sec1', title: '秘书', projectId: 'sec', lastActiveAt: 10 },
        c1: { id: 'c1', projectId: 'p1', muted: true, autoRejectApprovals: true },
      },
    });
    await flushDeliveries(h.ports, 1000);
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.prompts[0].text).toContain('<session-updates>');
    expect(h.state.prompts[0].text).toContain('session:c1');
  });

  it('目标正在跑时不注入，留到下一轮', async () => {
    const h = harness({ file: { outbox: [update()] }, statuses: { sec1: running } });
    await flushDeliveries(h.ports, 1000);
    expect(h.state.prompts).toHaveLength(0);
    expect(h.state.file.inflight).toBeUndefined();
    expect(h.state.file.outbox).toHaveLength(1);
  });

  it('worker 已释放时先恢复再注入', async () => {
    const h = harness({ file: { outbox: [update()] }, alive: { sec1: false } });
    await flushDeliveries(h.ports, 1000);
    expect(h.state.resumed).toEqual(['sec1']);
    expect(h.state.prompts).toHaveLength(1);
  });

  it('恢复期间再次触发投递也只注入一次', async () => {
    const h = harness({ file: { outbox: [update()] }, alive: { sec1: false } });
    await Promise.all([flushDeliveries(h.ports, 1000), flushDeliveries(h.ports, 1000)]);
    expect(h.state.prompts).toHaveLength(1);
  });

  it('恢复一直失败时同样按 6 次上限放弃注入，只留工作台', async () => {
    const h = harness({ file: { outbox: [update()] }, alive: { sec1: false } });
    h.ports.resume = async () => ({ ok: false, error: 'boom' });
    let now = 1000;
    for (let i = 0; i < 10; i++) {
      await flushDeliveries(h.ports, now);
      now += 10 * 60 * 60 * 1000;
    }
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.file.inflight).toBeUndefined();
  });

  it('没有秘书会话时只更新工作台，不注入也不丢结果', async () => {
    const h = harness({ file: { outbox: [update()] }, rows: {}, conversations: [] });
    await flushDeliveries(h.ports, 1000);
    expect(h.state.prompts).toHaveLength(0);
    expect(h.state.file.outbox).toHaveLength(1);
  });
});

describe('转交提问回到发起的秘书会话', () => {
  const record = {
    conversationId: 'c1',
    projectId: 'p1',
    secretaryConversationId: 'sec1',
    createdAt: 0,
    turn: 0,
    lastState: 'running' as const,
    lastEventAt: 0,
  };
  const ask = { conversationId: 'c1', askId: 'ask-1', question: '用哪个？', label: 'p1 · 任务' };

  /** sec2 的 lastActiveAt 比 sec1 新：没有发起者时按最近活跃会落到 sec2 */
  function relayHarness(
    options: { tracked?: boolean; statuses?: Harness['state']['statuses'] } & Pick<
      Parameters<typeof harness>[0],
      'rows'
    > = {}
  ): Harness {
    const file = emptyFile(options.tracked === false ? {} : { dispatched: { c1: record } });
    const opened = openRelayAsk(file, ask, 0);
    const closed = closeRelayAsk(file, { ...ask, by: 'user', answer: 'B' }, 1, ask.label);
    if (!opened || !closed.update) throw new Error('relay updates');
    file.outbox = [opened, closed.update];
    return harness({
      file,
      ...(options.rows ? { rows: options.rows } : {}),
      ...(options.statuses ? { statuses: options.statuses } : {}),
    });
  }

  it('有派发记录时提问与关闭通知都投给发起者，即使别的秘书会话更近活跃', async () => {
    const h = relayHarness();
    expect(h.state.file.outbox.map((update) => update.secretaryConversationId)).toEqual([
      'sec1',
      'sec1',
    ]);
    await flushDeliveries(h.ports, 1000);
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.prompts[0].conversationId).toBe('sec1');
    expect(h.state.file.inflight?.keys).toHaveLength(2);
  });

  it('发起者正忙时等它，不转投别的秘书会话', async () => {
    const h = relayHarness({ statuses: { sec1: running, sec2: idle } });
    await flushDeliveries(h.ports, 1000);
    expect(h.state.prompts).toHaveLength(0);
    expect(h.state.file.outbox).toHaveLength(2);
    h.state.statuses.sec1 = idle;
    await flushDeliveries(h.ports, 2000);
    expect(h.state.prompts.map((prompt) => prompt.conversationId)).toEqual(['sec1']);
  });

  it('没有派发记录时照旧投给最近活跃的秘书会话', async () => {
    const h = relayHarness({ tracked: false });
    expect(h.state.file.outbox.every((update) => !update.secretaryConversationId)).toBe(true);
    await flushDeliveries(h.ports, 1000);
    expect(h.state.prompts.map((prompt) => prompt.conversationId)).toEqual(['sec2']);
  });

  it('发起者已归档时走现有兜底：改投最近活跃的未归档秘书会话', async () => {
    const h = relayHarness({
      rows: {
        sec1: { id: 'sec1', projectId: 'sec', archived: true, lastActiveAt: 99 },
        sec2: { id: 'sec2', projectId: 'sec', lastActiveAt: 20 },
      },
    });
    await flushDeliveries(h.ports, 1000);
    expect(h.state.prompts.map((prompt) => prompt.conversationId)).toEqual(['sec2']);
  });
});

describe('成功判定与重投', () => {
  it('秘书这一轮正常结束才算成功：清空在途与已投的批次', async () => {
    const h = harness({ file: { outbox: [update()] } });
    await flushDeliveries(h.ports, 1000);
    settleDelivery(h.ports, 'sec1', 'done', 2000);
    expect(h.state.file.outbox).toEqual([]);
    expect(h.state.file.inflight).toBeUndefined();
  });

  it('这一轮失败时整批重投，间隔逐次拉长，用完 6 次只留工作台', async () => {
    const h = harness({ file: { outbox: [update()] } });
    let now = 1000;
    await flushDeliveries(h.ports, now);
    expect(h.state.prompts).toHaveLength(1);
    const delays = [30_000, 60_000, 120_000, 240_000, 480_000];
    for (const [index, delay] of delays.entries()) {
      settleDelivery(h.ports, 'sec1', 'failed', now);
      expect(h.state.file.inflight?.attempt).toBe(index + 2);
      expect(h.state.file.inflight?.nextAttemptAt).toBe(now + delay);
      expect(h.state.file.outbox).toHaveLength(1);
      now += delay;
      await flushDeliveries(h.ports, now);
      expect(h.state.prompts).toHaveLength(index + 1);
      await flushDeliveries(h.ports, now + DELIVERY_IDLE_GRACE_MS);
      expect(h.state.prompts).toHaveLength(index + 2);
    }
    settleDelivery(h.ports, 'sec1', 'failed', now);
    expect(h.state.file.inflight).toBeUndefined();
    expect(h.state.file.outbox).toEqual([]);
  });

  it('别的会话结束不影响在途批次', async () => {
    const h = harness({ file: { outbox: [update()] } });
    await flushDeliveries(h.ports, 1000);
    settleDelivery(h.ports, 'c1', 'done', 2000);
    expect(h.state.file.inflight).toBeDefined();
    expect(h.state.file.outbox).toHaveLength(1);
  });

  it('重启后已开始的投递不重发', async () => {
    const h = harness({
      file: {
        outbox: [update()],
        inflight: {
          deliveryId: 'id-1',
          secretaryConversationId: 'sec1',
          keys: ['k1'],
          attempt: 1,
          nextAttemptAt: 1000,
        },
      },
      statuses: { sec1: running },
    });
    recoverDeliveries(h.ports, 5000);
    await flushDeliveries(h.ports, 5000);
    expect(h.state.prompts).toHaveLength(0);
    expect(h.state.file.inflight).toBeDefined();
  });

  it('重启后没开始过的投递按原批次重发', async () => {
    const h = harness({
      file: {
        outbox: [update()],
        inflight: {
          deliveryId: 'id-1',
          secretaryConversationId: 'sec1',
          keys: ['k1'],
          attempt: 1,
          nextAttemptAt: 5000,
        },
      },
    });
    recoverDeliveries(h.ports, 5000);
    await flushDeliveries(h.ports, 5000);
    expect(h.state.prompts).toHaveLength(1);
  });

  it('到点时会话刚变空闲先等收口，正常结束不重投同一条', async () => {
    const h = harness({ file: { outbox: [update()] } });
    await flushDeliveries(h.ports, 1000);
    await flushDeliveries(h.ports, 31_000);
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.file.inflight?.idleGraceUntil).toBe(31_000 + DELIVERY_IDLE_GRACE_MS);
    settleDelivery(h.ports, 'sec1', 'done', 31_100);
    await flushDeliveries(h.ports, 31_000 + DELIVERY_IDLE_GRACE_MS);
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.file.outbox).toEqual([]);
  });

  it('普通更新没到窗口不投，到点后多个会话合成一次', async () => {
    const h = harness({
      file: {
        outbox: [
          update({ key: 'a', conversationId: 'c1', deliverAt: 5_000 }),
          update({ key: 'b', conversationId: 'c2', deliverAt: 5_000, text: '另一条' }),
        ],
      },
    });
    await flushDeliveries(h.ports, 1_000);
    expect(h.state.prompts).toHaveLength(0);
    await flushDeliveries(h.ports, 5_000);
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.prompts[0].text).toContain('line');
    expect(h.state.prompts[0].text).toContain('另一条');
  });

  it('needs-user 立刻投，并把窗口里还没到点的更新一起带走', async () => {
    const h = harness({
      file: {
        outbox: [
          update({ key: 'held', deliverAt: 90_000 }),
          update({ key: 'now', kind: 'needs-user', conversationId: 'c2', text: '要你看' }),
        ],
      },
    });
    await flushDeliveries(h.ports, 1_000);
    expect(h.state.prompts).toHaveLength(1);
    expect(h.state.prompts[0].text).toContain('要你看');
    expect(h.state.prompts[0].text).toContain('line');
  });
});
