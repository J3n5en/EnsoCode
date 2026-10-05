import { WORKSPACE_WRITE_TOOL_ID } from '../../../shared/childProfileTools';
import type { DefaultModelRef } from '../../../shared/defaultModel';
import { THINKING_LEVELS, type ThinkingLevel } from '../../../shared/types/agent';
import type { BotChat, BotEngine, BotProfile } from '../../../shared/types/bot';

type BotIdentity = Pick<BotProfile, 'id' | 'name' | 'title' | 'scope'>;

export const BOT_READONLY_DISABLED_TOOLS = [WORKSPACE_WRITE_TOOL_ID, 'background_tasks'];

function label(bot: Pick<BotProfile, 'name' | 'title'>): string {
  const title = bot.title.trim();
  return title ? `${bot.name} (${title})` : bot.name;
}

/** 替换 pi 开头角色段的人设：身份 + 职责 + persona.md */
export function buildBotSystemPrompt(bot: BotIdentity, persona: string): string {
  const scope = bot.scope.trim();
  return [`You are ${label(bot)}.`, scope ? `Your responsibility: ${scope}` : '', persona.trim()]
    .filter(Boolean)
    .join('\n\n');
}

export function buildBotModeInstruction(input: {
  self: BotIdentity;
  kind: BotChat['kind'];
  roster: readonly BotIdentity[];
}): string {
  const lines = [
    '# Bot mode',
    '',
    `You are chatting as "${input.self.name}" in EnsoCode Bot mode.`,
    '- Reply like a chat message: concise and conversational. No headings or long reports unless asked.',
    '- Your final reply text of each turn is exactly the message that gets posted. Say it directly instead of describing what you would say.',
    '- You may still use tools to do real work in the workspace; tool activity stays in your own session and is not posted.',
    '- Use delegate({to, task, context?}) to ask another member for work. It returns a delegationId immediately; the result arrives later in <delegation-result>; results of several delegations made in one turn arrive together in one <delegation-results> message. Use check_delegation({id?, cancel?}) to inspect or cancel. Do not poll repeatedly.',
  ];
  if (input.kind === 'group') {
    lines.push(
      '- This is a group chat. Messages from others arrive as <group-message from="Name" role="Title"> blocks.',
      '- Mention a member with @Name only when you need them to respond.',
      '- You may be picked to reply together with other members, one after another. Add only what is new; do not repeat what others already said.',
      '- If there is truly no need for you to speak (the question has already been answered, or it is outside your responsibility), reply with exactly [skip] and nothing will be posted.',
      '- When the human @mentions you directly, you should reply whenever possible instead of skipping.',
      '- The group has a shared task board, the group_tasks tool. Use it for multi-step work that needs tracking or several members: split it into a few tasks, claim a task before working on it, and complete it with a short result when done. To hand a task to someone, delegate with taskId (e.g. "#3"); a delegated task is updated automatically when the delegation ends, so do not complete it yourself. Do not create a task for every message or small question; check list before adding duplicates.',
      '- If your context was compacted, or you need to check what someone said earlier word for word, use the read-only group_history tool (by seq range, keyword or speaker); seq matches the seq attribute of <group-message>.',
      "- Memory: capture facts that matter to the whole group (team conventions, decisions, project background, who does what, shared terminology) with spaceId 'chat'; keep your own preferences, habits and lessons in spaceId 'bot'.",
      '',
      '## Group members',
      ...input.roster.map((bot) => {
        const scope = bot.scope.trim();
        return `- ${label(bot)}${scope ? ` — ${scope}` : ''}${bot.id === input.self.id ? ' (you)' : ''}`;
      })
    );
  }
  return lines.join('\n');
}

/** Bot 说明追加在全局指令之后（全局指令仍生效） */
export function mergeBotInstruction(
  global: { path: string; content: string } | undefined,
  botText: string,
  fallbackPath: string
): { path: string; content: string } {
  return global
    ? { path: global.path, content: `${global.content.trimEnd()}\n\n${botText}` }
    : { path: fallbackPath, content: botText };
}

export interface BotModelPick extends DefaultModelRef {
  reasoningEnabled: boolean;
  thinkingLevel: ThinkingLevel;
}

function modelRef(value: unknown): DefaultModelRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { providerId, modelId } = value as Record<string, unknown>;
  return typeof providerId === 'string' && providerId && typeof modelId === 'string' && modelId
    ? { providerId, modelId }
    : undefined;
}

/** 成员引擎优先，不可用时回落全局默认模型；推理档随来源取 */
export function pickBotModel(
  engine: BotEngine | undefined,
  settings: Record<string, unknown>,
  isUsable: (ref: DefaultModelRef) => boolean
): BotModelPick | undefined {
  const level = settings.defaultThinkingLevel;
  const defaults = {
    reasoningEnabled: settings.defaultReasoningEnabled !== false,
    thinkingLevel: THINKING_LEVELS.includes(level as ThinkingLevel)
      ? (level as ThinkingLevel)
      : 'medium',
  };
  if (engine && isUsable(engine)) {
    const { providerId, modelId, thinkingLevel } = engine;
    return thinkingLevel
      ? { providerId, modelId, reasoningEnabled: true, thinkingLevel }
      : { providerId, modelId, ...defaults };
  }
  const fallback = modelRef(settings.defaultModel);
  return fallback && isUsable(fallback) ? { ...fallback, ...defaults } : undefined;
}
