import type { RendererAgentEvent } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  applyAgentEvent,
  emptyProjection,
  type SessionProjection,
  type TimelineMessage,
  upsertOutOfRange,
} from './reducer';

type Outcome = 'accepted' | 'rejected' | 'timeout' | 'handled' | 'queued';
type Fate = 'pending' | 'delivered' | 'rejected' | 'undelivered' | 'handled' | 'withdrawn';
type Line = { role: string; text: string };

interface Config {
  sends: number;
  texts: readonly string[];
  snapshots: number;
  /** 运行中撤回未读插话的次数上限 */
  withdraws: number;
  idle: readonly Outcome[];
  running: readonly Outcome[];
}

interface World {
  r: SessionProjection;
  w: { msgs: Line[]; running: boolean; replied: boolean; seq: number; steers: string[] };
  prompts: string[];
  snapshotRequests: number;
  events: RendererAgentEvent[];
  sent: { d: string; text: string; fate: Fate; withdrawRequested?: boolean }[];
  snapshotsLeft: number;
  withdrawsLeft: number;
}

const SID = 's1';
const identity = { sessionId: SID, generation: 'g1' };
const text = (t: string) => [{ type: 'text' as const, text: t }];

const lineOf = (m: TimelineMessage): Line => ({
  role: m.role,
  text: m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
});

function key(s: World): string {
  return JSON.stringify([
    s.r.messages.map((m) => [
      m.role,
      lineOf(m).text,
      m.optimistic,
      m.deliveryId,
      m.deliveryRejected,
      m.withdrawRequested,
    ]),
    s.r.lastSeq,
    s.r.status,
    s.r.generation,
    s.w,
    s.prompts,
    s.snapshotRequests,
    s.events,
    s.sent,
    s.snapshotsLeft,
    s.withdrawsLeft,
  ]);
}

function emit(s: World, ...events: (Record<string, unknown> & { type: string })[]): void {
  for (const e of events) {
    s.events.push({ ...e, identity, seq: ++s.w.seq } as unknown as RendererAgentEvent);
  }
}

function fail(s: World, undelivered: boolean): void {
  s.w.running = false;
  emit(
    s,
    { type: 'status', status: 'failed', error: 'x' },
    { type: 'turn-failed', turnId: 't', error: 'x', ...(undelivered ? { undelivered: true } : {}) }
  );
}

function appendUser(s: World, d: string): void {
  const sent = s.sent.find((x) => x.d === d)!;
  sent.fate = 'delivered';
  s.w.msgs.push({ role: 'user', text: sent.text });
  s.w.replied = false;
  emit(
    s,
    {
      type: 'message-upsert',
      index: s.w.msgs.length - 1,
      message: { role: 'user', content: text(sent.text) },
    },
    { type: 'delivery-settled', deliveryId: d }
  );
}

