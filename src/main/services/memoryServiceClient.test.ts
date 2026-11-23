/**
 * 记忆服务客户端生命周期：fork 懒启动、崩溃后下个调用重拉、
 * 变更事件防抖合批、op 超时只拒绝该 op（ping 也无响应才杀服务）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({ utilityProcess: { fork: vi.fn() } }));
vi.mock('@platform', () => ({
  utilityProcess: stubs.utilityProcess,
  memoryWorkerPath: '/tmp/fake-worker.cjs',
  app: { getPath: () => '/tmp' },
}));

import { MemoryServiceClient, type MemoryServiceTransport } from './memoryServiceClient';

class FakeChild {
  posted: unknown[] = [];
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  killed = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  kill(): void {
    this.killed = true;
    queueMicrotask(() => this.emit('exit'));
  }
  once(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.once(event, listener);
  }
  emit(event: string, arg?: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) fn(arg);
  }
  /** 服务拉起就绪 */
  becomeReady(): void {
    this.emit('message', { type: 'ready' });
  }
  /** 回 op 结果 */
  reply(requestId: number, result: unknown): void {
    this.emit('message', { type: 'op-result', requestId, result });
  }
  sent(type: string): { requestId: number; op?: string }[] {
    return this.posted.filter((m) => (m as { type?: string }).type === type) as {
      requestId: number;
      op?: string;
    }[];
  }
}

function transport(child: FakeChild): MemoryServiceTransport {
  return child as unknown as MemoryServiceTransport;
}

