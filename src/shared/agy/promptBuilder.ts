import type { AgyContentBlock, AgyInteractionMode, PromptMessage } from './types';

const DEFAULT_INSTRUCTIONS = `## EnsoCode interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until EnsoCode supplies a different interaction-mode instruction.`;

const PLAN_INSTRUCTIONS = `## EnsoCode interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until EnsoCode supplies a different interaction-mode instruction.`;

export function runtimeInfoText(modelLabel: string): string {
  return `<runtime_info>In case you're asked: you are running in EnsoCode through the Antigravity harness, as ${modelLabel}. No need to mention this otherwise. Link every file you cite or produce by its absolute path.</runtime_info>`;
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
    const instructions =
      input.interactionMode === 'plan' ? PLAN_INSTRUCTIONS : DEFAULT_INSTRUCTIONS;
    body = `<enso_instructions>\n${instructions}\n</enso_instructions>\n\n<user_request>\n${text}\n</user_request>`;
  }
  const blocks: AgyContentBlock[] = [];
  if (body) blocks.push({ type: 'text', text: body });
  blocks.push(...images);
  if (input.includeRuntimeInfo)
    blocks.push({ type: 'text', text: runtimeInfoText(input.modelLabel) });
  return blocks;
}
