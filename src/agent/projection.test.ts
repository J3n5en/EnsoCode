import { describe, expect, it } from 'vitest';
import { projectMessage } from './projection';

describe('projectMessage', () => {
  it('assistant 消息只保留白名单字段，provider 原始数据不出 worker', () => {
    const projected = projectMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 9 } },
      stopReason: 'stop',
      timestamp: 123,
    });
    expect(projected).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      stopReason: 'stop',
      timestamp: 123,
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
    expect(projected).not.toHaveProperty('api');
    expect(projected?.usage).not.toHaveProperty('cost');
  });

  it('user 消息的字符串 content 归一为 text part', () => {
    expect(projectMessage({ role: 'user', content: '你好', timestamp: 1 })).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '你好' }],
      timestamp: 1,
    });
  });

  it('thinking part 的 thinking 字段映射为 text，签名字段被剥离', () => {
    const projected = projectMessage({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '想一想', thinkingSignature: 'secret' }],
    });
    expect(projected?.content).toEqual([{ type: 'thinking', text: '想一想' }]);
  });

  it('toolCall 的 arguments 深拷贝，改投影不影响原对象', () => {
    const args = { path: 'a.txt' };
    const projected = projectMessage({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: args }],
    });
    const part = projected?.content[0];
    expect(part).toEqual({
      type: 'toolCall',
      id: 't1',
      name: 'read',
      arguments: { path: 'a.txt' },
    });
    if (part?.type === 'toolCall') {
      (part.arguments as Record<string, unknown>).path = 'b.txt';
    }
    expect(args.path).toBe('a.txt');
  });

  it('未识别的 part 类型收敛为 unknown，不透传内容', () => {
    const projected = projectMessage({
      role: 'assistant',
      content: [{ type: 'image', data: 'base64...' }, null, 'junk'],
    });
    expect(projected?.content).toEqual([
      { type: 'unknown' },
      { type: 'unknown' },
      { type: 'unknown' },
    ]);
  });

  it('脏输入不崩：无 role、null、content 非法都能处理', () => {
    expect(projectMessage(null)).toBeNull();
    expect(projectMessage({ content: [] })).toBeNull();
    expect(projectMessage({ role: 'user', content: 42 })).toEqual({ role: 'user', content: [] });
  });
});
