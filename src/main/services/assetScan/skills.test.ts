import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjectSkills, readPluginSkills, readSkillsRoot } from './skills';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-skills-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(root: string, dir: string, frontmatter: string | null, body = '正文') {
  const skillDir = path.join(root, dir);
  fs.mkdirSync(skillDir, { recursive: true });
  const content = frontmatter === null ? body : `---\n${frontmatter}\n---\n\n${body}`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
  return skillDir;
}

describe('readSkillsRoot', () => {
  it('从 frontmatter 读取名称与描述', () => {
    writeSkill(tmp, 'cloudflare', 'name: cloudflare\ndescription: Cloudflare 平台技能');
    const [skill] = readSkillsRoot(tmp, 'Claude Code');
    expect(skill.name).toBe('cloudflare');
    expect(skill.description).toBe('Cloudflare 平台技能');
    expect(skill.groupName).toBe('Claude Code');
    expect(skill.path).toBe(path.join(tmp, 'cloudflare'));
  });

  it('frontmatter 缺 name 时回退到目录名', () => {
    writeSkill(tmp, 'my-skill', 'description: 只有描述');
    expect(readSkillsRoot(tmp, 'x')[0].name).toBe('my-skill');
  });

  it('完全没有 frontmatter 也能读出目录名', () => {
    writeSkill(tmp, 'plain', null);
    const [skill] = readSkillsRoot(tmp, 'x');
    expect(skill.name).toBe('plain');
    expect(skill.description).toBe('');
  });

  it('frontmatter 是坏 YAML 时不抛错，回退目录名', () => {
    writeSkill(tmp, 'broken', 'name: [unclosed\n  bad: : :');
    const [skill] = readSkillsRoot(tmp, 'x');
    expect(skill.name).toBe('broken');
  });

  it('跳过没有 SKILL.md 的目录', () => {
    fs.mkdirSync(path.join(tmp, 'not-a-skill'));
    writeSkill(tmp, 'real', 'name: real');
    const skills = readSkillsRoot(tmp, 'x');
    expect(skills.map((s) => s.name)).toEqual(['real']);
  });

  it('跳过根目录下的散文件', () => {
    fs.writeFileSync(path.join(tmp, 'README.md'), '# 不是技能');
    expect(readSkillsRoot(tmp, 'x')).toEqual([]);
  });

  it('目录不存在时返回空数组', () => {
    expect(readSkillsRoot(path.join(tmp, 'nope'), 'x')).toEqual([]);
  });
});

describe('readPluginSkills', () => {
  it('按 installPath 读取插件包内的技能，并用插件名分组', () => {
    const installPath = path.join(tmp, 'cache', 'superpowers', '1.0.0');
    writeSkill(path.join(installPath, 'skills'), 'brainstorming', 'name: brainstorming');
    writeSkill(path.join(installPath, 'skills'), 'debugging', 'name: debugging');

    const manifest = path.join(tmp, 'installed_plugins.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({ plugins: { 'superpowers@marketplace': [{ installPath }] } })
    );

    const skills = readPluginSkills(manifest);
    expect(skills.map((s) => s.name).sort()).toEqual(['brainstorming', 'debugging']);
    // "name@marketplace" 只取插件名部分
    expect(skills[0].groupName).toBe('superpowers');
  });

  it('清单不存在或损坏时返回空数组', () => {
    expect(readPluginSkills(path.join(tmp, 'missing.json'))).toEqual([]);

    const broken = path.join(tmp, 'broken.json');
    fs.writeFileSync(broken, '{ not json');
    expect(readPluginSkills(broken)).toEqual([]);
  });

  it('跳过缺少 installPath 的记录', () => {
    const manifest = path.join(tmp, 'm.json');
    fs.writeFileSync(manifest, JSON.stringify({ plugins: { 'a@b': [{ version: '1' }] } }));
    expect(readPluginSkills(manifest)).toEqual([]);
  });

  it('installPath 指向不存在的目录时不抛错', () => {
    const manifest = path.join(tmp, 'm.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({ plugins: { 'a@b': [{ installPath: '/definitely/not/here' }] } })
    );
    expect(readPluginSkills(manifest)).toEqual([]);
  });
});

describe('listProjectSkills', () => {
  it('spawn 前菜单覆盖 pi 运行时的全部自动发现根:项目 + 用户全局', () => {
    // pi 会自动发现 ~/.pi/agent/skills 与 ~/.agents/skills(docs/skills.md),
    // spawn 前的斜杠菜单漏掉全局根会导致"新会话没有 /skill"
    const cwd = path.join(tmp, 'proj');
    const home = path.join(tmp, 'home');
    writeSkill(path.join(cwd, '.agents', 'skills'), 'proj-a', 'name: proj-a\ndescription: p');
    writeSkill(path.join(home, '.agents', 'skills'), 'global-a', 'name: global-a\ndescription: g');
    writeSkill(path.join(home, '.pi', 'agent', 'skills'), 'global-b', 'name: global-b\ndescription: g2');
    const names = listProjectSkills(cwd, home).map((skill) => skill.name);
    expect(names).toContain('proj-a');
    expect(names).toContain('global-a');
    expect(names).toContain('global-b');
  });

  it('同名 skill 项目优先,全局根不重复上报', () => {
    const cwd = path.join(tmp, 'proj');
    const home = path.join(tmp, 'home');
    writeSkill(path.join(cwd, '.agents', 'skills'), 'dup', 'name: dup\ndescription: project');
    writeSkill(path.join(home, '.agents', 'skills'), 'dup', 'name: dup\ndescription: global');
    const skills = listProjectSkills(cwd, home);
    expect(skills.filter((skill) => skill.name === 'dup')).toEqual([
      { name: 'dup', description: 'project' },
    ]);
  });
});
