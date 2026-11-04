import { describe, expect, it } from 'vitest';
import {
  type ContextMessage,
  pruneHistoricalImages,
  sanitizeContextMessages,
} from './imageContext';

const img = (data = 'AAAA', mimeType = 'image/png') => ({ type: 'image', data, mimeType });
const text = (t: string) => ({ type: 'text', text: t });
const user = (...content: unknown[]): ContextMessage => ({ role: 'user', content });
const assistant = (calls: Array<{ id: string; name: string; args?: unknown }>): ContextMessage => ({
  role: 'assistant',
  content: calls.map((c) => ({ type: 'toolCall', id: c.id, name: c.name, arguments: c.args })),
});
const toolResult = (
  toolCallId: string,
  toolName: string,
  ...content: unknown[]
): ContextMessage => ({
  role: 'toolResult',
  toolCallId,
  toolName,
  content,
});
const images = (m: ContextMessage) =>
  Array.isArray(m.content) ? m.content.filter((b) => (b as { type: string }).type === 'image') : [];
const texts = (m: ContextMessage) =>
  Array.isArray(m.content)
    ? m.content
        .filter((b) => (b as { type: string }).type === 'text')
        .map((b) => (b as { text: string }).text)
    : [];

describe('pruneHistoricalImages', () => {
  // 真实场景：cursor2api 代理把 image block 按 base64 字符计 token，一张 1.7MB 的 read 结果
  // 直接 Input token limit exceeded；pi 的 findCutPoint 又只按 1200 tokens 估图片，
  // 每次 compaction 都把它留在保留段里，压多少次都爆。
  it('历史轮工具结果里的图片换成带路径的文本占位，当前轮原样保留', () => {
    const messages: ContextMessage[] = [
      user(text('看看这张图')),
      assistant([{ id: 'c1', name: 'read', args: { path: 'C:\\tmp\\old.png' } }]),
      toolResult('c1', 'read', text('Read image file [image/png]'), img('OLD')),
      user(text('继续')),
      assistant([{ id: 'c2', name: 'read', args: { path: 'C:\\tmp\\new.png' } }]),
      toolResult('c2', 'read', text('Read image file [image/png]'), img('NEW')),
    ];
    const out = pruneHistoricalImages(messages);
    expect(images(out[2])).toHaveLength(0);
    expect(texts(out[2])[0]).toBe('Read image file [image/png]');
    expect(texts(out[2])[1]).toMatch(/image omitted from context/);
    expect(texts(out[2])[1]).toContain('image/png');
    expect(texts(out[2])[1]).toContain('C:\\tmp\\old.png');
    expect(images(out[5])).toHaveLength(1);
  });

  it('没有历史图片时返回原数组引用（不破坏缓存前缀）', () => {
    const messages: ContextMessage[] = [
      user(text('a')),
      assistant([{ id: 'c1', name: 'read', args: { path: 'x.ts' } }]),
      toolResult('c1', 'read', text('code')),
      user(text('b')),
    ];
    expect(pruneHistoricalImages(messages)).toBe(messages);
  });

  it('用户贴的图片保留最近两条 user 消息里的，更早的换占位', () => {
    const messages: ContextMessage[] = [
      user(text('第一张'), img('U1')),
      { role: 'assistant', content: [text('ok')] },
      user(text('第二张'), img('U2')),
      { role: 'assistant', content: [text('ok')] },
      user(text('第三张'), img('U3')),
    ];
    const out = pruneHistoricalImages(messages);
    expect(images(out[0])).toHaveLength(0);
    expect(texts(out[0])[1]).toMatch(/image omitted from context/);
    expect(images(out[2])).toHaveLength(1);
    expect(images(out[4])).toHaveLength(1);
  });

  it('找不到 user 消息（无法判定当前轮）时不动任何东西', () => {
    const messages: ContextMessage[] = [
      assistant([{ id: 'c1', name: 'read', args: { path: 'a.png' } }]),
      toolResult('c1', 'read', img('X')),
    ];
    expect(pruneHistoricalImages(messages)).toBe(messages);
  });

  it('非 read 工具（截图/MCP）没有路径时占位只写工具名', () => {
    const messages: ContextMessage[] = [
      user(text('截图')),
      assistant([{ id: 'c1', name: 'browser_screenshot', args: {} }]),
      toolResult('c1', 'browser_screenshot', img('SHOT', 'image/jpeg')),
      user(text('继续')),
    ];
    const out = pruneHistoricalImages(messages);
    expect(images(out[2])).toHaveLength(0);
    expect(texts(out[2])[0]).toContain('browser_screenshot');
    expect(texts(out[2])[0]).toContain('image/jpeg');
  });

  it('computer 截图占位不叫人 re-read file，提示重新截图', () => {
    const messages: ContextMessage[] = [
      user(text('点一下')),
      assistant([{ id: 'c1', name: 'computer', args: { code: 'await desktop.screenshot()' } }]),
      toolResult('c1', 'computer', img('SHOT')),
      assistant([{ id: 'c0', name: 'computer', args: { code: 'await desktop.screenshot()' } }]),
      toolResult('c0', 'computer', img('OLDER')),
      user(text('继续')),
    ];
    const out = pruneHistoricalImages(messages);
    expect(images(out[2])).toHaveLength(0);
    expect(texts(out[2])[0]).toContain('computer');
    expect(texts(out[2])[0]).not.toMatch(/re-read the file/);
    expect(texts(out[2])[0]).toMatch(/screenshot/i);
    expect(images(out[4])).toHaveLength(1);
  });

  it('历史轮保留最近一张 computer 截图', () => {
    const messages: ContextMessage[] = [
      user(text('点')),
      assistant([{ id: 'c1', name: 'computer', args: { code: 'await desktop.screenshot()' } }]),
      toolResult('c1', 'computer', img('OLD')),
      user(text('再点')),
      assistant([{ id: 'c2', name: 'computer', args: { code: 'await desktop.screenshot()' } }]),
      toolResult('c2', 'computer', img('NEW')),
    ];
    const out = pruneHistoricalImages(messages);
    expect(images(out[2])).toHaveLength(1);
    expect(images(out[5])).toHaveLength(1);
  });

  it('脏输入不崩：content 是字符串或缺失的消息原样通过', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: 'plain' },
      { role: 'toolResult', toolCallId: 'x', toolName: 'read' } as ContextMessage,
      { role: 'assistant', content: [text('a')] },
      user(text('now')),
    ];
    expect(pruneHistoricalImages(messages)).toBe(messages);
  });
});

