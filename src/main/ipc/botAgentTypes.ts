import { setMemberAgentTypeSource } from '../services/agentHost';
import { listMemberAgentTypes, type MemberAgentType } from '../services/bots/botAgentType';
import { botModeEnabled, getBotServices, observeBotEvents } from './bots';

/** 在册成员登记为 Code 会话可调用的 agent type；成员目录变化（catalog）后重建 */
export function registerMemberAgentTypes(): void {
  let cache: MemberAgentType[] | null = null;
  observeBotEvents((event) => {
    if (event.kind === 'catalog') cache = null;
  });
  setMemberAgentTypeSource(() => {
    if (!botModeEnabled()) return [];
    const bots = getBotServices()?.bots;
    if (!bots) return [];
    cache ??= listMemberAgentTypes(bots.list(), (id) => bots.readPersona(id));
    return cache;
  });
}
