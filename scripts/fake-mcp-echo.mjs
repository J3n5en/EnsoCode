#!/usr/bin/env node
/**
 * 最小 MCP stdio 服务：只提供一个 echo 工具。
 *
 * 验收脚本要在一个普通会话里制造真实的 `mcp__` 工具调用，而仓库里没有可跑的
 * MCP 测试桩，所以这里只实现握手需要的三条方法（initialize / tools/list /
 * tools/call）。stdout 只走协议消息，日志一律不写。
 */
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'fake', version: '1.0.0' };
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = message ?? {};
  // 没有 id 的是通知（notifications/initialized 等），不需要回；method 缺省的是响应
  if (method === undefined || id === undefined) return;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const text = String(params?.arguments?.text ?? '');
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `mcp-echo:${text}` }] },
    });
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
});
