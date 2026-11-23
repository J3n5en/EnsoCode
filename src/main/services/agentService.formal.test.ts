import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type { AgentControlContext } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import type { AgentRunLedgerEntry } from './agentRunLedger';
import { AgentService, type AgentServiceRuntime } from './agentService';

// 有界穷举子代理注册表：真实 AgentService 对接子会话 / worker 模型，父会话操作、子会话事件、
// worker 退出与 Main 重启（新建 AgentService，从同一份台账恢复）按任意顺序交错。
// 子会话模型照 supervisor 持有 Run：回合结束时还有自己的后台任务就带 awaitingTasks，
// 任务完成时空闲则唤醒新一轮（continues 指回被持有的 Run），忙则搭下一条工具结果。

const parent = { sessionId: 'chat-1', generation: '11111111-1111-4111-8111-111111111111' };
const context: AgentControlContext = {
  owner: { ownerId: 'chat-1', projectId: 'project-1', kind: 'chatSession' },
  actor: {
    kind: 'agent',
    actorId: 'chat-1',
    ownerId: 'chat-1',
    projectId: 'project-1',
    identity: parent,
  },
};

type Mode = 'task' | 'coworker';
const OUTCOMES = { ok: 'succeeded', abort: 'interrupted', fail: 'failed' } as const;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
/** 不由父会话发起的步骤：它们都走完、父会话也不再操作时，系统必须收敛 */
const ENVIRONMENT = /^(return|ready|end|turn|taskdone|restore|parent-ready)/;

interface Budget {
  spawns: number;
  sends: number;
  stops: number;
  dismisses: number;
  resumes: number;
  faults: number;
  crashes: number;
  /** 回合结束时留下自己的后台任务 */
  holds: number;
}

interface Child {
  mode: Mode;
  identity: ChildSessionIdentity;
  agentId?: string;
  live: boolean;
  ready: boolean;
  turn?: string;
  /** 子代理自己起的、在跑、没表态的后台任务数 */
  tasks: number;
  /** 被持有的 Run（supervisor 的 heldTurnId） */
  held?: string;
  /** 忙时完成、还没交给模型的任务通知 */
  notices: boolean;
  wakes: number;
  /** runtime.dismiss 回收、child-ended 还没发出的那一代子会话 */
  ending?: ChildSessionIdentity;
  dismissed: boolean;
  returnSpawn?: () => void;
}

/** 子会话随回收 / worker 退出一起没了：后台任务被杀，持有随之失效 */
const kill = { live: false, turn: undefined, tasks: 0, held: undefined, notices: false };

interface World {
  service: AgentService;
  saved: AgentRunLedgerEntry[];
  children: Child[];
  parentUp: boolean;
  used: Budget;
  runIds: string[];
  notified: Map<string, number>;
  notifiedStatus: Map<string, string>;
  expected: Map<string, string>;
  endedByParent: Set<string>;
  terminal: Map<string, string>;
  premature?: string;
  ids: number;
}

interface Internals {
  agents: Map<string, { identity: ChildSessionIdentity; state: { status: string } }>;
  runs: Map<string, { runId: string; status: string; delivered: boolean }>;
}
const internals = (w: World) => w.service as unknown as Internals;