function successors(s: World, cfg: Config): [string, World][] {
  const out: [string, World][] = [];
  const step = (label: string, f: (n: World) => void) => {
    const n = structuredClone(s);
    f(n);
    out.push([label, n]);
  };

  if (s.sent.length < cfg.sends) {
    for (const t of cfg.texts) {
      step(`renderer 发送 "${t}"`, (n) => {
        const d = `d${n.sent.length + 1}`;
        n.sent.push({ d, text: t, fate: 'pending' });
        n.r = {
          ...n.r,
          messages: [
            ...n.r.messages,
            { role: 'user', content: text(t), optimistic: true, deliveryId: d },
          ],
        };
        n.prompts.push(d);
      });
    }
  }
  if (s.snapshotsLeft > 0) {
    step('renderer 请求 snapshot', (n) => {
      n.snapshotsLeft--;
      n.snapshotRequests++;
    });
  }
  // 与 store.withdrawMessage 同条件：运行中、未拒收、未请求过撤回的回显
  if (s.withdrawsLeft > 0 && s.r.status === 'running') {
    for (const m of s.r.messages) {
      if (!m.optimistic || m.deliveryRejected || m.withdrawRequested || !m.deliveryId) continue;
      const d = m.deliveryId;
      step(`renderer 请求撤回 ${d}`, (n) => {
        n.withdrawsLeft--;
        n.r = {
          ...n.r,
          messages: n.r.messages.map((x) =>
            x.optimistic && x.deliveryId === d ? { ...x, withdrawRequested: true } : x
          ),
        };
        n.sent.find((x) => x.d === d)!.withdrawRequested = true;
        n.prompts.push(`~${d}`);
      });
    }
  }

  if (s.snapshotRequests > 0) {
    step('worker 发出 snapshot', (n) => {
      n.snapshotRequests--;
      n.events.push({
        type: 'snapshot',
        sessions: [
          {
            identity,
            status: n.w.running ? 'running' : 'idle',
            messages: n.w.msgs.map((m) => ({ role: m.role, content: text(m.text) })),
            commands: [],
          },
        ],
      });
    });
  }
  const d = s.prompts[0];
  if (d?.startsWith('~')) {
    // supervisor 'withdraw-steer'：仍在 pi 队列（未读）才撤回并回执拒收，否则无事发生
    const target = d.slice(1);
    step(`worker 处理撤回 ${target}`, (n) => {
      n.prompts.shift();
      const at = n.w.steers.indexOf(target);
      if (at === -1) return;
      n.w.steers.splice(at, 1);
      n.sent.find((x) => x.d === target)!.fate = 'withdrawn';
      emit(n, { type: 'delivery-rejected', deliveryId: target });
    });
  } else if (d) {
    for (const outcome of s.w.running ? cfg.running : cfg.idle) {
      step(`worker 处理 ${d}: ${outcome}`, (n) => {
        n.prompts.shift();
        const sent = n.sent.find((x) => x.d === d)!;
        if (outcome === 'accepted') {
          n.w.running = true;
          emit(n, { type: 'status', status: 'running' });
          appendUser(n, d);
        } else if (outcome === 'rejected') {
          sent.fate = 'rejected';
          emit(n, { type: 'delivery-rejected', deliveryId: d });
          fail(n, false);
        } else if (outcome === 'timeout') {
          sent.fate = 'undelivered';
          fail(n, true);
        } else if (outcome === 'handled') {
          sent.fate = 'handled';
        } else {
          n.w.steers.push(d);
        }
      });
    }
  }

  if (s.w.running && s.w.steers.length > 0) {
    step(`worker 投递 steer ${s.w.steers[0]}`, (n) => appendUser(n, n.w.steers.shift()!));
  }
  if (s.w.running && !s.w.replied) {
    step('worker 回复 assistant', (n) => {
      n.w.msgs.push({ role: 'assistant', text: 'reply' });
      n.w.replied = true;
      emit(n, {
        type: 'message-upsert',
        index: n.w.msgs.length - 1,
        message: { role: 'assistant', content: text('reply') },
      });
    });
  }
  if (s.w.running && s.w.replied && s.w.steers.length === 0) {
    step('worker 结束本轮', (n) => {
      n.w.running = false;
      emit(n, { type: 'status', status: 'idle' }, { type: 'turn-completed', turnId: 't' });
    });
  }

  if (s.events.length > 0) {
    step(`renderer 应用 ${s.events[0]!.type}`, (n) => {
      const event = n.events.shift()!;
      if (
        event.type === 'message-upsert' &&
        upsertOutOfRange(n.r.messages, event.index, n.r.historyBaseIndex)
      ) {
        n.snapshotRequests++;
      }
      n.r = applyAgentEvent(n.r, SID, event, 0);
    });
  }
  return out;
}

