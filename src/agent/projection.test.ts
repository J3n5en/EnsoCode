import { describe, expect, it } from 'vitest';
import { PROJECTED_TEXT_LIMIT, projectMessage } from './projection';

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

  it('enso_app 投影剥离 raw params，只保留 capability 引用', () => {
    const projected = projectMessage({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'enso-call',
          name: 'enso_app',
          arguments: {
            capability_id: 'settings.write',
            params: { apiKey: 'raw-secret', target: '/private/path' },
          },
        },
      ],
    });
    expect(projected?.content[0]).toEqual({
      type: 'toolCall',
      id: 'enso-call',
      name: 'enso_app',
      arguments: { capability_id: 'settings.write' },
    });
    expect(JSON.stringify(projected)).not.toContain('raw-secret');
    expect(JSON.stringify(projected)).not.toContain('/private/path');
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

  it('超长 text / thinking 截断，短的不动', () => {
    const ok = 'x'.repeat(PROJECTED_TEXT_LIMIT);
    const huge = `${ok}OVERFLOW`;
    expect(
      projectMessage({
        role: 'assistant',
        content: [{ type: 'text', text: ok }],
      })?.content
    ).toEqual([{ type: 'text', text: ok }]);
    const truncated = projectMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: huge },
        { type: 'thinking', thinking: huge },
      ],
    })?.content;
    expect(truncated?.[0]).toEqual({ type: 'text', text: `${ok}\n…` });
    expect(truncated?.[1]).toEqual({ type: 'thinking', text: `${ok}\n…` });
  });

  it('user 字符串 content 同样截断', () => {
    const huge = `${'y'.repeat(PROJECTED_TEXT_LIMIT)}Z`;
    expect(projectMessage({ role: 'user', content: huge })?.content).toEqual([
      { type: 'text', text: `${'y'.repeat(PROJECTED_TEXT_LIMIT)}\n…` },
    ]);
  });

  it('toolCall arguments 里的长字符串截断，path 不动', () => {
    const body = `${'a'.repeat(PROJECTED_TEXT_LIMIT)}TAIL`;
    const projected = projectMessage({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'w1',
          name: 'write',
          arguments: { path: 'big.ts', content: body },
        },
      ],
    });
    expect(projected?.content[0]).toEqual({
      type: 'toolCall',
      id: 'w1',
      name: 'write',
      arguments: { path: 'big.ts', content: `${'a'.repeat(PROJECTED_TEXT_LIMIT)}\n…` },
    });
  });

  it('compactionSummary 消息：summary 投影为 text part，tokensBefore 透出', () => {
    const projected = projectMessage({
      role: 'compactionSummary',
      summary: 'earlier work summarized',
      tokensBefore: 123456,
      timestamp: 5,
    });
    expect(projected).toEqual({
      role: 'compactionSummary',
      content: [{ type: 'text', text: 'earlier work summarized' }],
      timestamp: 5,
      tokensBefore: 123456,
    });
  });
});
