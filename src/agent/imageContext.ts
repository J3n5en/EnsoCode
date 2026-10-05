/**
 * 发给模型的上下文里，历史轮次的图片换成文本占位。
 *
 * 背景：图片一旦进了 toolResult / user 消息，之后每一轮请求都会原样重发。
 * 有的 provider（如 anthropic-messages 兼容代理）按 base64 字符计 token，一张 1.7MB 的
 * read 结果就是百万级 tokens，直接 `Input token limit exceeded`；而 pi 的 compaction
 * 切点算法对图片按固定 1200 tokens 估算，会把这几张图当成"便宜"的尾巴保留下来，
 * 压缩多少次都无法解困。
 *
 * 策略沿用业界通行做法（Anthropic clear_tool_uses、opencode 媒体占位、image-context-cascade）：
 * - 只改 `context` 钩子里的消息副本，jsonl / 时间线一字不动；
 * - 当前轮（最后一条 user 消息及之后）的图片原样保留，模型看得到刚读的图；
 * - 历史轮工具结果里的图片全部换占位，占位写明工具名 / 路径 / mime，需要时可以再 read；
 * - 用户自己贴的图保留最近 `KEEP_USER_IMAGE_TURNS` 条 user 消息里的，更早的换占位；
 * - 无法判定当前轮（没有 user 消息）时 fail-open，不动。
 */

export interface ContextMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  [key: string]: unknown;
}

interface ImageBlock {
  type: 'image';
  data?: string;
  mimeType?: string;
}

interface ToolCallBlock {
  type: 'toolCall';
  id?: string;
  name?: string;
  arguments?: unknown;
}

const KEEP_USER_IMAGE_TURNS = 2;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isImage = (b: unknown): b is ImageBlock => isRecord(b) && b.type === 'image';
const isToolCall = (b: unknown): b is ToolCallBlock => isRecord(b) && b.type === 'toolCall';
const hasImage = (m: ContextMessage): boolean =>
  Array.isArray(m.content) && m.content.some(isImage);

function pathOfCall(call: ToolCallBlock | undefined): string | undefined {
  const args = call?.arguments;
  if (!isRecord(args)) return undefined;
  const path = args.path ?? args.file ?? args.filePath;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

export function imagePlaceholder(
  block: ImageBlock,
  source: string
): { type: 'text'; text: string } {
  const mime = block.mimeType ?? 'image';
  const recapture = /\bcomputer\b/i.test(source) || /screenshot/i.test(source);
  const hint = recapture
    ? 'already seen earlier; take a new screenshot if you need the pixels — click coordinates belong to the latest screenshot'
    : 'already seen earlier in this conversation; re-read the file if you need it again';
  return {
    type: 'text',
    text: `[image omitted from context: ${mime}${source ? `, ${source}` : ''} — ${hint}]`,
  };
}

function replaceImages(message: ContextMessage, source: string): ContextMessage {
  const content = (message.content as unknown[]).map((b) =>
    isImage(b) ? imagePlaceholder(b, source) : b
  );
  return { ...message, content };
}

const isText = (b: unknown): b is { type: 'text'; text?: string } =>
  isRecord(b) && b.type === 'text';
const isThinking = (
  b: unknown
): b is { type: 'thinking'; thinking?: string; thinkingSignature?: string } =>
  isRecord(b) && b.type === 'thinking';

function fillToolResultText(message: ContextMessage): ContextMessage {
  if (message.role !== 'toolResult' || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (!isText(block) || typeof block.text === 'string') return block;
    changed = true;
    return { ...block, text: '' };
  });
  return changed ? { ...message, content } : message;
}

/** xAI openai-responses：reasoning 后必须有 message item，否则下一轮请求在 SDK 里对 undefined 读 length。 */
function ensureTextBeforeToolCalls(message: ContextMessage): ContextMessage {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
  const content = message.content;
  const signedThinking = content.some(
    (block) => isThinking(block) && typeof block.thinkingSignature === 'string'
  );
  const hasTool = content.some(isToolCall);
  const hasText = content.some((block) => isText(block) && typeof block.text === 'string');
  if (!signedThinking || !hasTool || hasText) return message;
  const insertAt = content.findIndex(isToolCall);
  const next = [...content];
  next.splice(insertAt < 0 ? content.length : insertAt, 0, { type: 'text', text: '' });
  return { ...message, content: next };
}