function violation(s: World): string | null {
  const msgs = s.r.messages;
  if (msgs.some((m) => m === undefined)) return '时间线出现空洞';
  const firstEcho = msgs.findIndex((m) => m.optimistic);
  if (firstEcho !== -1 && msgs.slice(firstEcho).some((m) => !m.optimistic)) {
    return '乐观回显之后出现权威消息';
  }
  for (const t of new Set(s.sent.map((x) => x.text))) {
    const shown = msgs.filter((m) => m.role === 'user' && lineOf(m).text === t).length;
    const sent = s.sent.filter((x) => x.text === t).length;
    if (shown > sent) return `"${t}" 发了 ${sent} 次却显示 ${shown} 次`;
  }

  const quiet =
    s.prompts.length === 0 && s.snapshotRequests === 0 && s.events.length === 0 && !s.w.running;
  if (!quiet) return null;
  const authoritative = msgs.filter((m) => !m.optimistic).map(lineOf);
  if (JSON.stringify(authoritative) !== JSON.stringify(s.w.msgs)) {
    return `静止后正文与 worker 不一致：${JSON.stringify(authoritative)} ≠ ${JSON.stringify(s.w.msgs)}`;
  }
  const echoes = msgs
    .filter((m) => m.optimistic)
    .map((m) => `${m.deliveryId}:${m.deliveryRejected ? 'rejected' : 'pending'}`);
  const expected = s.sent
    .filter((x) => x.fate === 'rejected' && !x.withdrawRequested)
    .map((x) => `${x.d}:rejected`);
  if (JSON.stringify(echoes) !== JSON.stringify(expected)) {
    const fates = s.sent.map((x) => `${x.d}=${x.fate}`).join(', ');
    return `静止后回显尾巴 ${JSON.stringify(echoes)}，应为 ${JSON.stringify(expected)}（${fates}）`;
  }
  return null;
}

function explore(cfg: Config): { states: number; counterexample?: string } {
  const init: World = {
    r: { ...emptyProjection, generation: 'g1' },
    w: { msgs: [], running: false, replied: false, seq: 0, steers: [] },
    prompts: [],
    snapshotRequests: 0,
    events: [],
    sent: [],
    snapshotsLeft: cfg.snapshots,
    withdrawsLeft: cfg.withdraws,
  };
  const parent = new Map<string, [string, string] | null>([[key(init), null]]);
  let frontier: World[] = [init];
  while (frontier.length > 0) {
    const next: World[] = [];
    for (const s of frontier) {
      const k = key(s);
      const broken = violation(s);
      if (broken) {
        const trace: string[] = [];
        for (let at = parent.get(k); at; at = parent.get(at[0])) trace.unshift(at[1]);
        return {
          states: parent.size,
          counterexample: [...trace.map((t, i) => `${i + 1}. ${t}`), `=> ${broken}`].join('\n'),
        };
      }
      for (const [label, n] of successors(s, cfg)) {
        const nk = key(n);
        if (parent.has(nk)) continue;
        parent.set(nk, [k, label]);
        next.push(n);
      }
    }
    frontier = next;
  }
  return { states: parent.size };
}

const core: Config = {
  sends: 3,
  texts: ['a', 'b'],
  snapshots: 1,
  withdraws: 0,
  idle: ['accepted', 'rejected', 'timeout'],
  running: ['queued'],
};

describe('乐观回显投递协议（有界穷举）', () => {
  it('每条消息恰好显示一次，静止后正文等于 worker、只剩被拒回显', () => {
    const result = explore(core);
    expect(result.counterexample).toBeUndefined();
    expect(result.states).toBeGreaterThan(50_000);
  }, 60_000);

  it('运行中撤回未读插话：撤回成功的不再显示，未撤成的照常送达', () => {
    const result = explore({ ...core, snapshots: 0, withdraws: 1 });
    expect(result.counterexample).toBeUndefined();
    expect(result.states).toBeGreaterThan(10_000);
  }, 60_000);

  // 已知发现：promptTracked / steerTracked 遇 disposition 'handled' 不发任何回执，回显永远 pending。
  // 修复后这条会变红：把它改成断言 toBeUndefined 并并入上面的核心配置。
  it('已知发现：input hook 消费（handled）的投递留下永不收回的回显', () => {
    const result = explore({
      ...core,
      idle: [...core.idle, 'handled'],
      running: [...core.running, 'handled'],
    });
    expect(result.counterexample).toContain('d1=handled');
  });
});
