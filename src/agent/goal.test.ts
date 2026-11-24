import { describe, expect, it } from 'vitest';
import { createGoalTools } from './goal';

const complete = (tools: ReturnType<typeof createGoalTools>) =>
  tools.find((entry) => entry.name === 'goal_complete');

const textOf = (result: { content: readonly { type: string; text?: string }[] } | undefined) => {
  const block = result?.content[0];
  return block && 'text' in block ? block.text : undefined;
};

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

describe('goal_complete 结构化结果', () => {
  it('带 result 时 emit 收到收窄后的结果', async () => {
    const calls: unknown[][] = [];
    const tools = createGoalTools((...args) => {
      calls.push(args);
    });
    const text = await complete(tools)?.execute(
      'call',
      { summary: 'done', result: { summary: 'shipped', commits: ['AbC1234'] } } as never,
      undefined,
      undefined,
      {} as never
    );
    expect(textOf(text)).toBe('Goal marked complete.');
    expect(calls).toEqual([['complete', 'done', { summary: 'shipped', commits: ['abc1234'] }]]);
  });

  it('不带 result 照常只交摘要', async () => {
    const calls: unknown[][] = [];
    const tools = createGoalTools((...args) => {
      calls.push(args);
    });
    expect(await run(tools, 'goal_complete')).toBe('Goal marked complete.');
    expect(calls).toEqual([['complete', 'done']]);
  });

  it('非法 result 不 emit，并把字段路径交还模型', async () => {
    const calls: unknown[][] = [];
    const tools = createGoalTools((...args) => {
      calls.push(args);
    });
    const text = await complete(tools)?.execute(
      'call',
      { summary: 'done', result: { extra: true } } as never,
      undefined,
      undefined,
      {} as never
    );
    expect(calls).toEqual([]);
    expect(textOf(text)).toContain('extra');
  });

  it('prepareArguments 把 JSON 字符串形式的 result 解析成对象', () => {
    const tool = complete(createGoalTools(() => {}));
    expect(tool).toBeDefined();
    if (!tool) return;
    expect(tool.prepareArguments?.({ summary: 'done', result: '{"commits":["AbC1234"]}' })).toEqual(
      {
        summary: 'done',
        result: { commits: ['AbC1234'] },
      }
    );
    const properties = (tool.parameters as { properties?: Record<string, { type?: string }> })
      .properties;
    expect(properties?.result?.type).toBe('object');
  });

  it('needsUser 只放用户本人要决定或亲手做的事，可选善后进 followUps', () => {
    const tool = complete(createGoalTools(() => {}));
    const parameters = tool?.parameters as
      | { properties?: Record<string, { properties?: Record<string, { description?: string }> }> }
      | undefined;
    const result = parameters?.properties?.result;
    const needsUser = result?.properties?.needsUser?.description ?? '';
    const followUps = result?.properties?.followUps?.description ?? '';
    expect(needsUser).toMatch(/only the user/i);
    expect(needsUser).toContain('followUps');
    expect(needsUser).toMatch(/imperative/i);
    expect(followUps).toMatch(/optional/i);
    expect(tool?.description).toContain('needsUser');
  });
});
