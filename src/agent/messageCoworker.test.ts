import { describe, expect, it, vi } from 'vitest';
import { createMessageCoworkerTool } from './messageCoworker';

function textOf(result: { content: Array<{ text?: string }> }): string {
  return (result.content[0] as { text: string }).text;
}

describe('message_coworker', () => {
  it('description 说明回信走对方的 message_coworker，不是主管 send', () => {
    const tool = createMessageCoworkerTool({
      from: 'alice',
      peers: () => ['bob'],
      notify: vi.fn(),
    });
    expect(tool.name).toBe('message_coworker');
    expect(tool.description).toMatch(/message_coworker/i);
    expect(tool.description).not.toMatch(/coworker send/i);
    expect(tool.promptSnippet).toMatch(/message_coworker/i);
  });

  it('发给存在的同事会 notify，文案含 from 与 body', async () => {
    const notify = vi.fn();
    const tool = createMessageCoworkerTool({
      from: 'alice',
      peers: () => ['bob', 'carol'],
      notify,
    });
    const text = textOf(
      await tool.execute(
        't1',
        { to: 'bob', text: 'need the lock' },
        undefined,
        undefined,
        {} as never
      )
    );
    expect(notify).toHaveBeenCalledWith('bob', 'Message from coworker "alice":\nneed the lock');
    expect(text).toMatch(/delivered to coworker "bob"/);
    expect(text).toMatch(/message_coworker/);
  });

  it('未知 to 不 notify，回执含 roster', async () => {
    const notify = vi.fn();
    const tool = createMessageCoworkerTool({
      from: 'alice',
      peers: () => ['bob'],
      notify,
    });
    const text = textOf(
      await tool.execute('t1', { to: 'ghost', text: 'hi' }, undefined, undefined, {} as never)
    );
    expect(notify).not.toHaveBeenCalled();
    expect(text).toMatch(/unknown coworker "ghost"/i);
    expect(text).toMatch(/bob/);
  });

  it('发给自己不 notify，回执含 roster', async () => {
    const notify = vi.fn();
    const tool = createMessageCoworkerTool({
      from: 'alice',
      peers: () => ['bob'],
      notify,
    });
    const text = textOf(
      await tool.execute('t1', { to: 'alice', text: 'hi' }, undefined, undefined, {} as never)
    );
    expect(notify).not.toHaveBeenCalled();
    expect(text).toMatch(/yourself|self/i);
    expect(text).toMatch(/bob/);
  });
});
