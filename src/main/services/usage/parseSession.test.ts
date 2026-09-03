import { describe, expect, it } from 'vitest';
import { parseSessionJsonl } from './parseSession';

const BASE = Date.parse('2026-09-03T05:06:36.891Z');
const iso = (deltaMs: number) => new Date(BASE + deltaMs).toISOString();

function sessionHeader(overrides: Record<string, unknown> = {}) {
  return {
    type: 'session',
    version: 3,
    id: '01a065a9',
    timestamp: iso(0),
    cwd: '/Users/x/project/enso-code',
    ...overrides,
  };
}

function userMessage(id: string, parentId: string | null, deltaMs: number) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: iso(deltaMs),
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  };
}

function assistantMessage(
  id: string,
  parentId: string | null,
  deltaMs: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: iso(deltaMs),
    message: {
      role: 'assistant',
      provider: 'enso-anthropic-x',
      model: 'claude-opus-5',
      usage: {
        input: 2,
        output: 352,
        cacheRead: 0,
        cacheWrite: 57813,
        totalTokens: 58167,
        reasoning: 73,
      },
      stopReason: 'toolUse',
      timestamp: BASE + deltaMs,
      ...overrides,
    },
  };
}

function toolResultMessage(id: string, parentId: string | null, deltaMs: number) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: iso(deltaMs),
    message: { role: 'toolResult', toolCallId: 'x', content: [] },
  };
}

function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

describe('parseSessionJsonl — session 头', () => {
  it('没有 session 头时返回 null', () => {
    const text = jsonl([userMessage('a', null, 0)]);
    expect(parseSessionJsonl(text)).toBeNull();
  });

  it('从 session 头取 id 与 cwd basename 作为 project', () => {
    const text = jsonl([sessionHeader()]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.sessionId).toBe('01a065a9');
    expect(parsed?.project).toBe('enso-code');
  });

  it('cwd 为 windows 反斜杠路径时也能取到 basename', () => {
    const text = jsonl([sessionHeader({ cwd: 'C:\\Users\\x\\project\\enso-code' })]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.project).toBe('enso-code');
  });

  it('后续没有 cwd 的 session 行不应把 project 重置为空', () => {
    const text = jsonl([
      sessionHeader(),
      { type: 'session', version: 3, id: '01a065a9', timestamp: iso(1000) },
      assistantMessage('a1', null, 2000),
    ]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.project).toBe('enso-code');
    expect(parsed?.records[0].project).toBe('enso-code');
  });
});

describe('parseSessionJsonl — 坏行容错', () => {
  it('非法 JSON 行被跳过，不影响后续解析', () => {
    const text = [
      JSON.stringify(sessionHeader()),
      '{not valid json',
      JSON.stringify(userMessage('u1', null, 100)),
    ].join('\n');
    const parsed = parseSessionJsonl(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.userMessages).toBe(1);
  });

  it('assistant 消息没有 usage 字段时不产出记录', () => {
    const text = jsonl([
      sessionHeader(),
      {
        type: 'message',
        id: 'a1',
        parentId: null,
        timestamp: iso(100),
        message: { role: 'assistant', model: 'x' },
      },
    ]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.records).toHaveLength(0);
  });

  it('usage 里非数值字段按 0 处理', () => {
    const text = jsonl([
      sessionHeader(),
      assistantMessage('a1', null, 100, {
        usage: { input: 'oops', output: null, cacheRead: undefined, cacheWrite: 5 },
      }),
    ]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.records).toHaveLength(1);
    const record = parsed?.records[0];
    expect(record?.input).toBe(0);
    expect(record?.output).toBe(0);
    expect(record?.cacheRead).toBe(0);
    expect(record?.cacheWrite).toBe(5);
  });
});

describe('parseSessionJsonl — ts 取值优先级', () => {
  it('优先使用 message.timestamp（数字 ms）', () => {
    const text = jsonl([sessionHeader(), assistantMessage('a1', null, 5000)]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.records[0].ts).toBe(BASE + 5000);
  });

  it('message.timestamp 缺失时退回 Date.parse(entry.timestamp)', () => {
    const text = jsonl([
      sessionHeader(),
      assistantMessage('a1', null, 5000, { timestamp: undefined }),
    ]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.records[0].ts).toBe(BASE + 5000);
  });

  it('两者都缺失时该记录被跳过', () => {
    const text = jsonl([
      sessionHeader(),
      {
        type: 'message',
        id: 'a1',
        parentId: null,
        timestamp: undefined,
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          timestamp: undefined,
        },
      },
    ]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.records).toHaveLength(0);
  });
});

describe('parseSessionJsonl — model/provider 兜底', () => {
  it('缺少 model 时回退为 unknown', () => {
    const text = jsonl([sessionHeader(), assistantMessage('a1', null, 100, { model: undefined })]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.records[0].model).toBe('unknown');
  });

  it('缺少 provider 时回退为空字符串', () => {
    const text = jsonl([
      sessionHeader(),
      assistantMessage('a1', null, 100, { provider: undefined }),
    ]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.records[0].provider).toBe('');
  });
});

describe('parseSessionJsonl — 重复 id', () => {
  it('同一 entry.id 重复出现时取最后一条，只产出一条记录', () => {
    const text = jsonl([
      sessionHeader(),
      assistantMessage('dup', null, 100, { model: 'model-first' }),
      assistantMessage('dup', null, 200, { model: 'model-last' }),
    ]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.records).toHaveLength(1);
    expect(parsed?.records[0].model).toBe('model-last');
  });
});

describe('parseSessionJsonl — activeMs 与 spans', () => {
  it('user 开启一轮，assistant/toolResult 更新轮次结束时间，下一条 user 到来时累加', () => {
    const text = jsonl([
      sessionHeader(),
      userMessage('u1', null, 0),
      assistantMessage('a1', 'u1', 10_000),
      toolResultMessage('t1', 'a1', 20_000),
      userMessage('u2', 't1', 60_000),
    ]);
    const parsed = parseSessionJsonl(text);
    // 第一轮 start=0, end=20_000（最后一条 assistant/toolResult）
    expect(parsed?.activeMs).toBe(20_000);
    expect(parsed?.spans).toEqual([{ start: BASE, end: BASE + 20_000 }]);
  });

  it('文件结束时也结算最后一轮', () => {
    const text = jsonl([
      sessionHeader(),
      userMessage('u1', null, 0),
      assistantMessage('a1', 'u1', 15_000),
    ]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.activeMs).toBe(15_000);
    expect(parsed?.spans).toEqual([{ start: BASE, end: BASE + 15_000 }]);
  });

  it('单轮跨度超过 6 小时按 6 小时截断', () => {
    const sevenHours = 7 * 60 * 60 * 1000;
    const text = jsonl([
      sessionHeader(),
      userMessage('u1', null, 0),
      assistantMessage('a1', 'u1', sevenHours),
    ]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.activeMs).toBe(6 * 60 * 60 * 1000);
    expect(parsed?.spans).toEqual([{ start: BASE, end: BASE + 6 * 60 * 60 * 1000 }]);
  });

  it('userMessages 统计 user 消息条数', () => {
    const text = jsonl([
      sessionHeader(),
      userMessage('u1', null, 0),
      assistantMessage('a1', 'u1', 1000),
      userMessage('u2', 'a1', 2000),
    ]);
    const parsed = parseSessionJsonl(text);
    expect(parsed?.userMessages).toBe(2);
  });
});
