import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerSpawnConfig } from '@shared/types/agent';

/** 连接与 listTools 的整体超时；慢/坏 server 不能卡住 spawn */
const CONNECT_TIMEOUT_MS = 10_000;
/** 单次工具调用超时 */
const CALL_TIMEOUT_MS = 120_000;

interface Connection {
  client: Client;
  tools: ToolDefinition[];
}

const slug = (name: string): string => name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
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

/**
 * MCP 连接管理：worker 级共享，按配置签名缓存（同配置只建一条连接，多会话复用）。
 * 连接保活到 worker 退出（closeAll）；不做引用计数，泄漏面由 worker 生命周期兜底。
 */
export class McpManager {
  private readonly connections = new Map<string, Promise<Connection | null>>();

  /**
   * 为一组 server 配置解析工具列表；单个 server 失败只跳过并留痕，不抛。
   * budgetMs：spawn 场景的等待预算——超时的 server 本次不注入，连接在后台继续
   * （缓存保留），下次 spawn 即命中；不给则等到连接结束（预热场景）。
   */
  async toolsFor(servers: McpServerSpawnConfig[], budgetMs?: number): Promise<ToolDefinition[]> {
    const results = await Promise.all(
      servers.map((server) => {
        const pending = this.connectionFor(server);
        if (budgetMs === undefined) return pending;
        return Promise.race([
          pending,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs)),
        ]);
      })
    );
    return results.flatMap((connection) => connection?.tools ?? []);
  }

  private connectionFor(server: McpServerSpawnConfig): Promise<Connection | null> {
    const key = JSON.stringify([
      server.transport,
      server.command,
      server.args,
      server.env,
      server.url,
    ]);
    let pending = this.connections.get(key);
    if (!pending) {
      pending = this.connect(server).catch((error) => {
        console.error(`[mcp] connect failed for "${server.name}":`, error);
        // 失败结果不缓存：下次 spawn 重试
        this.connections.delete(key);
        return null;
      });
      this.connections.set(key, pending);
    }
    return pending;
  }

  private async connect(server: McpServerSpawnConfig): Promise<Connection> {
    const client = new Client({ name: 'enso-code', version: '0.1.0' });
    await withTimeout(
      client.connect(this.createTransport(server)),
      CONNECT_TIMEOUT_MS,
      `connect ${server.name}`
    );
    const { tools } = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      `listTools ${server.name}`
    );
    return {
      client,
      tools: tools.map((tool) => this.toToolDefinition(client, server.name, tool)),
    };
  }

  private createTransport(server: McpServerSpawnConfig) {
    switch (server.transport) {
      case 'stdio': {
        if (!server.command) throw new Error('stdio server missing command');
        return new StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          // 不带 process.env 的话子进程连 PATH 都没有
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

  private toToolDefinition(
    client: Client,
    serverName: string,
    tool: { name: string; description?: string; inputSchema: unknown }
  ): ToolDefinition {
    const name = `mcp__${slug(serverName)}__${tool.name}`;
    return {
      name,
      label: `${serverName}: ${tool.name}`,
      description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
      // MCP inputSchema 是标准 JSON Schema，TypeBox 的 TSchema 结构同源，直接透传
      parameters: tool.inputSchema as ToolDefinition['parameters'],
      async execute(_toolCallId, params) {
        const result = await withTimeout(
          client.callTool({
            name: tool.name,
            arguments: (params ?? {}) as Record<string, unknown>,
          }),
          CALL_TIMEOUT_MS,
          `callTool ${name}`
        );
        const content = (Array.isArray(result.content) ? result.content : []).map(
          (part: { type: string; text?: string; data?: string; mimeType?: string }) => {
            if (part.type === 'text') return { type: 'text' as const, text: part.text ?? '' };
            if (part.type === 'image' && part.data && part.mimeType) {
              return { type: 'image' as const, data: part.data, mimeType: part.mimeType };
            }
            // resource/audio 等其它类型收敛为 JSON 文本
            return { type: 'text' as const, text: JSON.stringify(part) };
          }
        );
        if (result.isError) {
          const text = content
            .map((part) => (part.type === 'text' ? part.text : '[image]'))
            .join('\n');
          throw new Error(text || `MCP tool ${name} failed`);
        }
        return {
          content: content.length > 0 ? content : [{ type: 'text' as const, text: '' }],
          details: undefined,
        };
      },
    };
  }

  /** worker 退出前断开全部连接（stdio 子进程随之终止） */
  async closeAll(): Promise<void> {
    const pending = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(
      pending.map(async (entry) => {
        const connection = await entry;
        await connection?.client.close();
      })
    );
  }
}
