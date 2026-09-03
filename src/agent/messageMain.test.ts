import { describe, expect, it, vi } from 'vitest';
import { createMessageMainTool } from './messageMain';

describe('message_main_agent 文案', () => {
  it('告知 coworker 主 agent 会经 coworker send 回复，协议双向', async () => {
    const tool = createMessageMainTool(vi.fn(), 'bob');
    expect(tool.description).toMatch(/replies? (arrive|come)s? .*coworker send/i);
    const result = await tool.execute('t1', { message: 'hi' }, undefined, undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/send/);
  });
});
