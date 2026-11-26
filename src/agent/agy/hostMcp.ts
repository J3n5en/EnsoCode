import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** agy 里这个 server 的名字：工具在 agy 侧叫 `mcp_enso_<tool>`。 */
export const ENSO_MCP_SERVER_NAME = 'enso';

export interface HostMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface HostMcpResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}

/** 一个 agy 会话看到的 Enso 工具：列表和调用都走该会话自己的工具定义。 */
export interface HostMcpContext {
  tools(): HostMcpTool[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<HostMcpResult>;
}

/** ACP `McpServerHttp`。headers 是 `{ name, value }` 数组，不是对象。 */
export interface AcpHttpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface HostMcpGrant {
  server: AcpHttpMcpServer;
  revoke(): void;
}

const contexts = new Map<string, HostMcpContext>();
let listening: Promise<number> | undefined;
let httpServer: HttpServer | undefined;

/** 发一个 bearer token。revoke 后这个 token 的请求一律 401。 */
export async function issueHostMcp(context: HostMcpContext): Promise<HostMcpGrant> {
  const port = await ensureListening();
  const token = randomBytes(32).toString('base64url');
  contexts.set(token, context);
  return {
    server: {
      type: 'http',
      name: ENSO_MCP_SERVER_NAME,
      url: `http://127.0.0.1:${port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
    revoke: () => {
      contexts.delete(token);
    },
  };
}

export async function closeHostMcp(): Promise<void> {
  contexts.clear();
  const server = httpServer;
  httpServer = undefined;
  listening = undefined;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
}

function ensureListening(): Promise<number> {
  listening ??= new Promise<number>((resolve, reject) => {
    const server = createServer((req, res) => {
      void handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    server.once('error', (error) => {
      listening = undefined;
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => {
      httpServer = server;
      resolve((server.address() as AddressInfo).port);
    });
  });
  return listening;
}

function contextOf(req: IncomingMessage): HostMcpContext | undefined {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (\S+)$/.exec(header);
  return match ? contexts.get(match[1] ?? '') : undefined;
}

async function handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  const context = contextOf(req);
  if (!context) {
    res.writeHead(401).end();
    return;
  }
  const mcp = new Server(
    { name: ENSO_MCP_SERVER_NAME, version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: context.tools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', ...tool.inputSchema },
    })),
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await context.call(
      request.params.name,
      request.params.arguments ?? {},
      extra.signal
    );
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  });
  // 无状态：每个请求一对 server + transport，响应结束就关
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}