describe('sanitizeContextMessages', () => {
  // 真实场景：signed thinking + toolCall、没有 text 的 assistant 被无差别补 text:''，
  // Kimi 的 Responses 网关下一轮直接 400（$.input[2].content[0].text = ''）。
  // 空 message 兼容只属于 xAI openai-responses 的 wire 出口，通用清洗不能塞进上下文。
  it('signed thinking 后直接 toolCall、没有 text 时保持原样，不补空 text', () => {
    const thinking = {
      type: 'thinking',
      thinking: 'wait',
      thinkingSignature: '{"id":"rs_1","type":"reasoning"}',
    };
    const call = { type: 'toolCall', id: 'c1', name: 'browser_cdp', arguments: {} };
    const messages: ContextMessage[] = [
      user(text('go')),
      { role: 'assistant', content: [thinking, call] },
      toolResult('c1', 'browser_cdp', text('done')),
    ];
    const out = sanitizeContextMessages(messages);
    expect(out[1]?.content).toEqual([thinking, call]);
    // 没有可清洗的东西就是原数组引用（不吃掉缓存前缀）
    expect(out).toBe(messages);
  });

  it('toolResult 的 text 块缺 text 字段仍补空串，签名、工具配对和共享输入不变', () => {
    const thinking = {
      type: 'thinking',
      thinking: 'wait',
      thinkingSignature: '{"id":"rs_1","type":"reasoning"}',
    };
    const call = { type: 'toolCall', id: 'c1', name: 'browser_cdp', arguments: {} };
    const messages: ContextMessage[] = [
      user(text('go')),
      { role: 'assistant', content: [thinking, call] },
      toolResult('c1', 'browser_cdp', { type: 'text' }),
    ];
    const snapshot = structuredClone(messages);
    const out = sanitizeContextMessages(messages);
    expect(out[1]?.content).toEqual([thinking, call]);
    const resultParts = Array.isArray(out[2]?.content) ? out[2].content : [];
    expect((resultParts[0] as { text?: string } | undefined)?.text).toBe('');
    expect(out[2]?.toolCallId).toBe('c1');
    expect(messages).toEqual(snapshot);
  });

  it('已有 text 的 assistant 和完整 toolResult 不改写', () => {
    const messages: ContextMessage[] = [
      user(text('go')),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'ok', thinkingSignature: '{}' },
          text('hi'),
          { type: 'toolCall', id: 'c1', name: 'ls', arguments: {} },
        ],
      },
      toolResult('c1', 'ls', text('(empty)')),
    ];
    expect(sanitizeContextMessages(messages)).toBe(messages);
  });

  // 真实场景：pi prompt 前的 overflow 恢复只 context_edit 掉 length 截断的 assistant，
  // 它的 toolResult 留在投影里，OpenAI 兼容接口每轮都 400
  // "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"。
  it('发起调用的 assistant 已不在上下文时丢弃孤儿 toolResult', () => {
    const messages: ContextMessage[] = [
      user(text('写个大文件')),
      toolResult('call_1', 'write', text('not executed: output token limit')),
      { role: 'system', content: 'sys' },
      user(text('继续')),
    ];
    expect(sanitizeContextMessages(messages).map((m) => m.role)).toEqual([
      'user',
      'system',
      'user',
    ]);
  });

  it('error/aborted assistant 会被 pi 整条跳过，其 toolCall 不算配对', () => {
    const messages: ContextMessage[] = [
      user(text('go')),
      { ...assistant([{ id: 'c1', name: 'ls' }]), stopReason: 'aborted' },
      toolResult('c1', 'ls', text('x')),
      user(text('again')),
    ];
    expect(sanitizeContextMessages(messages).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('用户消息插在调用和结果之间时，之后的结果不再配对', () => {
    const messages: ContextMessage[] = [
      user(text('go')),
      assistant([{ id: 'c1', name: 'ls' }]),
      { role: 'custom', content: 'notice' },
      toolResult('c1', 'ls', text('x')),
      user(text('again')),
    ];
    expect(sanitizeContextMessages(messages).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'custom',
      'user',
    ]);
  });

  it('system 夹在调用与结果之间、多结果乱序时保持原数组引用', () => {
    const messages: ContextMessage[] = [
      user(text('go')),
      assistant([
        { id: 'c1', name: 'ls' },
        { id: 'c2', name: 'ls' },
      ]),
      { role: 'system', content: 'sys' },
      toolResult('c2', 'ls', text('b')),
      toolResult('c1', 'ls', text('a')),
      user(text('next')),
    ];
    expect(sanitizeContextMessages(messages)).toBe(messages);
  });
});
