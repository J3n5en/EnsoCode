import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OccupancyTool } from '@shared/occupancy';
import type { McpServerEntry } from '@shared/types';

const CONNECT_TIMEOUT_MS = 10_000;

const slug = (name: string): string => name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');

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
      return new StreamableHTTPClientTransport(new URL(server.url));
    }
    case 'sse': {
      if (!server.url) throw new Error('sse server missing url');
      return new SSEClientTransport(new URL(server.url));
    }
    default:
      throw new Error(`unknown transport: ${server.transport}`);
  }
}

const cache = new Map<string, OccupancyTool[]>();

function cacheKey(server: McpServerEntry): string {
  return JSON.stringify([server.transport, server.command, server.args, server.env, server.url]);
}

export async function listMcpOccupancyTools(server: McpServerEntry): Promise<OccupancyTool[]> {
  const key = cacheKey(server);
  const hit = cache.get(key);
  if (hit) return hit;
  const client = new Client({ name: 'enso-code', version: '0.1.0' });
  try {
    await withTimeout(
      client.connect(transport(server)),
      CONNECT_TIMEOUT_MS,
      `connect ${server.name}`
    );
    const { tools } = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      `listTools ${server.name}`
    );
    const occupancy = tools.map((tool) => ({
      name: `mcp__${slug(server.name)}__${tool.name}`,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
    cache.set(key, occupancy);
    return occupancy;
  } finally {
    await client.close().catch(() => undefined);
  }
}
