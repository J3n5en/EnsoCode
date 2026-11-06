import { splitTurnNotes } from './turnNotes';

// 开头连续的 /skill:a /skill:b 全部展开；pi 自身只展开第一个（earendil-works/pi#4986）

export interface SkillRef {
  name: string;
  filePath: string;
  baseDir: string;
}

export interface SkillBlock {
  name: string;
  location: string;
  body: string;
}

const COMMAND = /^\/skill:(\S+)(?:\s+|$)/;
const BLOCK = /^<skill name="([^"]+)" location="([^"]*)">\n([\s\S]*?)\n<\/skill>(?:\n\n|$)/;
const EXPANDED = /<skill name="([^"]*)" location="[^"]*">[\s\S]*?<\/skill>/g;

/** 标题等展示用：去掉已展开的 skill 块和句首 /skill:，只留用户自己写的话。names 供只点了 skill、没有正文时兜底。 */
export function userTextWithoutSkills(text: string): { text: string; names: string[] } {
  const names: string[] = [];
  const withoutBlocks = text.replace(EXPANDED, (_match, name: string) => {
    const trimmed = name.trim();
    if (trimmed) names.push(trimmed);
    return '\n';
  });
  const parsed = parseSkillCommands(withoutBlocks.trim());
  return {
    text: splitTurnNotes(parsed.rest.trim()).rest.trim(),
    names: [...parsed.names, ...names],
  };
}

export function parseSkillCommands(text: string): { names: string[]; rest: string } {
  const names: string[] = [];
  let rest = text;
  for (let match = COMMAND.exec(rest); match; match = COMMAND.exec(rest)) {
    names.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  return { names, rest: names.length > 0 ? rest.trim() : text };
}

export function joinSkillCommands(names: readonly string[], rest: string): string {
  const head = names.map((name) => `/skill:${name}`).join(' ');
  return rest ? `${head} ${rest}` : head;
}

/** 与 pi `_expandSkillCommand` 的块格式逐字一致；readBody 返回去掉 frontmatter 的正文。遇到未知或读不出的 skill 就停，余下原样交给 pi */
export function expandSkillCommands(
  text: string,
  lookup: (name: string) => SkillRef | undefined,
  readBody: (filePath: string) => string
): string {
  const blocks: string[] = [];
  let rest = text;
  for (let match = COMMAND.exec(rest); match; match = COMMAND.exec(rest)) {
    const skill = lookup(match[1]);
    if (!skill) break;
    let body: string;
    try {
      body = readBody(skill.filePath).trim();
    } catch {
      break;
    }
    blocks.push(
      `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
    );
    rest = rest.slice(match[0].length);
  }
  if (blocks.length === 0) return text;
  const tail = rest.trim();
  return tail ? `${blocks.join('\n\n')}\n\n${tail}` : blocks.join('\n\n');
}

export function splitSkillBlocks(text: string): { skills: SkillBlock[]; rest: string } | null {
  const skills: SkillBlock[] = [];
  let rest = text;
  for (let match = BLOCK.exec(rest); match; match = BLOCK.exec(rest)) {
    skills.push({ name: match[1], location: match[2], body: match[3] });
    rest = rest.slice(match[0].length);
  }
  return skills.length > 0 ? { skills, rest: rest.trim() } : null;
}
