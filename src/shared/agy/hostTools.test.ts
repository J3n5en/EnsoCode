import { describe, expect, it } from 'vitest';
import { hostMcpTools, isEnsoMcpCardName, mcpContent } from './hostTools';

describe('host MCP tool selection', () => {
  it('exposes only the Enso tools agy lacks, with plain descriptions and copied schemas', () => {
    const schema = { type: 'object', properties: { question: { type: 'string' } } };
    const tools = hostMcpTools([
      { name: 'read', description: 'Read a file' },
      { name: 'bash', description: 'Run a command' },
      { name: 'web_fetch', description: 'Fetch' },
      { name: 'codemode', description: 'Run JS' },
      { name: 'ask_user', description: 'Ask the user.', parameters: schema },
      { name: 'ask_user', description: 'duplicate' },
      { name: 'subagent', description: 'Delegate.' },
      { name: 'mcp__github__list', description: 'List issues' },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(['ask_user', 'subagent', 'mcp__github__list']);
    expect(tools[0]).toEqual({
      name: 'ask_user',
      description: 'Ask the user.',
      inputSchema: schema,
    });
    expect(tools[0]?.inputSchema).not.toBe(schema);
    expect(tools[1]?.inputSchema).toEqual({});
  });

  it('passes text and image blocks through and drops the rest', () => {
    expect(
      mcpContent([
        { type: 'text', text: 'hi' },
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        { type: 'image', data: 'BBBB' },
        { type: 'toolCall', id: 'x' },
        null,
      ])
    ).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
      { type: 'image', data: 'BBBB', mimeType: 'image/png' },
    ]);
    expect(mcpContent(undefined)).toEqual([]);
  });

  it('recognises the agy-side card of our own MCP tools only', () => {
    expect(isEnsoMcpCardName('mcp_enso_ask_user')).toBe(true);
    expect(isEnsoMcpCardName('mcp_github_list')).toBe(false);
    expect(isEnsoMcpCardName('read_file')).toBe(false);
  });
});
