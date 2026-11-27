import { describe, expect, it } from 'vitest';
import { agyTurnUsage, parseInitialize, parsePermissionRequest } from './protocol';

const init = (version: string, agentCapabilities: Record<string, unknown> = {}) => ({
  agentInfo: { name: 'Antigravity ACP Server', version },
  agentCapabilities,
});

describe('parseInitialize', () => {
  it('takes HTTP MCP from the capability, or from agy 1.5.18 and later without one', () => {
    expect(parseInitialize(init('1.5.18'))?.httpMcp).toBe(true);
    expect(parseInitialize(init('1.6.0'))?.httpMcp).toBe(true);
    expect(parseInitialize(init('1.5.17'))?.httpMcp).toBe(false);
    expect(parseInitialize(init('1.5.17', { mcpCapabilities: { http: true } }))?.httpMcp).toBe(
      true
    );
    expect(parseInitialize(init('1.5.17', { mcpCapabilities: { http: 'yes' } }))?.httpMcp).toBe(
      false
    );
    expect(parseInitialize(init('garbage'))?.httpMcp).toBe(false);
    expect(parseInitialize({ agentInfo: {} })).toBeUndefined();
  });
});

describe('parsePermissionRequest', () => {
  it('keeps the tool name agy puts on the permission tool call', () => {
    const parsed = parsePermissionRequest({
      toolCall: { toolCallId: 'm1', name: 'mcp_enso_todo', title: 'Run mcp_enso_todo' },
      options: [{ optionId: 'allow', kind: 'allow_once' }],
    });
    expect(parsed?.toolCall).toMatchObject({ name: 'mcp_enso_todo', title: 'Run mcp_enso_todo' });
  });
});

describe('agyTurnUsage', () => {
  // 真实会话：一轮 agy 内部多次模型调用，PromptResponse.usage 是整轮累加（5.3M），不是当前上下文
  const aggregate = {
    stopReason: 'end_turn',
    usage: {
      inputTokens: 222_434,
      cachedReadTokens: 5_134_708,
      outputTokens: 34_467,
      totalTokens: 5_391_609,
    },
  };

  it('takes the context size from usage_update, never the whole-turn sum', () => {
    expect(agyTurnUsage({ used: 30_000, size: 1_048_576 }, [aggregate])).toEqual({
      input: 30_000,
      output: 34_467,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30_000,
    });
  });

  it('sums the output of every prompt of the turn (a steer adds one)', () => {
    const early = { stopReason: 'end_turn' };
    expect(agyTurnUsage({ used: 12 }, [early, aggregate, undefined]).output).toBe(34_467);
    expect(
      agyTurnUsage({ used: 12 }, [{ usage: { outputTokens: 3 } }, { usage: { outputTokens: 4 } }])
        .output
    ).toBe(7);
  });

  it('reports nothing without a usage_update, or when agy says the context is empty', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    expect(agyTurnUsage(undefined, [aggregate])).toEqual(zero);
    expect(agyTurnUsage({ used: 0, size: 1_048_576 }, [aggregate])).toEqual(zero);
    expect(agyTurnUsage(undefined, [])).toEqual(zero);
  });
});