function identity(w: World, i: number): ChildSessionIdentity {
  const instanceId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`;
  return {
    sessionId: `chat-1::agent-${instanceId}`,
    generation: `22222222-2222-4222-8222-${String(++w.ids).padStart(12, '0')}`,
    parent,
    instanceId,
    instanceName: `inst-${i}`,
    typeKey: 'builtin:worker',
  };
}

function newService(w: World): AgentService {
  const child = (id: ChildSessionIdentity) =>
    w.children.find((c) => c.identity.sessionId === id.sessionId)!;
  const start = async ({
    identity: id,
    runId,
  }: {
    identity: ChildSessionIdentity;
    runId: string;
  }) => {
    const c = child(id);
    if (!c.live) return { ok: false, error: 'child gone' };
    c.turn = runId;
    c.held = undefined;
    return { ok: true };
  };
  const runtime: AgentServiceRuntime = {
    spawn: async ({ mode }) => {
      const i = w.children.length;
      const c: Child = {
        mode,
        identity: identity(w, i),
        live: true,
        ready: false,
        dismissed: false,
        tasks: 0,
        notices: false,
        wakes: 0,
      };
      w.children.push(c);
      await new Promise<void>((resolve) => {
        c.returnSpawn = resolve;
      });
      c.returnSpawn = undefined;
      return c.identity;
    },
    prompt: start,
    retry: start,
    resume: async ({ identity: id }) => {
      const c = child(id);
      Object.assign(c, {
        identity: identity(w, w.children.indexOf(c)),
        live: true,
        dismissed: false,
      });
      return c.identity;
    },
    steer: async () => ({ ok: true }),
    stop: async ({ identity: id }) => {
      Object.assign(child(id), { turn: undefined, held: undefined });
      return { ok: true };
    },
    dismiss: async ({ identity: id }) => {
      const c = child(id);
      Object.assign(c, {
        ...kill,
        ending: c.live ? c.identity : undefined,
        dismissed: true,
      });
      return { ok: true };
    },
  };
  return new AgentService({
    runtime,
    ledger: {
      load: () => w.saved.map((entry) => ({ ...entry })),
      save: (entries) => {
        w.saved = entries.map((entry) => ({ ...entry }));
      },
    },
    randomUuid: () => `id-${++w.ids}`,
    now: () => w.ids,
    notify: (_context, text) => {
      for (const [, runId] of text.matchAll(/runId (id-\d+)/g)) {
        w.notified.set(runId!, (w.notified.get(runId!) ?? 0) + 1);
      }
      const done = /runId (id-\d+)\) (\w+) after/.exec(text);
      if (done) w.notifiedStatus.set(done[1]!, done[2]!);
    },
  });
}

function boot(): World {
  const w = {
    saved: [],
    children: [],
    parentUp: true,
    used: {
      spawns: 0,
      sends: 0,
      stops: 0,
      dismisses: 0,
      resumes: 0,
      faults: 0,
      crashes: 0,
      holds: 0,
    },
    runIds: [],
    notified: new Map(),
    notifiedStatus: new Map(),
    expected: new Map(),
    endedByParent: new Set(),
    terminal: new Map(),
    ids: 0,
  } as Omit<World, 'service'> as World;
  w.service = newService(w);
  return w;
}

/** ipc/agent.ts 的 child-ready 顺序：先 observe，再按权威 metadata 认领 coworker */
function childReady(w: World, c: Child): void {
  c.ready = true;
  w.service.observe({
    type: 'child-ready',
    identity: c.identity,
    seq: 0,
    sessionFile: 'f',
  } as never);
  if (c.mode === 'coworker') w.service.adoptCoworker(context, c.identity);
}

const inProgress = (w: World) => new Set(w.service.progress('chat-1').map((run) => run.runId));

/** 父会话自己 stop / dismiss 收口的 Run 由回执告知，不应再有通知 */
function byParent(w: World, call: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    const before = inProgress(w);
    await call();
    const after = inProgress(w);
    for (const runId of before) if (!after.has(runId)) w.endedByParent.add(runId);
  };
}

function actions(w: World, cfg: Budget & { modes: Mode[] }): [string, () => unknown][] {
  const out: [string, () => unknown][] = [];
  const u = w.used;
  w.children.forEach((c, i) => {
    if (c.returnSpawn) out.push([`return:${i}`, c.returnSpawn]);
    if (c.live && !c.ready) out.push([`ready:${i}`, () => childReady(w, c)]);
    const ended = c.ending;
    if (ended) {
      out.push([
        `end:${i}`,
        () => {
          c.ending = undefined;
          w.service.observe({ type: 'child-ended', identity: ended, seq: 0, reason: 'dismissed' });
        },
      ]);
    }
    if (!w.parentUp) return;
    if (c.mode === 'coworker' && !c.live && !c.dismissed && !c.returnSpawn) {
      out.push([
        `restore:${i}`,
        () => {
          Object.assign(c, { identity: identity(w, i), live: true });
          childReady(w, c);
        },
      ]);
    }
    const turn = c.turn;
    for (const outcome of turn && c.live ? (['ok', 'bg', 'abort', 'fail'] as const) : []) {
      if (outcome === 'bg' ? u.holds >= cfg.holds : outcome !== 'ok' && u.faults >= cfg.faults)
        continue;
      out.push([
        `turn:${i}:${outcome}`,
        () => {
          const runId = c.held ?? turn!;
          const continues = c.held;
          c.turn = undefined;
          if (outcome === 'bg') {
            u.holds++;
            c.tasks++;
          } else if (outcome !== 'ok') u.faults++;
          const ok = outcome === 'ok' || outcome === 'bg';
          const awaiting = ok && (c.tasks > 0 || c.notices);
          c.held = awaiting ? runId : undefined;
          const run = internals(w).runs.get(runId);
          if (!awaiting && run && !TERMINAL.has(run.status))
            w.expected.set(runId, OUTCOMES[ok ? 'ok' : outcome]);
          const base = {
            identity: c.identity,
            seq: 0,
            turnId: turn!,
            ...(continues ? { continues } : {}),
          };
          w.service.observe(
            outcome === 'fail'
              ? { ...base, type: 'turn-failed', error: 'boom' }
              : {
                  ...base,
                  type: 'turn-completed',
                  ...(outcome === 'abort' ? { aborted: true } : {}),
                  ...(awaiting ? { awaitingTasks: true } : {}),
                }
          );
          if (awaiting && TERMINAL.has(internals(w).runs.get(runId)?.status ?? ''))
            w.premature ??= runId;
          if (awaiting && c.notices) {
            c.notices = false;
            c.turn = `${runId}~w${++c.wakes}`;
          }
        },
      ]);
    }
    if (c.live && c.tasks > 0) {
      out.push([
        `taskdone:${i}`,
        () => {
          c.tasks--;
          if (c.held && !c.turn) c.turn = `${c.held}~w${++c.wakes}`;
          else c.notices = true;
        },
      ]);
    }
    // 用户在子代理 tab 里对持有中、空闲的子代理点停止
    const held = c.held;
    if (held && !c.turn && c.live && u.faults < cfg.faults) {
      out.push([
        `idle-abort:${i}`,
        () => {
          u.faults++;
          c.held = undefined;
        },
      ]);
    }
    const agentId = c.agentId;
    if (!agentId) return;
    if (c.mode === 'coworker' && u.sends < cfg.sends) {
      out.push([
        `send:${i}`,
        async () => {
          const message = `m${++u.sends}`;
          const sent = await w.service.send({
            context,
            requestId: message,
            agentId,
            message,
            delivery: 'next',
          });
          if (sent.ok) w.runIds.push(sent.value.runId);
        },
      ]);
    }
    if (u.dismisses < cfg.dismisses && !c.dismissed) {
      out.push([
        `dismiss:${i}`,
        byParent(w, () => {
          u.dismisses++;
          return w.service.dismiss({ context, requestId: 'd', agentId });
        }),
      ]);
    }
    if (
      u.resumes < cfg.resumes &&
      internals(w).agents.get(agentId)?.state.status === 'parked' &&
      c.mode === 'task'
    ) {
      out.push([
        `resume:${i}`,
        async () => {
          u.resumes++;
          const resumed = await w.service.resume({ context, requestId: 'r', agentId });
          if (resumed.ok) w.runIds.push(resumed.value.runId);
        },
      ]);
    }
  });
  if (!w.parentUp) {
    out.push([
      'parent-ready',
      () => {
        w.parentUp = true;
        w.service.recoverOwner(context);
      },
    ]);
    return out;
  }
  const mode = cfg.modes[u.spawns];
  if (mode && u.spawns < cfg.spawns) {
    out.push([
      `spawn:${mode}`,
      () => {
        const i = w.children.length;
        u.spawns++;
        void w.service
          .spawn({ context, requestId: `p${i}`, description: `d${i}`, prompt: `p${i}`, mode })
          .then((spawned) => {
            if (!spawned.ok) return;
            w.children[i]!.agentId = spawned.value.agentId;
            w.runIds.push(spawned.value.runId);
          });
      },
    ]);
  }
  for (const runId of u.stops < cfg.stops ? inProgress(w) : []) {
    out.push([
      `stop:${runId}`,
      byParent(w, () => {
        u.stops++;
        return w.service.stop({ context, requestId: 'x', runId });
      }),
    ]);
  }
  // 崩溃不打断进行中的 spawn：那条路径上 runtime.spawn 直接失败，不进注册表
  if (u.crashes < cfg.crashes && !w.children.some((c) => c.returnSpawn)) {
    for (const kind of ['exit', 'restart'] as const) {
      out.push([
        kind,
        () => {
          u.crashes++;
          w.parentUp = false;
          for (const c of w.children)
            Object.assign(c, { ...kill, ready: false, ending: undefined });
          if (kind === 'exit') w.service.observe({ type: 'worker-exited' });
          else w.service = newService(w);
        },
      ]);
    }
  }
  return out;
}

function key(w: World): string {
  const { agents, runs } = internals(w);
  return JSON.stringify([
    [...agents].map(([id, a]) => [id, a.identity.generation, a.state]),
    [...runs.values()].map((r) => [r.runId, r.status, r.delivered]),
    w.saved.map((e) => [e.runId, e.status, e.notified]),
    w.children.map(({ returnSpawn, identity: id, ...c }) => [c, id.generation, !!returnSpawn]),
    [w.parentUp, w.used, w.runIds, [...w.notified], [...w.notifiedStatus], [...w.endedByParent]],
  ]);
}

function safetyViolation(w: World): string | null {
  if (w.premature) return `持有中的 Run ${w.premature} 被提前收口`;
  const sessions = [...internals(w).agents.values()].map((a) => a.identity.sessionId);
  if (new Set(sessions).size !== sessions.length) return '同一子会话对应多条 Agent 记录';
  for (const c of w.children) {
    const state = c.agentId && internals(w).agents.get(c.agentId)?.state.status;
    if (c.mode === 'coworker' && c.dismissed && state && state !== 'closed') {
      return `已 dismiss 的 coworker 又变成 ${state}`;
    }
  }
  for (const [runId, count] of w.notified) if (count > 1) return `Run ${runId} 通知了 ${count} 次`;
  for (const run of internals(w).runs.values()) {
    const first = w.terminal.get(run.runId);
    if (first && first !== run.status) return `Run 终态 ${first} 又变成 ${run.status}`;
    if (TERMINAL.has(run.status)) w.terminal.set(run.runId, run.status);
  }
  for (const [runId, status] of w.expected) {
    const got = w.notifiedStatus.get(runId);
    if (got && got !== status) return `回合 ${status} 的 Run 通知成 ${got}`;
  }
  return null;
}

async function settledViolation(w: World): Promise<string | null> {
  if (inProgress(w).size > 0) return 'Run 停在未终结状态，无人推进';
  for (const runId of w.runIds) {
    const told = (w.notified.get(runId) ?? 0) + (w.endedByParent.has(runId) ? 1 : 0);
    if (told !== 1) return `Run 结局告知父会话 ${told} 次`;
  }
  if (w.children.some((c) => c.mode === 'task' && c.live)) return 'task 结束后子会话未回收';
  const listed = await w.service.list({ context, requestId: 'l', limit: 100 });
  const ids = new Set(listed.ok ? listed.value.agents.map((a) => a.agentId) : []);
  if (
    w.children.some(
      (c) => c.mode === 'coworker' && c.agentId && !c.dismissed && !ids.has(c.agentId)
    )
  ) {
    return '父会话手里的 coworker agentId 失效';
  }
  return null;
}

async function step(w: World, cfg: Parameters<typeof actions>[1], label: string): Promise<void> {
  const action = actions(w, cfg).find(([l]) => l === label);
  if (!action) throw new Error(`回放不确定：${label} 不可用`);
  await action[1]();
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** 深度优先：第一个后继在活着的世界上继续走，其余后继从头回放真实代码（闭包与 promise 无法克隆） */
async function explore(
  cfg: Parameters<typeof actions>[1]
): Promise<{ states: number; counterexample?: string }> {
  const seen = new Set<string>();
  let live = boot();
  let liveTrace: string[] = [];
  seen.add(key(live));
  const stack = [{ trace: liveTrace, labels: actions(live, cfg).map(([l]) => l), i: 0 }];
  while (stack.length > 0) {
    const top = stack.at(-1)!;
    if (top.i === top.labels.length) {
      stack.pop();
      continue;
    }
    const label = top.labels[top.i++]!;
    if (liveTrace !== top.trace) {
      live = boot();
      for (const l of top.trace) await step(live, cfg, l);
    }
    await step(live, cfg, label);
    liveTrace = [...top.trace, label];
    const k = key(live);
    if (seen.has(k)) continue;
    seen.add(k);
    const enabled = actions(live, cfg).map(([l]) => l);
    const broken =
      safetyViolation(live) ??
      (enabled.some((l) => ENVIRONMENT.test(l)) ? null : await settledViolation(live));
    if (broken) {
      const trace = [...liveTrace.map((s, i) => `${i + 1}. ${s}`), `=> ${broken}`];
      return { states: seen.size, counterexample: trace.join('\n') };
    }
    stack.push({ trace: liveTrace, labels: enabled, i: 0 });
  }
  return { states: seen.size };
}

const FULL = process.env.ENSO_FORMAL_FULL === '1';
const none = {
  spawns: 1,
  sends: 0,
  stops: 1,
  dismisses: 1,
  resumes: 0,
  faults: 1,
  crashes: FULL ? 2 : 1,
  holds: 1,
};

const configs = [
  {
    name: 'coworker：排队、stop、dismiss、用户中止 / 失败、worker 退出与重启',
    cfg: { ...none, modes: ['coworker'] as Mode[], sends: FULL ? 2 : 1 },
    min: FULL ? 14_000 : 2_000,
  },
  {
    name: 'task：stop、停放与 resume、worker 退出与重启',
    cfg: { ...none, modes: ['task'] as Mode[], resumes: 1 },
    min: 300,
  },
  ...(FULL
    ? [
        {
          name: 'coworker 与 task 并存',
          cfg: {
            ...none,
            modes: ['coworker', 'task'] as Mode[],
            spawns: 2,
            sends: 1,
            resumes: 1,
            crashes: 1,
          },
          min: 100_000,
        },
      ]
    : []),
];

describe('子代理注册表生命周期（有界穷举，驱动真实 AgentService）', () => {
  it.each(configs)(
    '每个 Run 恰好终结并告知一次、子会话至多一条记录、队列不遗留、agentId 跨重启稳定：$name',
    async ({ cfg, min }) => {
      const result = await explore(cfg);
      expect(result.counterexample ?? '').toBe('');
      console.info(`${result.states} states`);
      expect(result.states).toBeGreaterThan(min);
    },
    FULL ? 900_000 : 60_000
  );
});
