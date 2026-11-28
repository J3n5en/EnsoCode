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
  toolsRemoved: [{ name: 'bash' }, { name: 'subagent' }],
  toolsAdded: [tool('message_main_agent')],
  timestamp: 10,
} as unknown as Message;
const task = { role: 'user', content: 'do the task', timestamp: 11 } as unknown as Message;

describe('withForkPrefix', () => {
  it('前缀换回注入时的原样字节，子代理自己的 system 增量与后续消息原样保留', () => {
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
      task,
    ] as Message[];
    const out = withForkPrefix(prefix, { messages: transformed });

    expect(JSON.stringify(out.messages.slice(0, prefix.length))).toBe(JSON.stringify(prefix));
    // 子代理独有工具（message_main_agent）与禁用工具都靠这条增量生效，不能丢
    expect(out.messages.slice(prefix.length)).toEqual([childPatch, task]);
  });

  it('后续轮次改写结果与首轮逐字节一致', () => {
    const turn1 = [...prefix, childPatch, task];
    const reply = { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 12 };
    const turn2 = [...turn1, reply, { role: 'user', content: 'next', timestamp: 14 }];
    const a = withForkPrefix(prefix, { messages: turn1 });
    const b = withForkPrefix(prefix, { messages: turn2 as Message[] });
    expect(JSON.stringify(b.messages.slice(0, a.messages.length))).toBe(JSON.stringify(a.messages));
  });

  it('前缀对不上（子会话压缩过）、消息不够长或没有前缀时原样返回', () => {
    const compacted = [{ role: 'user', content: 'summary', timestamp: 99 }, task] as Message[];
    const context = { messages: compacted };
    expect(withForkPrefix(prefix, context)).toBe(context);
    const short = { messages: prefix.slice(0, 2) };
    expect(withForkPrefix(prefix, short)).toBe(short);
    const plain = { messages: [...prefix, task] };
    expect(withForkPrefix(undefined, plain)).toBe(plain);
    expect(withForkPrefix([], plain)).toBe(plain);
    const roleSwap = { messages: [prefix[0], prefix[2], prefix[1], task] };
    expect(withForkPrefix(prefix, roleSwap)).toBe(roleSwap);
  });
});
