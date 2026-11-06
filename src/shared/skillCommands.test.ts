import { describe, expect, it } from 'vitest';
import {
  expandSkillCommands,
  joinSkillCommands,
  parseSkillCommands,
  splitSkillBlocks,
  userTextWithoutSkills,
} from './skillCommands';

const skills = {
  a: { name: 'a', filePath: '/s/a/SKILL.md', baseDir: '/s/a' },
  b: { name: 'b', filePath: '/s/b/SKILL.md', baseDir: '/s/b' },
};
const lookup = (name: string) => skills[name as keyof typeof skills];
const read = (path: string) => `\n# ${path}\n`;
const block = (n: 'a' | 'b') =>
  `<skill name="${n}" location="/s/${n}/SKILL.md">\nReferences are relative to /s/${n}.\n\n# /s/${n}/SKILL.md\n</skill>`;

describe('parseSkillCommands', () => {
  it('取开头连续的 /skill:', () => {
    expect(parseSkillCommands('/skill:a  /skill:b 做事 /skill:c')).toEqual({
      names: ['a', 'b'],
      rest: '做事 /skill:c',
    });
    expect(parseSkillCommands('/skill:a')).toEqual({ names: ['a'], rest: '' });
    expect(parseSkillCommands('做事 /skill:a')).toEqual({ names: [], rest: '做事 /skill:a' });
  });
});

describe('expandSkillCommands', () => {
  it('与 pi 单个展开格式一致，多个按序拼接', () => {
    expect(expandSkillCommands('/skill:a /skill:b 做事', lookup, read)).toBe(
      `${block('a')}\n\n${block('b')}\n\n做事`
    );
    expect(expandSkillCommands('/skill:a', lookup, read)).toBe(block('a'));
  });

  it('遇到未知 skill 停止，余下原样保留', () => {
    expect(expandSkillCommands('/skill:a /skill:x 做事', lookup, read)).toBe(
      `${block('a')}\n\n/skill:x 做事`
    );
    expect(expandSkillCommands('/skill:x 做事', lookup, read)).toBe('/skill:x 做事');
  });

  it('读取失败不展开该 skill', () => {
    const fail = () => {
      throw new Error('nope');
    };
    expect(expandSkillCommands('/skill:a 做事', lookup, fail)).toBe('/skill:a 做事');
  });
});

describe('splitSkillBlocks', () => {
  it('拆出开头连续的技能块与正文', () => {
    expect(splitSkillBlocks(`${block('a')}\n\n${block('b')}\n\n做事`)).toEqual({
      skills: [
        {
          name: 'a',
          location: '/s/a/SKILL.md',
          body: 'References are relative to /s/a.\n\n# /s/a/SKILL.md',
        },
        {
          name: 'b',
          location: '/s/b/SKILL.md',
          body: 'References are relative to /s/b.\n\n# /s/b/SKILL.md',
        },
      ],
      rest: '做事',
    });
    expect(splitSkillBlocks(block('a'))?.rest).toBe('');
    expect(splitSkillBlocks(`前缀 ${block('a')}`)).toBeNull();
  });

  it('正文里提到 </skill> 不影响拆分', () => {
    expect(splitSkillBlocks(`${block('a')}\n\n看看 </skill> 是什么`)?.rest).toBe(
      '看看 </skill> 是什么'
    );
  });
});

describe('joinSkillCommands', () => {
  it('拼回 /skill: 命令', () => {
    expect(joinSkillCommands(['a', 'b'], '做事')).toBe('/skill:a /skill:b 做事');
    expect(joinSkillCommands(['a'], '')).toBe('/skill:a');
  });

  it('展示文本去掉技能块后的一次性提示', () => {
    const text =
      '<skill name="a" location="/a">\n# a\n</skill>\n\n<unattended>\nUnattended mode is ON: x\n</unattended>\n\n做事';
    expect(userTextWithoutSkills(text)).toEqual({ text: '做事', names: ['a'] });
  });
});
