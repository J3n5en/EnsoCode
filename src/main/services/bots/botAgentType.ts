import type { AgentTypeEntry } from '../../../shared/types/assets';
import type { BotProfile } from '../../../shared/types/bot';
import { buildBotSystemPrompt } from './botPrompt';

/** Code 会话里可 @ / subagent 调用的成员：形状同自定义 agent type，key 为 `bot:<botId>` */
export interface MemberAgentType extends AgentTypeEntry {
  source: 'bot';
  typeKey: `bot:${string}`;
}

export function botToAgentType(bot: BotProfile, persona: string): MemberAgentType {
  const description = [bot.title.trim(), bot.scope.trim()].filter(Boolean).join(' — ');
  const engine = bot.engine;
  return {
    source: 'bot',
    typeKey: `bot:${bot.id}`,
    id: bot.id,
    name: bot.name,
    description: description || bot.name,
    systemPrompt: buildBotSystemPrompt(bot, persona),
    tools: bot.tools,
    skillIds: [...bot.skillIds],
    mcpServerIds: [...bot.mcpServerIds],
    ...(engine
      ? {
          modelMode: 'fixed' as const,
          providerId: engine.providerId,
          modelId: engine.modelId,
          ...(engine.thinkingLevel
            ? { reasoning: 'on' as const, thinkingLevel: engine.thinkingLevel }
            : {}),
        }
      : { modelMode: 'follow' as const }),
  };
}

export function listMemberAgentTypes(
  bots: readonly BotProfile[],
  readPersona: (id: string) => string
): MemberAgentType[] {
  return bots
    .filter((bot) => bot.archivedAt === undefined)
    .map((bot) => botToAgentType(bot, readPersona(bot.id)));
}

/** subagent 工具按 `bot:<id>` 选类型，描述里带出成员名供模型对应 */
export function memberSpawnDescription(member: MemberAgentType): string {
  const label = `Member "${member.name}"`;
  return member.description === member.name ? label : `${label} — ${member.description}`;
}
