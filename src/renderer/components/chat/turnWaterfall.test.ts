import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { turnWaterfall } from './turnWaterfall';

const user = (timestamp: number): ProjectedMessage => ({
  role: 'user',
  content: [{ type: 'text', text: 'go' }],
  timestamp,
});
const step = (start: number, end: number): ProjectedMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'x' }],
  timestamp: start,
  timing: { stepStartMs: start, completedMs: end },
});
const tool = (name: string, end: number, durationMs: number): ProjectedMessage => ({
  role: 'toolResult',
  content: [{ type: 'text', text: 'ok' }],
  toolName: name,
  toolCallId: `${name}-${end}`,
  timestamp: end,
  toolDurationMs: durationMs,
});

describe('turnWaterfall', () => {
  it('按时间排出模型与工具，空档超过 1 秒记为等待，最慢的一步单独标出', () => {
    const messages = [
      user(0),
      step(0, 5_000),
      // 审批等了 20 秒，命令跑了 60 秒
      tool('bash', 85_000, 60_000),
      step(85_500, 90_000),
    ];
    const result = turnWaterfall(messages, 3);
    expect(result).toMatchObject({ start: 0, end: 90_000 });
    expect(result?.bars.map((bar) => [bar.kind, bar.label, bar.start, bar.end])).toEqual([
      ['model', '', 0, 5_000],
      ['wait', '', 5_000, 25_000],
      ['tool', 'bash', 25_000, 85_000],
      ['model', '', 85_500, 90_000],
    ]);
    expect(result?.slowest).toBe(result?.bars[2].key);
  });

  it('ask_user 的耗时是等人，不算工具', () => {
    const result = turnWaterfall(
      [user(0), step(0, 1_000), tool('ask_user', 31_000, 30_000), step(31_000, 32_000)],
      3
    );
    expect(result?.bars.map((bar) => bar.kind)).toEqual(['model', 'wait', 'model']);
    expect(result?.bars[1].label).toBe('ask_user');
    expect(result?.bars[result.bars.length - 1].key).not.toBe(result?.slowest);
  });

  it('只取这一轮：从上一条用户消息之后开始', () => {
    const messages = [
      user(0),
      step(0, 1_000),
      user(10_000),
      step(10_000, 12_000),
      tool('read', 12_500, 400),
      step(12_600, 13_000),
    ];
    expect(turnWaterfall(messages, 5)?.start).toBe(10_000);
  });

  it('单步轮次按 等首字 / 思考 / 输出 分段，只有一步时不标最慢', () => {
    const only: ProjectedMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      timestamp: 0,
      timing: { stepStartMs: 0, firstTokenMs: 3_100, thinkingEndMs: 3_800, completedMs: 4_100 },
    };
    const result = turnWaterfall([user(0), only], 1);
    expect(result?.bars).toHaveLength(1);
    expect(result?.bars[0].phases).toEqual({ firstTokenMs: 3_100, thinkingEndMs: 3_800 });
    expect(result?.slowest).toBeUndefined();
  });

  it('没有计时打点（历史重载的会话）时不给', () => {
    const bare: ProjectedMessage = { role: 'assistant', content: [], timestamp: 1 };
    expect(turnWaterfall([user(0), bare], 1)).toBeNull();
    expect(turnWaterfall([user(0), step(0, 1_000)], 1)).toBeNull();
  });
});
