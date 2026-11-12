/**
 * 工具批次一句话标签（借鉴 qwen-code / Claude Code tool-use summary）：
 * 每个带工具调用的回合结束后，worker 摘出批次要点，Main 用标题模型生成 commit-subject 风格标签，
 * 落成会话 custom entry，时间线工具组头据此显示意图。
 */
export const TOOL_BATCH_LABEL_SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished. It appears as a single-line row in a mobile app and truncates around 30 characters, so think git-commit-subject, not sentence.

Keep the verb in past tense and the most distinctive noun. Drop articles, connectors, and long location context first. Reply in the same language as the intent text when there is one.

Examples:
- Searched in auth/
- Fixed NPE in UserService
- Created signup endpoint
- Read config.json
- Ran failing tests`;

export interface ToolBatchDigest {
  /** 批次首个工具调用 id：标签的持久键，时间线按组内调用 id 找回 */
  callId: string;
  intent?: string;
  tools: { name: string; input: string; output: string }[];
}

const FIELD_CHARS = 300;
const INTENT_CHARS = 200;
const MAX_TOOLS = 8;
const LABEL_CHARS = 60;
/** 记账类工具不值得起标签 */
const BOOKKEEPING_TOOLS = new Set([
  'todo',
  'explore_mark',
  'explore_fold',
  'turn_discard',
  'ask_user',
]);

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => (part as { text: string }).text)
    .join('\n');
}

export function toolBatchDigest(
  message: unknown,
  toolResults: readonly unknown[]
): ToolBatchDigest | undefined {
  if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content))
    return undefined;
  const calls = message.content.filter(
    (part): part is { id: string; name: string; arguments?: unknown } =>
      isRecord(part) &&
      part.type === 'toolCall' &&
      typeof part.id === 'string' &&
      part.id.length > 0 &&
      typeof part.name === 'string'
  );
  if (calls.length === 0 || calls.every((c) => BOOKKEEPING_TOOLS.has(c.name))) return undefined;
  const results = new Map<string, Record<string, unknown>>();
  for (const r of toolResults)
    if (isRecord(r) && typeof r.toolCallId === 'string') results.set(r.toolCallId, r);
  const intent = contentText(message.content.filter((p) => isRecord(p) && p.type === 'text'))
    .trim()
    .replace(/\s+/g, ' ');
  return {
    callId: calls[0].id,
    ...(intent ? { intent: clip(intent, INTENT_CHARS) } : {}),
    tools: calls.slice(0, MAX_TOOLS).map((c) => {
      const r = results.get(c.id);
      let input: string;
      try {
        input = JSON.stringify(c.arguments ?? {});
      } catch {
        input = '';
      }
      const output = contentText(r?.content).trim();
      return {
        name: c.name,
        input: clip(input, FIELD_CHARS),
        output: clip(r?.isError === true ? `error: ${output}` : output, FIELD_CHARS),
      };
    }),
  };
}

export function toolBatchLabelPrompt(digest: ToolBatchDigest): string {
  const tools = digest.tools
    .map((t) => `Tool: ${t.name}\nInput: ${t.input}\nOutput: ${t.output}`)
    .join('\n\n');
  const intent = digest.intent
    ? `User's intent (from assistant's last message): ${digest.intent}\n\n`
    : '';
  return `${intent}Tools completed:\n\n${tools}\n\nLabel:`;
}

/** IPC 边界收窄：字段长度受 digest 生成时的截断约束，越界即拒 */
export function parseToolBatchDigest(value: unknown): ToolBatchDigest | null {
  if (!isRecord(value) || typeof value.callId !== 'string' || !value.callId) return null;
  if (
    value.intent !== undefined &&
    (typeof value.intent !== 'string' || value.intent.length > INTENT_CHARS)
  )
    return null;
  if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > MAX_TOOLS)
    return null;
  const fieldOk = (v: unknown) => typeof v === 'string' && v.length <= FIELD_CHARS;
  if (
    !value.tools.every(
      (t) =>
        isRecord(t) &&
        typeof t.name === 'string' &&
        t.name.length > 0 &&
        t.name.length <= FIELD_CHARS &&
        fieldOk(t.input) &&
        fieldOk(t.output)
    )
  )
    return null;
  return value as unknown as ToolBatchDigest;
}

/** 取首行并去掉引号 / 列表符 / Label: 前缀；空、错误或拒答样式返回 undefined */
export function cleanToolBatchLabel(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  const label = line
    .replace(/^label:\s*/i, '')
    .replace(/^[-*•]\s+/, '')
    .replace(/^["'`“”]+|["'`“”]+$/g, '')
    .trim();
  if (!label || /^(error\b|i cannot\b|i can't\b|sorry\b)/i.test(label)) return undefined;
  return clip(label, LABEL_CHARS);
}
