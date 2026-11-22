import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { buildTimeline, foldTimeline } from './timeline';

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

  it('已续跑的半截回复折叠成一行，展开看原文；续写照常显示', () => {
    const half: ProjectedMessage = {
      ...aborted,
      content: [
        { type: 'thinking', text: '想一想' },
        { type: 'text', text: '先看一下' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
      ],
      restartResumed: true,
    };
    const items = buildTimeline([user, half, system, resumed], false);
    expect(items.map((item) => item.kind)).toEqual(['user', 'resumed-reply', 'text']);
    expect(items[1]).toMatchObject({
      kind: 'resumed-reply',
      thinking: '想一想',
      text: '先看一下',
      tools: [{ name: 'read' }],
      expanded: false,
    });
    const folded = foldTimeline(items, false, new Set([items[1].key]));
    expect(folded.find((item) => item.kind === 'resumed-reply')).toMatchObject({
      expanded: true,
    });
    expect(
      foldTimeline(items, false, new Set()).find((item) => item.kind === 'resumed-reply')
    ).toMatchObject({ expanded: false });
  });

  it('用户点停止等其它中止：照原样显示，不折叠', () => {
    const stopped = buildTimeline([user, aborted, user, resumed], false);
    expect(stopped.some((item) => item.kind === 'resumed-reply')).toBe(false);
    expect(stopped.some((item) => item.kind === 'text' && item.text === '先看一下')).toBe(true);
  });
});
