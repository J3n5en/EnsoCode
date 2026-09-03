import { describe, expect, it, vi } from 'vitest';
import { createMessageMainTool } from './messageMain';

describe('message_main_agent 文案', () => {
  it('告知 coworker 主 agent 会经 coworker send 回复，协议双向', async () => {
    const tool = createMessageMainTool(vi.fn(), 'bob');
    expect(tool.description).toMatch(/replies? (arrive|come)s? .*coworker send/i);
    expect(tool.promptSnippet).toMatch(/coworker send/);
    const result = await tool.execute('t1', { message: 'hi' }, undefined, undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/send/);
  });
});

describe('message_main_agent 在 isParentWaiting 下的行为', () => {
  it('isParentWaiting 为 true 时不调用 notify,返回文案含 waiting', async () => {
    const notify = vi.fn();
    const tool = createMessageMainTool(notify, 'bob', () => true);
    const result = await tool.execute('t1', { message: 'hi' }, undefined, undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(notify).not.toHaveBeenCalled();
    expect(text).toMatch(/waiting/);
  });

  it('isParentWaiting 为 false 时维持原行为,仍调用 notify', async () => {
    const notify = vi.fn();
    const tool = createMessageMainTool(notify, 'bob', () => false);
    await tool.execute('t1', { message: 'hi' }, undefined, undefined, {} as never);
    expect(notify).toHaveBeenCalled();
  });

  it('缺省第三参数时保持旧行为,仍调用 notify', async () => {
    const notify = vi.fn();
    const tool = createMessageMainTool(notify, 'bob');
    await tool.execute('t1', { message: 'hi' }, undefined, undefined, {} as never);
    expect(notify).toHaveBeenCalled();
  });

  it('description 提到主 agent 已在等待时是 no-op', () => {
    const tool = createMessageMainTool(vi.fn(), 'bob', () => true);
    expect(tool.description).toMatch(/no-op/i);
  });
});
