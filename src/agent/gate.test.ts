import { describe, expect, it } from 'vitest';
import { OperationGate } from './gate';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('OperationGate', () => {
  it('同一 key 的任务串行执行', async () => {
    const gate = new OperationGate();
    const order: string[] = [];
    const first = gate.run('s1', async () => {
      await sleep(20);
      order.push('a');
    });
    const second = gate.run('s1', async () => {
      order.push('b');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['a', 'b']);
  });

  it('不同 key 的任务并行执行', async () => {
    const gate = new OperationGate();
    const order: string[] = [];
    const slow = gate.run('s1', async () => {
      await sleep(30);
      order.push('slow');
    });
    const fast = gate.run('s2', async () => {
      order.push('fast');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['fast', 'slow']);
  });

  it('链上任务抛错不阻断后续任务，错误仍抛给调用方', async () => {
    const gate = new OperationGate();
    const failing = gate.run('s1', async () => {
      throw new Error('boom');
    });
    const after = gate.run('s1', async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
  });
});
