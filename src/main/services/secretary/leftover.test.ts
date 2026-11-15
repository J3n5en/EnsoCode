import { describe, expect, it } from 'vitest';
import {
  LEFTOVER_RUNNING_MS,
  LEFTOVER_SERVICE_GRACE_MS,
  leftoverNote,
  leftoverReason,
  leftoverUpdateText,
  PERSISTENT_RUNNING_MS,
  ranText,
  type TaskLike,
  taskIsPersistent,
} from './leftover';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function task(extra: Partial<TaskLike> = {}): TaskLike {
  return {
    command: 'pnpm typecheck && pnpm test',
    status: 'running',
    startedAt: NOW - 5 * MINUTE,
    ...extra,
  };
}

describe('常驻服务识别', () => {
  it.each([
    'pnpm dev',
    'npm run serve',
    'bun run start',
    'vite',
    'next dev',
    'python3 -m http.server 8931 --directory /tmp',
    'tsc --watch',
    'node server.js --port 3000',
    'nc -l 9000 --listen',
  ])('命令 %s 是常驻服务', (command) => {
    expect(taskIsPersistent(task({ command }), NOW)).toBe(true);
  });

  it.each(['pnpm typecheck && pnpm test', 'git status', 'ls -la', 'pytest -q'])(
    '命令 %s 不是常驻服务',
    (command) => {
      expect(taskIsPersistent(task({ command }), NOW)).toBe(false);
    }
  );

  it('跑过 30 分钟还没结束的普通任务按常驻看待', () => {
    const long = task({ startedAt: NOW - PERSISTENT_RUNNING_MS });
    expect(taskIsPersistent(long, NOW)).toBe(true);
    expect(taskIsPersistent(task({ startedAt: NOW - PERSISTENT_RUNNING_MS + 1 }), NOW)).toBe(false);
    // 已经结束的任务不再按时间升级
    expect(taskIsPersistent({ ...long, status: 'done' }, NOW)).toBe(false);
  });
});

describe('遗留判定', () => {
  it('进程已不在：最确定的遗留，优先于其它原因', () => {
    const dead = task({ alive: false, startedAt: NOW - LEFTOVER_RUNNING_MS });
    expect(leftoverReason(dead, { now: NOW })).toBe('process-gone');
  });

  it('跑过 2 小时还没结束', () => {
    expect(leftoverReason(task({ startedAt: NOW - LEFTOVER_RUNNING_MS }), { now: NOW })).toBe(
      'overtime'
    );
    expect(
      leftoverReason(task({ startedAt: NOW - LEFTOVER_RUNNING_MS + 1 }), { now: NOW })
    ).toBeUndefined();
  });

  it('常驻服务在会话收口 10 分钟后还在跑', () => {
    const server = task({ command: 'python3 -m http.server 8931' });
    expect(leftoverReason(server, { now: NOW, settledAt: NOW - LEFTOVER_SERVICE_GRACE_MS })).toBe(
      'service-after-settle'
    );
    // 刚收口还在宽限期内：先不报
    expect(
      leftoverReason(server, { now: NOW, settledAt: NOW - LEFTOVER_SERVICE_GRACE_MS + 1 })
    ).toBeUndefined();
    // 会话没收口就没有「收口后」这一说
    expect(leftoverReason(server, { now: NOW })).toBeUndefined();
  });

  it('普通任务在宽限期内不算遗留，已结束的任务也不算', () => {
    const normal = task();
    expect(leftoverReason(normal, { now: NOW, settledAt: NOW - 60 * MINUTE })).toBeUndefined();
    expect(leftoverReason({ ...normal, status: 'done' }, { now: NOW })).toBeUndefined();
  });
});

describe('文案', () => {
  it('完成回传带上还在跑的命令摘要', () => {
    expect(leftoverNote([])).toBeUndefined();
    expect(
      leftoverNote([
        task({ command: 'pnpm typecheck && pnpm test' }),
        task({ command: 'python3 -m http.server 8931 --directory /tmp' }),
        task({ command: 'git status', status: 'done' }),
      ])
    ).toBe(
      '还有 2 个后台任务在跑：pnpm typecheck && pnpm test、python3 -m http.server 8931 --directory /tmp'
    );
  });

  it('巡检推送说明会话、命令与跑了多久', () => {
    const text = leftoverUpdateText(
      '项目 · 会话',
      [{ task: task({ command: 'python3 -m http.server 8931' }), reason: 'service-after-settle' }],
      NOW
    );
    expect(text).toContain('项目 · 会话');
    expect(text).toContain('python3 -m http.server 8931');
    expect(text).toContain('已跑 5 分钟');
  });

  it('时长按分钟与小时显示', () => {
    expect(ranText(0)).toBe('0 分钟');
    expect(ranText(77 * MINUTE)).toBe('1 小时 17 分钟');
    expect(ranText(120 * MINUTE)).toBe('2 小时');
  });
});
