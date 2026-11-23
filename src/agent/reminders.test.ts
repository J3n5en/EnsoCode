import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  REMINDER_MAX_CHAIN,
  REMINDER_MAX_DELAY_MS,
  REMINDER_MAX_PER_OWNER,
  REMINDERS_FILE,
} from '@shared/reminders';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReminderTools, ReminderStore } from './reminders';

type Tool = {
  name: string;
  prepareArguments?: (args: unknown) => unknown;
  execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }> }>;
};

const NOW = Date.parse('2026-01-01T00:00:00Z');

function setup(owner = 'root', maxDelayMs = REMINDER_MAX_DELAY_MS) {
  const dir = mkdtempSync(path.join(tmpdir(), 'enso-reminders-'));
  const file = path.join(dir, REMINDERS_FILE);
  const onTick = vi.fn();
  const store = new ReminderStore(file, onTick);
  let now = NOW;
  const tools = createReminderTools(store, owner, {
    maxDelayMs,
    now: () => now,
  }) as unknown as Tool[];
  const tool = (name: string) => tools.find((item) => item.name === name) as Tool;
  const call = async (name: string, args: unknown) => {
    const prepared = tool(name).prepareArguments?.(args) ?? args;
    const result = await tool(name).execute('call', prepared);
    return result.content.map((part) => part.text).join('\n');
  };
  const disk = () =>
    JSON.parse(readFileSync(file, 'utf8')) as {
      reminders: Array<{ id: string; label?: string; dueAt: number; chain: number }>;
      chains: Record<string, number>;
    };
  return {
    dir,
    file,
    store,
    onTick,
    tools,
    call,
    disk,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('remind_me', () => {
  it('三个工具齐全；in 定时落盘并返回 id、到点时间与挂着的数量', async () => {
    const ctx = setup();
    expect(ctx.tools.map((tool) => tool.name)).toEqual([
      'remind_me',
      'reminder_list',
      'reminder_cancel',
    ]);
    const text = await ctx.call('remind_me', { in: '90s', prompt: 'check CI', label: 'ci' });
    const [saved] = ctx.disk().reminders;
    expect(saved).toMatchObject({ label: 'ci', dueAt: NOW + 90_000, chain: 1 });
    expect(saved.id).toMatch(/^r[0-9a-f]{8}$/);
    expect(text).toContain(saved.id);
    expect(text).toContain('1 pending');
    ctx.store.dispose();
  });

  it('in 支持 s/m/h 与裸数字（按秒，数字参数先转字符串）；at 接 ISO 时间', async () => {
    const ctx = setup();
    await ctx.call('remind_me', { in: '5m', prompt: 'a' });
    await ctx.call('remind_me', { in: 120, prompt: 'b' });
    await ctx.call('remind_me', { in: '2h', prompt: 'c' });
    await ctx.call('remind_me', { at: new Date(NOW + 45 * 60_000).toISOString(), prompt: 'd' });
    expect(ctx.disk().reminders.map((item) => item.dueAt - NOW)).toEqual([
      5 * 60_000,
      120_000,
      2 * 3_600_000,
      45 * 60_000,
    ]);
    ctx.store.dispose();
  });

  it.each([
    ['in 与 at 同时给', { in: '5m', at: '2026-01-01T01:00:00Z', prompt: 'x' }],
    ['in 与 at 都没给', { prompt: 'x' }],
    ['没有 prompt', { in: '5m' }],
    ['空 prompt', { in: '5m', prompt: '   ' }],
    ['短于 30 秒', { in: '10s', prompt: 'x' }],
    ['长于 24 小时', { in: '25h', prompt: 'x' }],
    ['看不懂的时长', { in: 'soon', prompt: 'x' }],
    ['看不懂的时间', { at: 'tomorrow', prompt: 'x' }],
    ['过去的时间', { at: '2025-01-01T00:00:00Z', prompt: 'x' }],
    ['prompt 太长', { in: '5m', prompt: 'x'.repeat(4001) }],
    ['label 太长', { in: '5m', prompt: 'x', label: 'x'.repeat(81) }],
    ['ifIdle 不是布尔', { in: '5m', prompt: 'x', ifIdle: 'maybe' }],
  ])('拒绝：%s', async (_label, args) => {
    const ctx = setup();
    await expect(ctx.call('remind_me', args)).rejects.toThrow();
    expect(ctx.store.list('root')).toEqual([]);
    ctx.store.dispose();
  });

  it('子代理最长 10 分钟', async () => {
    const ctx = setup('root::cw-a', 10 * 60_000);
    await expect(ctx.call('remind_me', { in: '11m', prompt: 'x' })).rejects.toThrow(/10 minutes/);
    await ctx.call('remind_me', { in: '10m', prompt: 'x' });
    expect(ctx.store.list('root::cw-a')).toHaveLength(1);
    ctx.store.dispose();
  });

  it(`每个拥有者同时最多 ${REMINDER_MAX_PER_OWNER} 个，别的拥有者不受影响`, async () => {
    const ctx = setup();
    for (let i = 0; i < REMINDER_MAX_PER_OWNER; i++)
      await ctx.call('remind_me', { in: `${i + 1}m`, prompt: `p${i}` });
    await expect(ctx.call('remind_me', { in: '9m', prompt: 'more' })).rejects.toThrow(/at most 5/);
    const other = createReminderTools(ctx.store, 'root::cw-a', {
      maxDelayMs: 600_000,
      now: () => NOW,
    }) as unknown as Tool[];
    await other[0].execute('c', { in: '1m', prompt: 'mine' });
    expect(ctx.store.list('root::cw-a')).toHaveLength(1);
    ctx.store.dispose();
  });

  it(`连续链最多 ${REMINDER_MAX_CHAIN} 次：提醒唤醒的轮里再定提醒计数加一`, async () => {
    const ctx = setup();
    ctx.store.setChain('root', REMINDER_MAX_CHAIN - 1);
    await ctx.call('remind_me', { in: '1m', prompt: 'last' });
    expect(ctx.disk().reminders[0].chain).toBe(REMINDER_MAX_CHAIN);
    ctx.store.setChain('root', REMINDER_MAX_CHAIN);
    await expect(ctx.call('remind_me', { in: '1m', prompt: 'again' })).rejects.toThrow(/24/);
    ctx.store.resetChain('root');
    await ctx.call('remind_me', { in: '1m', prompt: 'fresh' });
    expect(ctx.disk().reminders.at(-1)?.chain).toBe(1);
    ctx.store.dispose();
  });

  it('ifIdle 默认 true，可传 false（字符串 "false" 归一化）', async () => {
    const ctx = setup();
    await ctx.call('remind_me', { in: '1m', prompt: 'a' });
    await ctx.call('remind_me', { in: '1m', prompt: 'b', ifIdle: 'false' });
    expect(ctx.store.list('root').map((item) => item.ifIdle)).toEqual([true, false]);
    ctx.store.dispose();
  });
});

describe('reminder_list / reminder_cancel', () => {
  it('只列、只取消自己的；all 取消全部', async () => {
    const ctx = setup();
    await ctx.call('remind_me', { in: '5m', prompt: 'a', label: 'deploy' });
    await ctx.call('remind_me', { in: '10m', prompt: 'b' });
    const child = createReminderTools(ctx.store, 'root::cw-a', {
      maxDelayMs: 600_000,
      now: () => NOW,
    }) as unknown as Tool[];
    await child[0].execute('c', { in: '1m', prompt: 'child' });
    const [first, second] = ctx.store.list('root');
    const listed = await ctx.call('reminder_list', {});
    expect(listed).toContain(first.id);
    expect(listed).toContain('deploy');
    expect(listed).toContain(second.id);
    expect(listed).not.toContain('child');

    const childId = ctx.store.list('root::cw-a')[0].id;
    expect(await ctx.call('reminder_cancel', { id: childId })).toMatch(/not found/i);
    expect(ctx.store.list('root::cw-a')).toHaveLength(1);

    await ctx.call('reminder_cancel', { id: first.id });
    expect(ctx.store.list('root').map((item) => item.id)).toEqual([second.id]);
    await ctx.call('remind_me', { in: '3m', prompt: 'c' });
    await ctx.call('reminder_cancel', { id: 'all' });
    expect(ctx.store.list('root')).toEqual([]);
    expect(ctx.store.list('root::cw-a')).toHaveLength(1);
    expect(await ctx.call('reminder_list', {})).toMatch(/no pending/i);
    ctx.store.dispose();
  });
});

describe('ReminderStore', () => {
  it('take 先删再交出，落盘后新实例读到同样的内容；clear 连子会话和链计数一起清', async () => {
    const ctx = setup();
    await ctx.call('remind_me', { in: '1m', prompt: 'a' });
    const child = createReminderTools(ctx.store, 'root::cw-a', {
      maxDelayMs: 600_000,
      now: () => NOW,
    }) as unknown as Tool[];
    await child[0].execute('c', { in: '1m', prompt: 'child' });
    ctx.store.setChain('root', 3);
    const id = ctx.store.list('root')[0].id;
    expect(ctx.store.take(id)?.prompt).toBe('a');
    expect(ctx.store.take(id)).toBeUndefined();
    ctx.store.dispose();

    const reloaded = new ReminderStore(ctx.file, vi.fn());
    expect(reloaded.list('root')).toEqual([]);
    expect(reloaded.list('root::cw-a')).toHaveLength(1);
    expect(reloaded.chain('root')).toBe(3);
    reloaded.clear('root');
    expect(reloaded.list('root::cw-a')).toEqual([]);
    expect(reloaded.chain('root')).toBe(0);
    expect(ctx.disk()).toMatchObject({ reminders: [], chains: {} });
    reloaded.dispose();
  });

  it('定时器指向最早的到点时间：到点回调一次；没被取走的 60 秒后再回调', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW });
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-reminders-'));
    const onTick = vi.fn();
    const store = new ReminderStore(path.join(dir, REMINDERS_FILE), onTick);
    const tools = createReminderTools(store, 'root', { maxDelayMs: REMINDER_MAX_DELAY_MS });
    await (tools[0] as unknown as Tool).execute('c', { in: '2m', prompt: 'later' });
    await (tools[0] as unknown as Tool).execute('c', { in: '1m', prompt: 'sooner' });
    vi.advanceTimersByTime(60_000 - 1);
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(store.due(Date.now()).map((item) => item.prompt)).toEqual(['sooner']);
    vi.advanceTimersByTime(60_000);
    expect(onTick).toHaveBeenCalledTimes(2);
    for (const item of store.due(Date.now())) store.take(item.id);
    vi.advanceTimersByTime(10 * 60_000);
    expect(onTick).toHaveBeenCalledTimes(2);
    store.dispose();
  });
});
