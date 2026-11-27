import { describe, expect, it } from 'vitest';
import { parseInitialize, parsePermissionRequest } from './protocol';

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