/** 会被 convertToLlm 变成 user 消息、从而截断工具调用链的角色。 */
function closesToolTurn(message: ContextMessage): boolean {
  if (message.role === 'bashExecution') return message.excludeFromContext !== true;
  return ['user', 'custom', 'branchSummary', 'compactionSummary'].includes(message.role);
}

/**
 * 丢弃不能配对到前一条有效 assistant toolCall 的 toolResult。
 * 配对规则对齐 pi transformMessages：error/aborted assistant 整条跳过、system 透明、user 类消息截断；
 * 孤儿结果进 OpenAI 兼容接口就是持续 400。
 */
export function dropUnpairedToolResults(messages: ContextMessage[]): ContextMessage[] {
  let pending = new Set<string>();
  let out: ContextMessage[] | undefined;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'assistant') {
      const skipped = message.stopReason === 'error' || message.stopReason === 'aborted';
      pending = new Set(
        skipped || !Array.isArray(message.content)
          ? []
          : message.content.flatMap((b) =>
              isToolCall(b) && typeof b.id === 'string' ? [b.id] : []
            )
      );
    } else if (message.role === 'toolResult') {
      if (typeof message.toolCallId === 'string' && pending.delete(message.toolCallId)) {
        out?.push(message);
        continue;
      }
      out ??= messages.slice(0, i);
      continue;
    } else if (closesToolTurn(message)) {
      pending = new Set();
    }
    out?.push(message);
  }
  return out ?? messages;
}

/** context 钩子入口：孤儿 toolResult 丢弃 + 图片占位 + 补齐会让 xAI/Responses 重放崩掉的残缺块。 */
export function sanitizeContextMessages(messages: ContextMessage[]): ContextMessage[] {
  const pruned = pruneHistoricalImages(dropUnpairedToolResults(messages));
  let out: ContextMessage[] | undefined;
  for (let i = 0; i < pruned.length; i++) {
    const message = pruned[i];
    if (!message) continue;
    const next = ensureTextBeforeToolCalls(fillToolResultText(message));
    if (next === message) continue;
    out ??= [...pruned];
    out[i] = next;
  }
  return out ?? pruned;
}

export function pruneHistoricalImages(messages: ContextMessage[]): ContextMessage[] {
  let lastUserIndex = -1;
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') {
      userIndices.push(i);
      lastUserIndex = i;
    }
  }
  if (lastUserIndex < 0) return messages;
  const keepUserFrom =
    userIndices.length > KEEP_USER_IMAGE_TURNS
      ? userIndices[userIndices.length - KEEP_USER_IMAGE_TURNS]
      : 0;

  // toolCallId → 发起调用的 toolCall block，用来在占位里写明路径
  const calls = new Map<string, ToolCallBlock>();
  for (let i = 0; i < lastUserIndex; i++) {
    const m = messages[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (isToolCall(b) && typeof b.id === 'string') calls.set(b.id, b);
    }
  }

  const computerHits: number[] = [];
  for (let i = 0; i < lastUserIndex; i++) {
    const m = messages[i];
    if (m?.role !== 'toolResult' || !hasImage(m)) continue;
    const call = typeof m.toolCallId === 'string' ? calls.get(m.toolCallId) : undefined;
    if ((m.toolName ?? call?.name) === 'computer') computerHits.push(i);
  }
  const keepComputer = new Set(computerHits.slice(-1));

  let out: ContextMessage[] | undefined;
  for (let i = 0; i < lastUserIndex; i++) {
    const m = messages[i];
    if (!m || !hasImage(m)) continue;
    let replaced: ContextMessage | undefined;
    if (m.role === 'toolResult') {
      if (keepComputer.has(i)) continue;
      const call = typeof m.toolCallId === 'string' ? calls.get(m.toolCallId) : undefined;
      const tool = m.toolName ?? call?.name ?? 'tool';
      const path = pathOfCall(call);
      replaced = replaceImages(m, path ? `${tool} ${path}` : `from ${tool}`);
    } else if (m.role === 'user' && i < keepUserFrom) {
      replaced = replaceImages(m, 'attached by user');
    }
    if (!replaced) continue;
    out ??= [...messages];
    out[i] = replaced;
  }
  return out ?? messages;
}
