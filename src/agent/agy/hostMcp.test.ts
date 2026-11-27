import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { type AcpHttpMcpServer, closeHostMcp, type HostMcpContext, issueHostMcp } from './hostMcp';

afterEach(async () => {
  await closeHostMcp();
});

function connect(server: AcpHttpMcpServer, headers = server.headers) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers: Object.fromEntries(headers.map((header) => [header.name, header.value])),
    },
  });
  return client.connect(transport).then(() => client);
}

const context = (calls: unknown[]): HostMcpContext => ({
  tools: () => [
    {
      name: 'ask_user',
      description: 'Ask the user a question.',
      inputSchema: { properties: { question: { type: 'string' } }, required: ['question'] },
    },
  ],
  call: async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: 'text', text: `answered ${String(args.question)}` }] };
  },
});

describe('Enso host MCP', () => {
  it('lists and calls the session tools behind its bearer token on 127.0.0.1', async () => {
    const calls: unknown[] = [];
    const issued = await issueHostMcp(context(calls));
    expect(issued.server).toMatchObject({ type: 'http', name: 'enso' });
    expect(new URL(issued.server.url).hostname).toBe('127.0.0.1');
    expect(issued.server.headers[0]?.value).toMatch(/^Bearer [\w-]{40,}$/);

    const client = await connect(issued.server);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['ask_user']);
    expect(listed.tools[0]?.inputSchema).toMatchObject({ type: 'object', required: ['question'] });
    const result = await client.callTool({ name: 'ask_user', arguments: { question: 'why' } });
    expect(result.content).toEqual([{ type: 'text', text: 'answered why' }]);
    expect(calls).toEqual([{ name: 'ask_user', args: { question: 'why' } }]);
    await client.close();
  });

  it('refuses a missing, foreign or revoked token', async () => {
    const first = await issueHostMcp(context([]));
    const second = await issueHostMcp(context([]));
    expect(first.server.headers[0]?.value).not.toBe(second.server.headers[0]?.value);
    await expect(connect(first.server, [])).rejects.toThrow();
    await expect(
      connect(first.server, [{ name: 'Authorization', value: 'Bearer nope' }])
    ).rejects.toThrow();
    first.revoke();
    await expect(connect(first.server)).rejects.toThrow();
    const still = await connect(second.server);
    await still.close();
  });
});
