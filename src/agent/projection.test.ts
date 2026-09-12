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

  it('透出 pi 的 ttft/duration，供状态栏吞吐与 OMP 同口径', () => {
    expect(
      projectMessage({
        role: 'assistant',
        content: [],
        ttft: 220,
        duration: 1800,
      })
    ).toMatchObject({ ttft: 220, duration: 1800 });
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

  it('edit toolResult 将前后文本投影为 editDiff 且不透传 patch', () => {
    const projected = projectMessage({
      role: 'toolResult',
      toolName: 'edit',
      toolCallId: 'edit-1',
      content: [{ type: 'text', text: 'ok' }],
      details: { oldText: 'before\n', diff: 'after\n', patch: '[a.ts#ABCD]\nPUT...' },
    });
    expect(projected).toMatchObject({
      role: 'toolResult',
      toolName: 'edit',
      toolCallId: 'edit-1',
      content: [{ type: 'text', text: 'ok' }],
      editDiff: { oldText: 'before\n', newText: 'after\n' },
    });
    expect(projected).not.toHaveProperty('details');
    expect(JSON.stringify(projected)).not.toContain('PUT...');
  });

  it('脏详情、不完整详情与非 edit 工具都不投影 editDiff', () => {
    const dirtyDetails = [
      { diff: 'after\n' },
      { oldText: 1, diff: 'after\n' },
      { oldText: 'before\n', diff: 2 },
      null,
    ];
    for (const details of dirtyDetails) {
      expect(
        projectMessage({ role: 'toolResult', toolName: 'edit', content: [], details })
      ).not.toHaveProperty('editDiff');
    }
    expect(
      projectMessage({
        role: 'toolResult',
        toolName: 'read',
        content: [],
        details: { oldText: 'before\n', diff: 'after\n' },
      })
    ).not.toHaveProperty('editDiff');
  });

  it('editDiff 前后文本按 PROJECTED_TEXT_LIMIT 截断', () => {
    const prefix = 'x'.repeat(PROJECTED_TEXT_LIMIT);
    const projected = projectMessage({
      role: 'toolResult',
      toolName: 'edit',
      content: [],
      details: { oldText: `${prefix}OLD`, diff: `${prefix}NEW` },
    });
    expect((projected as unknown as { editDiff?: unknown }).editDiff).toEqual({
      oldText: `${prefix}\n…`,
      newText: `${prefix}\n…`,
    });
  });

  it('compactionSummary：fromHook 投影为 verified', () => {
    expect(
      projectMessage({
        role: 'compactionSummary',
        summary: 'v',
        tokensBefore: 1,
        fromHook: true,
      })
    ).toMatchObject({ verified: true });
    expect(
      projectMessage({
        role: 'compactionSummary',
        summary: 'n',
        tokensBefore: 1,
      })
    ).not.toHaveProperty('verified');
  });

  it('compactionSummary：compactionSource=memory 投影为 memory，其它值忽略', () => {
    expect(
      projectMessage({
        role: 'compactionSummary',
        summary: 'm',
        tokensBefore: 1,
        fromHook: true,
        compactionSource: 'memory',
      })
    ).toMatchObject({ verified: true, memory: true });
    expect(
      projectMessage({
        role: 'compactionSummary',
        summary: 'x',
        tokensBefore: 1,
        fromHook: true,
        compactionSource: 'bogus',
      })
    ).not.toHaveProperty('memory');
  });
});
