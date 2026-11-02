import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { RunawayGuard, runawayReminderText, withRunawayGuard } from './runawayGuard';

function textTool(
  name: string,
  run: (params: unknown) => { text: string; isError?: boolean }
): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} } as ToolDefinition['parameters'],
    async execute(_id, params) {
      const result = run(params);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: undefined,
        ...(result.isError ? { isError: true as const } : {}),
      };
    },
  };
}

describe('RunawayGuard', () => {
  it('连续三次相同工具、参数且结果不变才提醒，只提醒一次', () => {
    const guard = new RunawayGuard();
    const args = { path: 'a.ts' };
    expect(guard.observe('read', args, { text: 'same' })).toBeUndefined();
    expect(guard.observe('read', args, { text: 'same' })).toBeUndefined();
    const reminder = guard.observe('read', args, { text: 'same' });
    expect(reminder?.text).toContain('[runaway guard]');
    expect(reminder?.stop).toBe(false);
    expect(guard.observe('read', args, { text: 'same' })).toBeUndefined();
  });

  it('同参数但结果在变（轮询构建状态）不算 runaway', () => {
    const guard = new RunawayGuard();
    const args = { command: 'gh run view 1 --json status' };
    for (let i = 0; i < 8; i++) {
      expect(guard.observe('bash', args, { text: `status: step ${i}` })).toBeUndefined();
    }
  });

  it('换工具或换参数会打断动作连击', () => {
    const guard = new RunawayGuard();
    const args = { command: 'ls' };
    guard.observe('bash', args, { text: 'a' });
    guard.observe('bash', args, { text: 'a' });
    guard.observe('grep', { pattern: 'x' }, { text: 'g' });
    expect(guard.observe('bash', args, { text: 'a' })).toBeUndefined();
    expect(guard.observe('bash', args, { text: 'a' })).toBeUndefined();
    expect(guard.observe('bash', args, { text: 'a' })?.text).toContain('[runaway guard]');
  });

  it('提醒后仍连续到六次：终止本轮，之后每次都终止', () => {
    const guard = new RunawayGuard();
    const args = { path: 'a.ts' };
    const verdicts = Array.from({ length: 7 }, () => guard.observe('read', args, { text: 'same' }));
    expect(verdicts.slice(0, 2)).toEqual([undefined, undefined]);
    expect(verdicts[2]?.stop).toBe(false);
    expect(verdicts.slice(3, 5)).toEqual([undefined, undefined]);
    expect(verdicts[5]?.stop).toBe(true);
    expect(verdicts[5]?.text).toMatch(/Stopped this turn/);
    expect(verdicts[6]?.stop).toBe(true);
  });

  it('同一错误家族六次终止', () => {
    const guard = new RunawayGuard();
    const err = { text: 'ENOENT: no such file', isError: true };
    const verdicts = Array.from({ length: 6 }, (_, i) =>
      guard.observe('bash', { command: `try ${i}` }, err)
    );
    expect(verdicts[2]?.text).toContain('same error');
    expect(verdicts[5]?.stop).toBe(true);
  });

  it('阻塞式 task_output 等待与快照轮询同一阈值：三次提醒、六次终止', () => {
    const guard = new RunawayGuard();
    const snap = { text: '[running] (no output yet)' };
    const blocking = Array.from({ length: 6 }, () =>
      guard.observe('task_output', { taskId: 't', timeout_ms: 30000 }, snap)
    );
    expect(blocking[2]?.stop).toBe(false);
    expect(blocking[2]?.text).toMatch(/notified automatically/);
    expect(blocking.slice(0, 5).some((verdict) => verdict?.stop)).toBe(false);
    expect(blocking[5]?.stop).toBe(true);

    const quick = new RunawayGuard();
    const polls = Array.from({ length: 6 }, () =>
      quick.observe('task_output', { taskId: 't' }, snap)
    );
    expect(polls[5]?.stop).toBe(true);
  });

  it('computer 相同 code 但截图 hash 变了不算 runaway', () => {
    const guard = new RunawayGuard();
    const args = { code: 'await win.screenshot()' };
    expect(guard.observe('computer', args, { text: 'hash a' })).toBeUndefined();
    expect(guard.observe('computer', args, { text: 'hash b' })).toBeUndefined();
    expect(guard.observe('computer', args, { text: 'hash c' })).toBeUndefined();
  });

  it('computer 三次相同结果文本才算无进展', () => {
    const guard = new RunawayGuard();
    const args = { code: 'await win.screenshot()' };
    const snap = { text: 'w1 10×10 hash deadbeef' };
    expect(guard.observe('computer', args, snap)).toBeUndefined();
    expect(guard.observe('computer', args, snap)).toBeUndefined();
    expect(guard.observe('computer', args, snap)?.text).toContain('no observable progress');
  });

  it('同一错误家族连续三次提醒', () => {
    const guard = new RunawayGuard();
    const args = { command: 'npm test' };
    const err = { text: 'ENOENT: no such file', isError: true };
    expect(guard.observe('bash', args, err)).toBeUndefined();
    expect(guard.observe('bash', { command: 'npm test -- --run' }, err)).toBeUndefined();
    expect(guard.observe('bash', { command: 'pnpm test' }, err)?.text).toContain('same error');
  });

  it('task_output 轮询无进展三次提醒，且禁止写入 Memory', () => {
    const guard = new RunawayGuard();
    const args = { taskId: 'task-1' };
    const snap = { text: '[running] Full log: /tmp/x\n(no output yet)' };
    expect(guard.observe('task_output', args, snap)).toBeUndefined();
    expect(guard.observe('task_output', args, snap)).toBeUndefined();
    const reminder = guard.observe('task_output', args, snap)?.text;
    expect(reminder).toContain('task_output');
    expect(reminder).toMatch(/notified automatically/i);
    expect(reminder).toMatch(/Do not save/i);
  });

  it('resetTurn 后可以再提醒', () => {
    const guard = new RunawayGuard();
    const args = { path: 'a.ts' };
    guard.observe('read', args, { text: 'x' });
    guard.observe('read', args, { text: 'x' });
    expect(guard.observe('read', args, { text: 'x' })).toBeTruthy();
    guard.resetTurn();
    guard.observe('read', args, { text: 'x' });
    guard.observe('read', args, { text: 'x' });
    expect(guard.observe('read', args, { text: 'x' })?.text).toContain('[runaway guard]');
  });

  it('withRunawayGuard 把提醒垫到工具结果顶部', async () => {
    const guard = new RunawayGuard();
    const wrapped = withRunawayGuard(
      textTool('read', () => ({ text: 'body' })),
      guard
    );
    const args = { path: 'a.ts' };
    await wrapped.execute('1', args, undefined, undefined, undefined as never);
    await wrapped.execute('2', args, undefined, undefined, undefined as never);
    const third = await wrapped.execute('3', args, undefined, undefined, undefined as never);
    const text = third.content[0];
    expect(text?.type).toBe('text');
    if (text?.type === 'text') {
      expect(text.text.startsWith(runawayReminderText('unchanged_progress_repeat'))).toBe(true);
      expect(text.text).toContain('body');
    }
    expect(third.terminate).toBeUndefined();
  });

  it('withRunawayGuard 终止时结果带 terminate，让 pi 在本批工具后结束本轮', async () => {
    const guard = new RunawayGuard();
    const wrapped = withRunawayGuard(
      textTool('read', () => ({ text: 'body' })),
      guard
    );
    let last: Awaited<ReturnType<typeof wrapped.execute>> | undefined;
    for (let i = 0; i < 6; i++) {
      last = await wrapped.execute(
        `${i}`,
        { path: 'a.ts' },
        undefined,
        undefined,
        undefined as never
      );
    }
    expect(last?.terminate).toBe(true);
    const text = last?.content[0];
    expect(text?.type === 'text' && text.text).toMatch(/Stopped this turn/);
  });
});
