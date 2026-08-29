#!/usr/bin/env node
/**
 * 受控 fake provider（issue #27）：本地 anthropic-messages 兼容端点。
 *
 * 用法：
 *   node scripts/fake-provider-issue-27.mjs            # 默认 127.0.0.1:8899
 *   curl localhost:8899/__requests                     # 查看 worker 实际发出的请求
 *   curl localhost:8899/__reset                        # 清空记录
 *
 * 配合隔离 userData 使用，避免真机验收碰真实账号：
 *   ENSO_USER_DATA_DIR=/tmp/enso-ac-verify pnpm dev
 *
 * 支持按 prompt 关键字返回预设 `tool_use`，用于驱动那些需要模型自主调用工具的 AC
 * （AC34/35/39/40/41/43）——否则固定文本回复永远触发不了能力链路。
 *
 * 脚本在 prompt 里写 `[[tool:<工具名> <JSON 参数>]]` 即可指定要发的调用，
 * 可写多个（验证危险操作排队）。已有工具结果的回合则返回纯文本收尾，
 * 避免无限循环。
 *
 * 目的是让真机验收不触碰真实账号、不花 token、且行为可预期：
 * - 回复内容固定，便于断言
 * - 支持通过 prompt 里的指令触发工具调用，用来验 Enso 能力链路
 * - 记录每次请求，验收脚本可核对「worker 是否真的发出了请求」
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_PROVIDER_PORT || 8899);
const requests = [];

function sse(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const e of events) {
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  }
  res.end();
}

/** 从 prompt 里取出 `[[tool:name {json}]]` 指令 */
function parseToolDirectives(messages) {
  const last = messages?.at(-1);
  const text =
    typeof last?.content === 'string'
      ? last.content
      : (last?.content ?? []).map((c) => c?.text ?? '').join('\n');
  const out = [];
  const re = /\[\[tool:([\w-]+)\s*(\{[\s\S]*?\})?\]\]/g;
  let m = re.exec(text);
  while (m) {
    let input = {};
    try {
      input = m[2] ? JSON.parse(m[2]) : {};
    } catch {}
    out.push({ name: m[1], input });
    m = re.exec(text);
  }
  return out;
}

/** 本轮是否已有工具结果（有则收尾，不再发工具调用） */
function hasToolResult(messages) {
  return (messages ?? []).some((msg) =>
    (Array.isArray(msg?.content) ? msg.content : []).some((c) => c?.type === 'tool_result')
  );
}

function toolUseReply(calls) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: 'fake-model-1',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
  calls.forEach((call, index) => {
    events.push({
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: `toolu_${Date.now()}_${index}`,
        name: call.name,
        input: {},
      },
    });
    events.push({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
    });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 5 },
  });
  events.push({ type: 'message_stop' });
  return events;
}

function textReply(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: 'fake-model-1',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ];
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = req.url || '';
    const body = Buffer.concat(chunks).toString('utf8');

    if (url.includes('/__requests')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: requests.length, requests: requests.slice(-20) }));
      return;
    }
    if (url.includes('/__reset')) {
      requests.length = 0;
      res.writeHead(200).end('{}');
      return;
    }
    if (url.includes('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model-1' }, { id: 'fake-model-2' }] }));
      return;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    requests.push({
      at: Date.now(),
      url,
      model: parsed?.model,
      messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : 0,
      // 只留摘要，避免验收日志里出现完整 prompt
      lastUserText: String(
        parsed?.messages?.at(-1)?.content?.[0]?.text ?? parsed?.messages?.at(-1)?.content ?? ''
      ).slice(0, 120),
      toolNames: Array.isArray(parsed?.tools) ? parsed.tools.map((t) => t.name) : [],
      // 用来区分请求实际用了哪个 provider 条目的凭证（AC12/AC18 需要）
      authKey: String(req.headers['x-api-key'] || req.headers.authorization || '').slice(-6),
    });

    const messages = parsed?.messages;
    const calls = hasToolResult(messages) ? [] : parseToolDirectives(messages);
    sse(res, calls.length > 0 ? toolUseReply(calls) : textReply('fake-ok'));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-provider] listening on http://127.0.0.1:${PORT}`);
});
