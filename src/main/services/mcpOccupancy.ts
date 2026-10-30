import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpHeaders } from '@shared/mcpConfig';
import type { OccupancyTool } from '@shared/occupancy';
import type { McpServerEntry } from '@shared/types';
import { assignMcpToolNames } from '../../agent/mcpNames';
import { getMcpToolCatalog } from './mcpToolCatalog';

const PROBE_TIMEOUT_MS = 8_000;
const CLOSE_TIMEOUT_MS = 1_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function requestInit(server: McpServerEntry) {
  const headers = mcpHeaders(server.headers);
  return headers ? { requestInit: { headers } } : undefined;
}

function transport(server: McpServerEntry) {
  switch (server.transport) {
    case 'stdio': {
      if (!server.command) throw new Error('stdio server missing command');
      return new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
      });
    }
    case 'http': {
      if (!server.url) throw new Error('http server missing url');
      return new StreamableHTTPClientTransport(new URL(server.url), requestInit(server));
    }
    case 'sse': {
      if (!server.url) throw new Error('sse server missing url');
      return new SSEClientTransport(new URL(server.url), requestInit(server));
    }
    default:
      throw new Error(`unknown transport: ${server.transport}`);
  }
}

type ProbedTool = { name: string; description?: string; inputSchema: unknown };

const cache = new Map<string, ProbedTool[]>();

function cacheKey(server: McpServerEntry): string {
  return JSON.stringify([
    server.transport,
    server.command,
    server.args,
    server.env,
    server.url,
    ...(server.headers ? [server.headers] : []),
  ]);
}

export async function listMcpOccupancyTools(server: McpServerEntry): Promise<OccupancyTool[]> {
  const key = cacheKey(server);
  const tools = cache.get(key) ?? (await probeMcpTools(server));
  if (tools.length > 0) {
    cache.set(key, tools);
    getMcpToolCatalog().record(
      server,
      tools.map((tool) => tool.name)
    );
  }
  const names = assignMcpToolNames(
    server.name,
    tools.map((tool) => tool.name)
  );
  return tools.map((tool, index) => ({
    name: names[index],
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

async function probeMcpTools(server: McpServerEntry): Promise<ProbedTool[]> {
  const client = new Client({ name: 'enso-code', version: '0.1.0' });
  try {
    return await withTimeout(
      (async () => {
        await client.connect(transport(server));
        return (await client.listTools()).tools;
      })(),
      PROBE_TIMEOUT_MS,
      `probe ${server.name}`
    );
  } finally {
    await withTimeout(client.close(), CLOSE_TIMEOUT_MS, `close ${server.name}`).catch(
      () => undefined
    );
  }
}