describe('memory service client', () => {
  let forks: FakeChild[] = [];
  let client: MemoryServiceClient;
  let logs: { level: 'info' | 'warn'; message: string }[] = [];
  let optsRef: {
    onMemoryChanged?: () => void;
    llmResolver?: () => Promise<import('./memory/distill').Complete | null>;
  } = {};

  beforeEach(() => {
    vi.useFakeTimers();
    forks = [];
    logs = [];
    optsRef = {};
    client = new MemoryServiceClient({
      fork: () => {
        const child = new FakeChild();
        forks.push(child);
        return transport(child);
      },
      log: (level, message) => logs.push({ level, message }),
      onChanged: () => optsRef.onMemoryChanged?.(),
      llmResolver: () =>
        (optsRef.llmResolver?.() ?? Promise.resolve(null)) as ReturnType<
          NonNullable<typeof optsRef.llmResolver>
        >,
      opTimeoutMs: 30_000,
      memoryRoot: () => '/tmp/mem',
      sessionDir: () => '/tmp/sessions',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('首个 op 懒启动服务，ready 后投递并回结果', async () => {
    const pending = client.invoke('search', { query: 'q' });
    expect(forks).toHaveLength(1);
    const child = forks[0];
    await vi.advanceTimersByTimeAsync(0);
    child.becomeReady();
    await vi.advanceTimersByTimeAsync(0);
    const opMsg = child.posted.find((m) => (m as { type?: string }).type === 'op') as {
      requestId: number;
    };
    expect(opMsg).toBeTruthy();
    child.reply(opMsg.requestId, { found: true });
    await expect(pending).resolves.toEqual({ found: true });
    expect(client.alive()).toBe(true);
  });

  it('服务崩溃后 pending 被拒，下一个调用自动重拉', async () => {
    const first = client.invoke('search', { query: 'a' }).catch((e) => e);
    const child = forks[0];
    await vi.advanceTimersByTimeAsync(0);
    child.emit('exit');
    await expect(first).resolves.toBeInstanceOf(Error);
    expect(client.alive()).toBe(false);

    const second = client.invoke('search', { query: 'b' });
    expect(forks).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    forks[1].becomeReady();
    await vi.advanceTimersByTimeAsync(0);
    const opMsg = forks[1].posted.find((m) => (m as { type?: string }).type === 'op') as {
      requestId: number;
    };
    forks[1].reply(opMsg.requestId, 'ok');
    await expect(second).resolves.toBe('ok');
  });

  it('单个 op 超时只拒绝它自己：服务回 pong 就不杀进程，迟到回包被丢弃，后续 op 照常', async () => {
    const slow = client.invoke('schedule-distill', {}).catch((e) => e);
    const child = forks[0];
    await vi.advanceTimersByTimeAsync(0);
    child.becomeReady();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(String(await slow)).toContain("memory op 'schedule-distill' timed out");
    expect(child.killed).toBe(false);
    const [ping] = child.sent('ping');
    expect(ping).toBeTruthy();
    child.emit('message', { type: 'pong', requestId: ping.requestId });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.killed).toBe(false);

    child.reply(child.sent('op')[0].requestId, 'late');
    const next = client.invoke('kg-failed');
    expect(forks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    child.reply(child.sent('op').at(-1)!.requestId, 0);
    await expect(next).resolves.toBe(0);
  });

  it('探活进行中又有 op 超时：只发一次 ping，按第一次探活的期限判定', async () => {
    const first = client.invoke('search', { query: 'hang' }).catch((e) => e);
    const child = forks[0];
    await vi.advanceTimersByTimeAsync(0);
    child.becomeReady();
    await vi.advanceTimersByTimeAsync(10_000);
    const second = client.invoke('stats').catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_001);
    await expect(first).resolves.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(second).resolves.toBeInstanceOf(Error);
    expect(child.sent('ping')).toHaveLength(1);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.killed).toBe(true);
  });

  it('op 超时后 ping 也无响应才杀掉服务，下次调用重新拉起', async () => {
    const op = client.invoke('search', { query: 'hang' }).catch((e) => e);
    const child = forks[0];
    await vi.advanceTimersByTimeAsync(0);
    child.becomeReady();
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(op).resolves.toBeInstanceOf(Error);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.killed).toBe(true);

    const ping = client.invoke('ping');
    expect(forks).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    forks[1].becomeReady();
    await vi.advanceTimersByTimeAsync(0);
    const pingMsg = forks[1].posted.find((m) => (m as { type?: string }).type === 'op') as {
      requestId: number;
    };
    forks[1].reply(pingMsg.requestId, 'pong');
    await expect(ping).resolves.toBe('pong');
  });

  it('等待后台任务收尾的长 op 不受普通 op 超时限制', async () => {
    let settled = false;
    const wait = client.invoke('await-distill').finally(() => {
      settled = true;
    });
    const child = forks[0];
    await vi.advanceTimersByTimeAsync(0);
    child.becomeReady();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false);
    expect(child.killed).toBe(false);
    child.reply(child.sent('op')[0].requestId, true);
    await expect(wait).resolves.toBe(true);
  });

  it('服务 changed 事件防抖合并成一次回调', async () => {
    const changed = vi.fn();
    optsRef.onMemoryChanged = changed;
    const ping = client.invoke('ping');
    const child = forks[0];
    await vi.advanceTimersByTimeAsync(0);
    child.becomeReady();
    for (let i = 0; i < 5; i++) {
      child.emit('message', { type: 'changed' });
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(changed).toHaveBeenCalledTimes(1);
    const pingMsg = child.posted.find((m) => (m as { type?: string }).type === 'op') as {
      requestId: number;
    };
    child.reply(pingMsg.requestId, 'pong');
    await ping;
  });

  it('llm 请求由 Main 代跑并把结果流回服务', async () => {
    const complete = vi.fn(async () => 'completed text');
    optsRef.llmResolver = vi.fn(async () => complete as never) as never;
    const op = client.invoke('distill', {});
    const child = forks[0];
    await vi.advanceTimersByTimeAsync(0);
    child.becomeReady();
    await vi.advanceTimersByTimeAsync(0);
    child.emit('message', {
      type: 'llm-request',
      requestId: 9,
      system: 'sys',
      user: 'usr',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledWith(
      'sys',
      'usr',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const result = child.posted.find((m) => (m as { type?: string }).type === 'llm-result') as {
      requestId: number;
      text: string;
    };
    expect(result.requestId).toBe(9);
    expect(result.text).toBe('completed text');
    // 收尾：op 还挂着，回掉
    const opMsg = child.posted.find((m) => (m as { type?: string }).type === 'op') as {
      requestId: number;
    };
    child.reply(opMsg.requestId, null);
    await op;
  });

  it('冷启动期间多个会话同时发 op：只拉起一个服务，ready 后全部按序投递并各自回结果', async () => {
    const ops = ['a', 'b', 'c'].map((query) => client.invoke('invoke', { query }));
    expect(forks).toHaveLength(1);
    const child = forks[0];
    await vi.advanceTimersByTimeAsync(0);
    expect(child.posted).toHaveLength(0);
    child.becomeReady();
    await vi.advanceTimersByTimeAsync(0);
    const sent = child.posted.filter((m) => (m as { type?: string }).type === 'op') as {
      requestId: number;
      args: { query: string };
    }[];
    expect(sent.map((m) => m.args.query)).toEqual(['a', 'b', 'c']);
    for (const m of sent) child.reply(m.requestId, m.args.query.toUpperCase());
    await expect(Promise.all(ops)).resolves.toEqual(['A', 'B', 'C']);
  });

  it('服务起不来（一直等不到 ready）：op 按超时失败并杀掉这一代，不无限挂起', async () => {
    const op = client.invoke('invoke', { query: 'never' }).catch((e) => e);
    const child = forks[0];
    await vi.advanceTimersByTimeAsync(30_001);
    const error = await op;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('timed out');
    expect(child.killed).toBe(true);
    // 超时之后才到的 ready 不会把已失败的 op 再投递出去
    child.becomeReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(child.posted.filter((m) => (m as { op?: string }).op === 'invoke')).toHaveLength(0);
  });

  it('日志分级：spawned 与主动关停记 info，kill 与异常退出记 warn', async () => {
    const first = client.invoke('ping').catch((e) => e);
    forks[0].emit('spawn');
    await vi.advanceTimersByTimeAsync(0);
    forks[0].emit('exit');
    await first;
    expect(logs.find((l) => l.message.includes('spawned'))?.level).toBe('info');
    expect(logs.find((l) => l.message.includes('exited'))?.level).toBe('warn');

    logs = [];
    const hang = client.invoke('ping').catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_001);
    await hang;
    expect(logs.find((l) => l.message.includes('kill'))?.level).toBe('warn');

    logs = [];
    void client.invoke('ping').catch(() => {});
    const child = forks.at(-1)!;
    await vi.advanceTimersByTimeAsync(0);
    child.becomeReady();
    const stopped = client.shutdown();
    child.emit('exit');
    await stopped;
    expect(logs.filter((l) => l.message.includes('exited')).map((l) => l.level)).toEqual(['info']);
  });
});
