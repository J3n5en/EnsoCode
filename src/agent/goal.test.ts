import { describe, expect, it } from 'vitest';
import { createGoalTools } from './goal';

const run = async (tools: ReturnType<typeof createGoalTools>, name: string) => {
  const tool = tools.find((entry) => entry.name === name);
  const result = await tool?.execute(
    'call',
    { summary: 'done', reason: 'x' } as never,
    undefined,
    undefined,
    {} as never
  );
  return (result?.content[0] as { text?: string } | undefined)?.text;
};

describe('goal_complete 收尾清单', () => {
  it('目标完成时附上还没表态的后台任务清单；其它信号不附', async () => {
    const tools = createGoalTools(
      () => {},
      undefined,
      () => '<background-tasks-wrap-up>\n- t1: pnpm dev\n</background-tasks-wrap-up>'
    );
    expect(await run(tools, 'goal_complete')).toBe(
      'Goal marked complete.\n\n<background-tasks-wrap-up>\n- t1: pnpm dev\n</background-tasks-wrap-up>'
    );
    expect(await run(tools, 'goal_blocked')).toBe('Goal marked blocked.');
    expect(
      await run(
        createGoalTools(
          () => {},
          undefined,
          () => undefined
        ),
        'goal_complete'
      )
    ).toBe('Goal marked complete.');
  });
});
