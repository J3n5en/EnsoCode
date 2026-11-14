import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  isSecretarySkillName,
  parseSecretarySkillDraft,
  parseSecretarySkillFile,
  renderSecretarySkillFile,
} from './skills';

describe('isSecretarySkillName', () => {
  it('accepts lowercase slugs', () => {
    for (const name of ['a', 'deploy-check', 'release-1-2']) {
      expect(isSecretarySkillName(name), name).toBe(true);
    }
  });

  it('rejects anything that could escape the skills directory or break the loader', () => {
    for (const name of [
      '../escape',
      'a/b',
      'a\\b',
      '/abs',
      '..',
      '',
      'Upper',
      'two--hyphens',
      '-lead',
      'trail-',
      'has space',
      'a'.repeat(49),
    ]) {
      expect(isSecretarySkillName(name), name).toBe(false);
    }
    expect(isSecretarySkillName(7)).toBe(false);
    expect(isSecretarySkillName(undefined)).toBe(false);
  });
});

describe('parseSecretarySkillDraft', () => {
  it('trims the fields and keeps the body as written', () => {
    expect(
      parseSecretarySkillDraft({
        name: ' deploy-check ',
        description: ' 发布前跑一遍 ',
        body: '\n# 步骤\n\n- 跑测试\n',
      })
    ).toEqual({
      ok: true,
      draft: { name: 'deploy-check', description: '发布前跑一遍', body: '# 步骤\n\n- 跑测试' },
    });
  });

  it('rejects a bad name, a multi-line description, an empty body and oversize input', () => {
    expect(parseSecretarySkillDraft({ name: '../x', description: 'd', body: 'b' })).toEqual({
      ok: false,
      error: 'invalid skill name',
    });
    expect(parseSecretarySkillDraft({ name: 'ok', description: 'two\nlines', body: 'b' })).toEqual({
      ok: false,
      error: 'invalid skill description',
    });
    expect(parseSecretarySkillDraft({ name: 'ok', description: 'd', body: '  ' })).toEqual({
      ok: false,
      error: 'invalid skill body',
    });
    expect(
      parseSecretarySkillDraft({ name: 'ok', description: 'd'.repeat(1025), body: 'b' })
    ).toEqual({ ok: false, error: 'invalid skill description' });
    expect(parseSecretarySkillDraft(null)).toEqual({ ok: false, error: 'invalid skill' });
  });
});

describe('skill file format', () => {
  const draft = { name: 'deploy-check', description: '发布前跑一遍', body: '# 步骤\n\n- 跑测试' };

  it('round-trips through the SKILL.md frontmatter', () => {
    expect(parseSecretarySkillFile(renderSecretarySkillFile(draft))).toEqual(draft);
  });

  it('writes frontmatter the skill loader can parse even with YAML-significant descriptions', () => {
    for (const description of ['发布前: 跑测试', '[x] 列表', '"引号"开头', '#标签', 'yes']) {
      const file = renderSecretarySkillFile({ ...draft, description });
      const yamlText = file.slice(4, file.indexOf('\n---', 3));
      expect(parseYaml(yamlText)).toEqual({ name: draft.name, description });
      expect(parseSecretarySkillFile(file)).toEqual({ ...draft, description });
    }
  });

  it('reads a hand-written file with extra frontmatter keys', () => {
    const raw = '---\nname: deploy-check\ndescription: 发布前跑一遍\nlicense: MIT\n---\n\n# 步骤';
    expect(parseSecretarySkillFile(raw)).toEqual({
      name: 'deploy-check',
      description: '发布前跑一遍',
      body: '# 步骤',
    });
  });

  it('returns null for a file it cannot trust', () => {
    expect(parseSecretarySkillFile('')).toBeNull();
    expect(parseSecretarySkillFile('# 没有 frontmatter')).toBeNull();
    expect(parseSecretarySkillFile('---\nname: deploy-check\n---\n\nbody')).toBeNull();
    expect(parseSecretarySkillFile('---\nname: ../x\ndescription: d\n---\n\nbody')).toBeNull();
  });
});
