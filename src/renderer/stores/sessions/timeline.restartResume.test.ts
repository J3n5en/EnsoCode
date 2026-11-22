import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { buildTimeline } from './timeline';

const user: ProjectedMessage = {
  role: 'user',
  content: [{ type: 'text', text: '继续改' }],
  timestamp: 1,
} as ProjectedMessage;
const aborted: ProjectedMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: '先看一下' }],
  stopReason: 'aborted',
  errorMessage: 'This operation was aborted',
  timestamp: 2,
} as ProjectedMessage;
const system = { role: 'system', content: [], timestamp: 3 } as unknown as ProjectedMessage;
const resumed: ProjectedMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: '接着做完了' }],
  stopReason: 'stop',
  timestamp: 4,
} as ProjectedMessage;

const errors = (messages: ProjectedMessage[], running = false) =>
  buildTimeline(messages, running)
    .filter((item) => item.kind === 'error')
    .map((item) => (item as { text: string }).text);

describe('重启中止后续跑的回复', () => {
  it('续跑前插了一条 system（工具集变化）：仍算已重试，不留「This operation was aborted」', () => {
    expect(errors([user, aborted, system, resumed])).toEqual([]);
  });

  it('没有续跑：中止错误照常显示', () => {
    expect(errors([user, aborted])).toEqual(['This operation was aborted']);
    expect(errors([user, aborted, system, user])).toEqual(['This operation was aborted']);
  });
});
