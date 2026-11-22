import { splitTaskWrapUpPrefix } from '@shared/turnNotes';
import { describe, expect, it } from 'vitest';
import {
  ActivitySampler,
  IDLE_QUIET_MS,
  judgeIdle,
  KEEP_RECHECK_MS,
  keepSuppressesIdle,
  parseLsofTcp,
  parsePsTable,
  settleChecklist,
} from './taskHygiene';

const NOW = 10_000_000_000;
const quiet = NOW - IDLE_QUIET_MS;
const listening = { listening: [5173], established: 0 };

describe('judgeIdle', () => {
  it('三条同时满足才算疑似闲置', () => {
    expect(
      judgeIdle({ now: NOW, lastOutputAt: quiet, sample: { cpuRatio: 0, sockets: listening } })
    ).toBe(true);
  });

  it('任一条不满足就不算', () => {
    expect(
      judgeIdle({ now: NOW, lastOutputAt: quiet + 1, sample: { cpuRatio: 0, sockets: listening } })
    ).toBe(false);
    expect(
      judgeIdle({ now: NOW, lastOutputAt: quiet, sample: { cpuRatio: 0.2, sockets: listening } })
    ).toBe(false);
    expect(
      judgeIdle({
        now: NOW,
        lastOutputAt: quiet,
        sample: { cpuRatio: 0, sockets: { listening: [5173], established: 1 } },
      })
    ).toBe(false);
  });

  it('不监听端口的任务只看输出与 CPU，出站连接不算', () => {
    expect(
      judgeIdle({
        now: NOW,
        lastOutputAt: quiet,
        sample: { cpuRatio: 0, sockets: { listening: [], established: 2 } },
      })
    ).toBe(true);
  });

  it('数据缺失不误判', () => {
    expect(judgeIdle({ now: NOW, lastOutputAt: quiet })).toBe(false);
    expect(judgeIdle({ now: NOW, lastOutputAt: quiet, sample: { sockets: listening } })).toBe(
      false
    );
    expect(judgeIdle({ now: NOW, lastOutputAt: quiet, sample: { cpuRatio: 0 } })).toBe(false);
  });
});

describe('keepSuppressesIdle', () => {
  it('保留 1 小时内不判闲置，到点重新检查', () => {
    const keep = { by: 'user' as const, at: NOW };
    expect(keepSuppressesIdle(keep, NOW + KEEP_RECHECK_MS - 1)).toBe(true);
    expect(keepSuppressesIdle(keep, NOW + KEEP_RECHECK_MS)).toBe(false);
    expect(keepSuppressesIdle(undefined, NOW)).toBe(false);
  });
});

describe('parsePsTable', () => {
  it('解析 macOS 与 Linux 两种 CPU 时间格式', () => {
    const table = parsePsTable(
      ['  101     1   0:01.50', '  102   101 1:02:03', '  103   102 2-00:00:01', 'junk'].join('\n')
    );
    expect(table.get(101)).toEqual({ ppid: 1, cpuSec: 1.5 });
    expect(table.get(102)?.cpuSec).toBe(3723);
    expect(table.get(103)?.cpuSec).toBe(172_801);
    expect(table.size).toBe(3);
  });
});

describe('parseLsofTcp', () => {
  it('按进程汇总监听端口与已建立连接', () => {
    const out = [
      'p101',
      'f20',
      'n*:5173',
      'TST=LISTEN',
      'f21',
      'n127.0.0.1:5173->127.0.0.1:52344',
      'TST=ESTABLISHED',
      'p102',
      'f3',
      'n[::1]:8000',
      'TST=LISTEN',
      'f4',
      'n10.0.0.2:5000->10.0.0.3:443',
      'TST=CLOSE_WAIT',
    ].join('\n');
    const sockets = parseLsofTcp(out);
    expect(sockets.get(101)).toEqual({ listening: [5173], established: 1 });
    expect(sockets.get(102)).toEqual({ listening: [8000], established: 0 });
  });
});

