import type { InlineExtension, ToolInfo } from '@earendil-works/pi-coding-agent';
import { oneLine } from './mcpNames';

export type CatalogTool = Pick<ToolInfo, 'name' | 'description' | 'namespace'>;
export interface CatalogSkill {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation?: boolean;
}

const TOOL_LINE_MAX = 160;
const SKILL_DESCRIPTION_MAX = 280;
const CATALOG_MAX = 7600;
const BUILT_IN = 'built-in';

const CATALOG_INTRO = [
  'These tools are declared to you as well, although <tools> above does not list them. Grouped by source.',
  'They are not secondary. When one is built for the current step (semantic code search, web lookup, browser control, memory, an external service), call it rather than approximating the step with bash, read or grep.',
].join('\n');

function firstSentence(text: string): string {
  const line = oneLine(text, 1000);
  const end = line.search(/[.!?。！？](\s|$)/);
  return end < 0 ? line : line.slice(0, end + 1);
}

/** 未进 <tools> 的已激活工具，按 namespace 分组；排序稳定，避免无谓地改动缓存前缀。 */
export function renderToolCatalogSection(tools: readonly CatalogTool[]): string | undefined {
  if (tools.length === 0) return undefined;
  const groups = new Map<string, { summary?: string; tools: CatalogTool[] }>();
  for (const item of tools) {
    const key = item.namespace?.name ?? BUILT_IN;
    const group = groups.get(key) ?? { summary: item.namespace?.description, tools: [] };
    group.tools.push(item);
    groups.set(key, group);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    a === BUILT_IN ? 1 : b === BUILT_IN ? -1 : a.localeCompare(b)
  );
  const lines = [CATALOG_INTRO];
  let size = CATALOG_INTRO.length;
  const skipped: string[] = [];
  for (const key of keys) {
    const group = groups.get(key)!;
    const summary = group.summary && group.summary !== key ? oneLine(group.summary, 120) : '';
    const header = `\n${key}${summary ? ` — ${summary}` : ''}`;
    const rows = [...group.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({
        name: item.name,
        text: oneLine(`- ${item.name}: ${firstSentence(item.description)}`, TOOL_LINE_MAX),
      }));
    let headed = false;
    for (const row of rows) {
      const cost = row.text.length + 1 + (headed ? 0 : header.length + 1);
      if (skipped.length > 0 || size + cost > CATALOG_MAX) {
        skipped.push(row.name);
        continue;
      }
      if (!headed) lines.push(header);
      headed = true;
      lines.push(row.text);
      size += cost;
    }
  }
  if (skipped.length > 0) {
    lines.push(oneLine(`\n+${skipped.length} more: ${skipped.join(', ')}`, 300));
  }
  return lines.join('\n');
}

/** 替换 pi 默认 skills 段：描述截短以减少稀释，并要求命中时先读 SKILL.md。 */
export function renderSkillsSection(
  skills: readonly CatalogSkill[],
  readTool: 'read' | 'bash' | 'skill_read' | undefined
): string | undefined {
  const visible = skills
    .filter((item) => !item.disableModelInvocation)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!readTool || visible.length === 0) return undefined;
  const how =
    readTool === 'read'
      ? 'the read tool'
      : readTool === 'bash'
        ? 'bash (cat)'
        : 'the skill_read tool with its name';
  return [
    'Skills are tested playbooks kept as SKILL.md files. Each entry: name [file] — when it applies.',
    `- When the request falls under a skill, open its file with ${how} before starting the work and follow it. Acting on a guess of its contents defeats the point.`,
    '- One read per skill per task is enough; skills unrelated to the task can be ignored.',
    '- Relative paths inside a skill resolve against the directory that contains its SKILL.md.',
    '',
    ...visible.map((item) =>
      readTool === 'skill_read'
        ? `- ${oneLine(item.name, 64)} — ${oneLine(item.description, SKILL_DESCRIPTION_MAX)}`
        : `- ${oneLine(item.name, 64)} [${item.filePath}] — ${oneLine(item.description, SKILL_DESCRIPTION_MAX)}`
    ),
  ].join('\n');
}

export const promptCatalogExtension = {
  name: 'prompt-catalog',
  hidden: true,
  factory: (pi) => {
    pi.on('before_agent_start', (event) => {
      const options = event.systemPromptOptions;
      const active = new Set(options.selectedTools);
      const extra = pi
        .getAllTools()
        .filter((item) => active.has(item.name) && !options.toolSnippets[item.name]);
      const catalog = renderToolCatalogSection(extra);
      if (catalog) options.sections.tool_catalog = catalog;
      // 秘书会话没有 read / bash，只有 skill_read：不认它整段 skills 会消失
      const readTool =
        (['read', 'bash'] as const).find((name) => active.has(name)) ??
        (active.has('skill_read') ? ('skill_read' as const) : undefined);
      const skills = renderSkillsSection(options.skills, readTool);
      if (skills) options.sections.skills = skills;
    });
  },
} satisfies InlineExtension;
