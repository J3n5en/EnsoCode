import type { AgentSessionCustomEntry, ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { buildTimeline } from './timeline';
import { users } from './timeline.testUtils';

const W = [
  '<background-tasks-wrap-up>',
  'These background tasks are still running and you have not said what happens to them:',
  '- task-1-a: pnpm dev (running 0m)',
  'Call task_settle once for all of them: stop each one you no longer need, or keep it with a one-line reason the user will see. Do not leave them undeclared.',
  '</background-tasks-wrap-up>',
].join('\n');

const at = (role: string, text: string, timestamp: number, extra = {}): ProjectedMessage =>
  ({ role, content: [{ type: 'text', text }], timestamp, ...extra }) as ProjectedMessage;
const nudge = (time: number): AgentSessionCustomEntry => ({
  kind: 'task-wrap-up-nudge',
  count: 1,
  at: time,
});
const hostFlags = (messages: ProjectedMessage[], entries: AgentSessionCustomEntry[]) =>
  users(buildTimeline(messages, false, entries)).map((item) => item.hostTaskWrapUp === true);

describe('收尾清单的来源', () => {
  it('收尾提醒之后宿主搭上清单的那条消息标为宿主注入，正文原样保留', () => {
    const text = `${W}\n\n继续`;
    const timeline = buildTimeline(
      [at('user', '跑起来', 1), at('assistant', '好', 2), at('user', text, 10)],
      false,
      [nudge(5)]
    );
    const rows = users(timeline);
    expect(rows.map((item) => item.hostTaskWrapUp === true)).toEqual([false, true]);
    expect(rows[1]?.text).toBe(text);
  });

  it('没有收尾提醒时，用户自己贴的同样文字照常是用户消息', () => {
    expect(hostFlags([at('user', W, 10)], [])).toEqual([false]);
    expect(hostFlags([at('user', W, 3)], [nudge(5)])).toEqual([false]);
  });

  it('一次提醒只配一条：清单已挂到工具结果上后，再贴的文字不算宿主注入', () => {
    expect(
      hostFlags(
        [
          at('toolResult', `<system-reminder>\n${W}\n</system-reminder>\n\nok`, 6, {
            toolCallId: 'c1',
            toolName: 'bash',
          }),
          at('user', W, 10),
        ],
        [nudge(5)]
      )
    ).toEqual([false]);
    expect(hostFlags([at('user', `${W}\n\na`, 10), at('user', W, 20)], [nudge(5)])).toEqual([
      true,
      false,
    ]);
  });

  it('中间夹着宿主直接投递的通知时，清单仍落在之后那条消息上', () => {
    expect(
      hostFlags(
        [
          at('user', '<agent-notification>\ndone\n</agent-notification>', 6),
          at('user', `${W}\n\n继续`, 10),
        ],
        [nudge(5)]
      )
    ).toEqual([false, true]);
  });
});
