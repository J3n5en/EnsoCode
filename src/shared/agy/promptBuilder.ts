import type { AgyContentBlock, AgyInteractionMode, PromptMessage } from './types';

const DEFAULT_INSTRUCTIONS = `## EnsoCode interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until EnsoCode supplies a different interaction-mode instruction.`;

const PLAN_INSTRUCTIONS = `## EnsoCode interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until EnsoCode supplies a different interaction-mode instruction.`;

export function runtimeInfoText(modelLabel: string): string {
  return `<runtime_info>In case you're asked: you are running in EnsoCode through the Antigravity harness, as ${modelLabel}. No need to mention this otherwise. Link every file you cite or produce by its absolute path.</runtime_info>`;
}

const mcpName = (tool: string) => `\`mcp_enso_${tool}\``;

/** 只在 Host MCP 挂上了工具时才有。按 t3 orchestrationInstructions 的写法：用哪个、什么时候用。 */
function ensoToolsInstructions(tools: readonly string[]): string | undefined {
  if (tools.length === 0) return undefined;
  const has = (name: string) => tools.includes(name);
  const delegation = ['subagent', 'workflow'].filter(has);
  const lines = [
    `## EnsoCode tools

EnsoCode tools come from the \`enso\` MCP server: ${tools.map(mcpName).join(', ')}. Ordinary coding work needs none of them; read, edit, search and run commands with your own tools.`,
    has('ask_user')
      ? `- When only the user can make a decision that blocks the work, ask with ${mcpName('ask_user')} instead of ending your reply with a question.`
      : '',
    has('todo')
      ? `- For work with three or more steps, keep a list with ${mcpName('todo')}, passing the full list on every call and updating it as steps finish.`
      : '',
    delegation.length > 0
      ? `- Delegate with ${delegation.map(mcpName).join(' or ')} only when the user asks for subagents, delegation or parallel work. As a subagent, do the work yourself.`
      : '',
  ];
  return lines.filter(Boolean).join('\n');
}
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const record = block as { type?: string; text?: string };
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function imagesOf(content: unknown): AgyContentBlock[] {
  if (!Array.isArray(content)) return [];
  const images: AgyContentBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as { type?: string; mimeType?: string; data?: string };
    if (record.type !== 'image' || typeof record.data !== 'string') continue;
    images.push({
      type: 'image',
      mimeType: typeof record.mimeType === 'string' ? record.mimeType : 'image/png',
      data: record.data,
    });
  }
  return images;
}

function lastUser(messages: readonly PromptMessage[]): PromptMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index];
  }
  return undefined;
}

/**
 * ACP prompt 只含本轮用户文字和图片。pi 的 system、历史、注入消息一律不读进输出。
 */
export function buildAgyPrompt(input: {
  messages: readonly PromptMessage[];
  interactionMode: AgyInteractionMode;
  includeInstructions: boolean;
  includeRuntimeInfo: boolean;
  modelLabel: string;
  /** 本会话挂到 Host MCP 上的 Enso 工具名 */
  ensoTools?: readonly string[];
}): AgyContentBlock[] {
  const user = lastUser(input.messages);
  const text = textOf(user?.content);
  const images = imagesOf(user?.content);
  if (text.trimStart().startsWith('/')) {
    const blocks: AgyContentBlock[] = [];
    if (text) blocks.push({ type: 'text', text });
    blocks.push(...images);
    return blocks;
  }
  let body = text;
  if (input.includeInstructions) {
    const instructions = [
      input.interactionMode === 'plan' ? PLAN_INSTRUCTIONS : DEFAULT_INSTRUCTIONS,
      ensoToolsInstructions(input.ensoTools ?? []),
    ]
      .filter(Boolean)
      .join('\n\n');
    body = `<enso_instructions>\n${instructions}\n</enso_instructions>\n\n<user_request>\n${text}\n</user_request>`;
  }
  const blocks: AgyContentBlock[] = [];
  if (body) blocks.push({ type: 'text', text: body });
  blocks.push(...images);
  if (input.includeRuntimeInfo)
    blocks.push({ type: 'text', text: runtimeInfoText(input.modelLabel) });
  return blocks;
}
