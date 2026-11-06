import { readFileSync } from 'node:fs';
import {
  type InlineExtension,
  type Skill,
  stripFrontmatter,
} from '@earendil-works/pi-coding-agent';
import { expandSkillCommands } from '@shared/skillCommands';

/** 排在插件 input 拦截之后：插件追加的 /skill: 也一起展开；pi 随后见到非 /skill: 开头会原样放过 */
export function skillChainExtension(skills: () => readonly Skill[]): InlineExtension {
  return {
    name: 'skill-chain',
    hidden: true,
    factory: (pi) => {
      pi.on('input', (event) => {
        if (!event.text.startsWith('/skill:')) return;
        const text = expandSkillCommands(
          event.text,
          (name) => skills().find((skill) => skill.name === name),
          (filePath) => stripFrontmatter(readFileSync(filePath, 'utf-8'))
        );
        return text === event.text ? undefined : { action: 'transform', text };
      });
    },
  };
}
