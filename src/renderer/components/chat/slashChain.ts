import { parseSkillCommands } from '@shared/skillCommands';
import { splitSlashCommand } from './SlashChip';

// 芯片序列：空、单个非 skill 命令，或若干不重复的 skill（worker 会把开头连续的 /skill: 全部展开）

const isSkill = (name: string) => name.startsWith('/skill:');

export function pushSlash(current: readonly string[], name: string): string[] {
  if (!isSkill(name) || !current.every(isSkill)) return [name];
  return current.includes(name) ? [...current] : [...current, name];
}

export function splitSlashChain(text: string): { slashes: string[]; rest: string } {
  const skills = parseSkillCommands(text);
  if (skills.names.length > 0) {
    return { slashes: skills.names.map((name) => `/skill:${name}`), rest: skills.rest };
  }
  const parsed = splitSlashCommand(text);
  return { slashes: parsed.slash ? [parsed.slash] : [], rest: parsed.rest };
}
