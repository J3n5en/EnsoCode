import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { replacePersonaParagraph } from '@shared/systemPrompt';

/** 可就地替换的人设：秘书档案改了由 Main 推新正文，下一轮 before_agent_start 即生效，会话与历史不动 */
export interface PersonaHolder {
  current: string;
}

/** 替换 pi 开头角色段；每轮现读 holder，不在 spawn 时定死 */
export function personaExtension(holder: PersonaHolder): InlineExtension {
  return {
    name: 'custom-persona',
    hidden: true,
    factory: (pi) => {
      pi.on('before_agent_start', (event) => ({
        systemPrompt: replacePersonaParagraph(event.systemPrompt, holder.current),
      }));
    },
  };
}
