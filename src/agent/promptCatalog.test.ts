import type { ToolInfo } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  type CatalogSkill,
  type CatalogTool,
  promptCatalogExtension,
  renderSkillsSection,
  renderToolCatalogSection,
} from './promptCatalog';

const tool = (name: string, description: string, namespace?: string): CatalogTool => ({
  name,
  description,
  ...(namespace ? { namespace: { name: namespace, description: `${namespace} server` } } : {}),
});

const skill = (name: string, description: string, extra: Partial<CatalogSkill> = {}) => ({
  name,
  description,
  filePath: `/skills/${name}/SKILL.md`,
  ...extra,
});

describe('renderToolCatalogSection', () => {
  it('没有额外工具时不出段', () => {
    expect(renderToolCatalogSection([])).toBeUndefined();
  });

  it('按来源分组，只保留描述首句，顺序与输入无关', () => {
    const tools = [
      tool('web_search', 'Search the web. Returns a summary and URLs.'),
      tool('mcp__docs__search', 'Find docs pages. Extra detail here.', 'mcp__docs'),
      tool('mcp__docs__get', 'Fetch one page.', 'mcp__docs'),
    ];
    const section = renderToolCatalogSection(tools) ?? '';
    expect(section).toBe(renderToolCatalogSection([...tools].reverse()));
    expect(section).toContain('mcp__docs — mcp__docs server');
    expect(section).toContain('- mcp__docs__search: Find docs pages.');
    expect(section).not.toContain('Extra detail');
    expect(section).toContain('- web_search: Search the web.');
    expect(section.indexOf('mcp__docs__get')).toBeLessThan(section.indexOf('mcp__docs__search'));
  });

  it('超长描述截断，总量超预算时汇总剩余工具名', () => {
    const long = renderToolCatalogSection([tool('t', 'x'.repeat(500))]) ?? '';
    const line = long.split('\n').find((row) => row.startsWith('- t:')) ?? '';
    expect(line.length).toBeLessThanOrEqual(170);
    const many = Array.from({ length: 200 }, (_, i) =>
      tool(`tool_${String(i).padStart(3, '0')}`, 'y'.repeat(150))
    );
    const section = renderToolCatalogSection(many) ?? '';
    expect(section.length).toBeLessThanOrEqual(8000);
    expect(section).toMatch(/\+\d+ more/);
  });
});

describe('renderSkillsSection', () => {
  it('没有可见 skill 或没有读文件工具时不出段', () => {
    expect(renderSkillsSection([], 'read')).toBeUndefined();
    expect(renderSkillsSection([skill('a', 'A')], undefined)).toBeUndefined();
    expect(
      renderSkillsSection([skill('a', 'A', { disableModelInvocation: true })], 'read')
    ).toBeUndefined();
  });

  it('列出名称、路径与截断后的描述，并要求先读后做', () => {
    const section =
      renderSkillsSection(
        [skill('zeta', 'Z skill'), skill('alpha', `Use when ${'w'.repeat(600)}`)],
        'read'
      ) ?? '';
    expect(section).toContain('/skills/alpha/SKILL.md');
    expect(section.indexOf('alpha')).toBeLessThan(section.indexOf('zeta'));
    const alpha = section.split('\n').find((row) => row.includes('/skills/alpha/')) ?? '';
    expect(alpha.length).toBeLessThanOrEqual(400);
    expect(section).toMatch(/\bread\b/);
    expect(renderSkillsSection([skill('a', 'A')], 'bash')).toMatch(/\bbash\b/);
  });

  it('只有 skill_read 时按名字读，且不暴露文件路径', () => {
    const section =
      renderSkillsSection([skill('deploy-check', '发布前跑一遍')], 'skill_read') ?? '';
    expect(section).toContain('skill_read');
    expect(section).toContain('deploy-check');
    expect(section).not.toContain('/skills/deploy-check/SKILL.md');
  });
});

describe('promptCatalogExtension', () => {
  type StartHandler = (event: { systemPromptOptions: Record<string, unknown> }) => unknown;

  function run(options: Record<string, unknown>, all: Partial<ToolInfo>[]) {
    let handler: StartHandler | undefined;
    const pi = {
      on: (name: string, fn: StartHandler) => {
        if (name === 'before_agent_start') handler = fn;
      },
      getAllTools: () => all,
    };
    promptCatalogExtension.factory(pi as never);
    const systemPromptOptions = { sections: {}, toolSnippets: {}, skills: [], ...options };
    handler?.({ systemPromptOptions });
    return systemPromptOptions.sections as Record<string, string>;
  }

  it('只为已激活且未进 <tools> 的工具建目录，并替换 skills 段', () => {
    const sections = run(
      {
        selectedTools: ['read', 'mcp__docs__search', 'web_search'],
        toolSnippets: { read: 'Read file contents' },
        skills: [skill('alpha', 'Alpha skill')],
      },
      [
        { name: 'read', description: 'Read a file.' },
        { name: 'mcp__docs__search', description: 'Find docs.', namespace: { name: 'mcp__docs' } },
        { name: 'web_search', description: 'Search the web.' },
        { name: 'browser_click', description: 'Click.' },
      ]
    );
    expect(sections.tool_catalog).toContain('mcp__docs__search');
    expect(sections.tool_catalog).toContain('web_search');
    expect(sections.tool_catalog).not.toContain('browser_click');
    expect(sections.tool_catalog).not.toContain('- read:');
    expect(sections.skills).toContain('/skills/alpha/SKILL.md');
  });

  it('无额外工具、无 skill 时不写段', () => {
    const sections = run({ selectedTools: ['read'], toolSnippets: { read: 'x' } }, [
      { name: 'read', description: 'Read a file.' },
    ]);
    expect(sections).toEqual({});
  });

  it('秘书会话没有 read / bash，靠 skill_read 出 skills 段', () => {
    const sections = run(
      {
        selectedTools: ['skill_read', 'session_list'],
        toolSnippets: { session_list: 'List sessions' },
        skills: [skill('deploy-check', '发布前跑一遍')],
      },
      [{ name: 'skill_read', description: 'Read a skill.' }]
    );
    expect(sections.skills).toContain('skill_read');
    expect(sections.skills).toContain('deploy-check');
  });
});