describe('ActivitySampler', () => {
  const ps = (cpu: string) => `  200     1 ${cpu}\n  201   200 0:00.00\n  300     1 0:00.00\n`;

  it('一次采样只 fork 一次 ps 和一次 lsof；首轮没有 CPU 基线', async () => {
    const calls: string[] = [];
    let cpu = '0:10.00';
    const sampler = new ActivitySampler(async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'ps') return { ok: true, stdout: ps(cpu) };
      return { ok: true, stdout: 'p201\nf5\nn*:5173\nTST=LISTEN\n' };
    });
    const first = await sampler.sample(
      [
        { key: 'a', pid: 200 },
        { key: 'b', pid: 300 },
      ],
      NOW
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('-p 200,201,300');
    expect(first.get('a')).toEqual({ sockets: { listening: [5173], established: 0 } });
    cpu = '0:10.10';
    const second = await sampler.sample([{ key: 'a', pid: 200 }], NOW + 60_000);
    expect(second.get('a')?.cpuRatio).toBeCloseTo(0.1 / 60);
  });

  it('lsof 无结果按没有套接字，lsof 不可用按缺失；进程不在按缺失', async () => {
    const sampler = new ActivitySampler(async (file) =>
      file === 'ps' ? { ok: true, stdout: ps('0:00.00') } : { ok: false, stdout: '', code: 1 }
    );
    const result = await sampler.sample(
      [
        { key: 'a', pid: 200 },
        { key: 'gone', pid: 999 },
      ],
      NOW
    );
    expect(result.get('a')?.sockets).toEqual({ listening: [], established: 0 });
    expect(result.get('gone')).toBeUndefined();
    const missing = new ActivitySampler(async (file) =>
      file === 'ps' ? { ok: true, stdout: ps('0:00.00') } : { ok: false, stdout: '' }
    );
    expect((await missing.sample([{ key: 'a', pid: 200 }], NOW)).get('a')?.sockets).toBeUndefined();
  });
});

describe('settleChecklist', () => {
  it('列出没表态的在跑任务并要求逐个表态', () => {
    const text = settleChecklist(
      [
        {
          taskId: 't1',
          command: 'pnpm dev',
          status: 'running',
          tail: '',
          startedAt: NOW - 65 * 60_000,
        },
        {
          taskId: 't2',
          command: 'iproxy 2222 22',
          status: 'running',
          tail: '',
          startedAt: NOW,
          keep: { by: 'agent', reason: 'ssh', at: NOW },
        },
        { taskId: 't3', command: 'vitest', status: 'done', tail: '', startedAt: NOW },
      ],
      NOW
    );
    expect(text).toContain('t1: pnpm dev');
    expect(text).not.toContain('t2');
    expect(text).not.toContain('t3');
    expect(text).toContain('task_settle');
    expect(settleChecklist([], NOW)).toBeUndefined();
  });

  it('发给模型的原文逐字不变，展示层解析得出同样的任务', () => {
    const command = `ssh green 'cd /opt && sleep 90'\n  && echo done`;
    const text = settleChecklist(
      [{ taskId: 'task-48-x', command, status: 'running', tail: '', startedAt: NOW - 61 * 60_000 }],
      NOW
    );
    expect(text).toBe(
      [
        '<background-tasks-wrap-up>',
        'These background tasks are still running and you have not said what happens to them:',
        `- task-48-x: ssh green 'cd /opt && sleep 90' && echo done (running 1h 1m)`,
        'Call task_settle once for all of them: stop each one you no longer need, or keep it with a one-line reason the user will see. Do not leave them undeclared.',
        '</background-tasks-wrap-up>',
      ].join('\n')
    );
    expect(splitTaskWrapUpPrefix(`${text}\n\n继续`)?.items).toEqual([
      {
        taskId: 'task-48-x',
        command: `ssh green 'cd /opt && sleep 90' && echo done`,
        ran: '1h 1m',
      },
    ]);
  });
});
