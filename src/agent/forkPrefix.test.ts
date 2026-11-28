import type { Message } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { withForkPrefix } from './forkPrefix';

const tool = (name: string) => ({ name, description: name, parameters: { type: 'object' } });

const prefix = [
  {
    role: 'system',
    content: 'parent prompt',
    sections: { agents: 'parent rules' },
    toolsAdded: [tool('read'), tool('bash'), tool('subagent')],
    timestamp: 0,
  },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
    timestamp: 1,
  },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 2 },
] as unknown as Message[];

const childPatch = {
  role: 'system',
  content: '',
  sections: { addendum: 'subagent contract' },
  timestamp: 10,
} as unknown as Message;
const childTools = {
  role: 'system',
  content: '',
  toolsRemoved: [{ name: 'bash' }, { name: 'subagent' }],
  toolsAdded: [tool('message_main')],
  timestamp: 10,
} as unknown as Message;
const task = { role: 'user', content: 'do the task', timestamp: 11 } as unknown as Message;

describe('withForkPrefix', () => {
  it('前缀原样还原，子代理首轮 system 补丁降成 user 正文，请求里只剩父会话的 system 消息', () => {
    // 子会话自己的 context 变换把历史图片换成了占位：前缀字节必须换回注入时的原样
    const transformed = [
      prefix[0],
      {
        ...prefix[1],
        content: [
          { type: 'text', text: 'look' },
          { type: 'text', text: '[image]' },
        ],
      },
      prefix[2],
      childPatch,
      childTools,
      task,
    ] as Message[];
    const out = withForkPrefix(prefix, { messages: transformed });

    expect(JSON.stringify(out.messages.slice(0, prefix.length))).toBe(JSON.stringify(prefix));
    expect(out.messages.filter((m) => m.role === 'system')).toEqual([prefix[0]]);
    expect(out.messages).toHaveLength(prefix.length + 1);
    const first = out.messages[prefix.length] as { role: string; content: string };
    expect(first.role).toBe('user');
    expect(first.content).toContain('subagent contract');
    expect(first.content).toContain('- bash');
    expect(first.content).toContain('- subagent');
    expect(first.content.endsWith('do the task')).toBe(true);
  });

  it('后续轮次改写结果与首轮逐字节一致，子代理自己的前缀也稳定', () => {
    const turn1 = [...prefix, childPatch, childTools, task];
    const reply = { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 12 };
    const later = { role: 'system', content: '', toolsAdded: [tool('grep')], timestamp: 13 };
    const turn2 = [...turn1, reply, later, { role: 'user', content: 'next', timestamp: 14 }];
    const a = withForkPrefix(prefix, { messages: turn1 });
    const b = withForkPrefix(prefix, { messages: turn2 as Message[] });
    expect(JSON.stringify(b.messages.slice(0, a.messages.length))).toBe(JSON.stringify(a.messages));
    // 前缀之后子代理自己新增的 system 消息不动
    expect(b.messages).toContainEqual(later);
  });

  it('前缀对不上（子会话压缩过）或消息不够长时原样返回', () => {
    const compacted = [{ role: 'user', content: 'summary', timestamp: 99 }, task] as Message[];
    const context = { messages: compacted };
    expect(withForkPrefix(prefix, context)).toBe(context);
    const short = { messages: prefix.slice(0, 2) };
    expect(withForkPrefix(prefix, short)).toBe(short);
    const plain = { messages: [...prefix, task] };
    expect(withForkPrefix(undefined, plain)).toBe(plain);
  });

  it('前缀后紧跟的不是 user 消息时补一条 user 正文；没有补丁时不加正文', () => {
    const out = withForkPrefix(prefix, { messages: [...prefix, childPatch] });
    expect(out.messages.at(-1)).toMatchObject({ role: 'user', timestamp: 10 });
    const none = withForkPrefix(prefix, { messages: [...prefix, task] });
    expect(none.messages.at(-1)).toEqual(task);
  });
});
