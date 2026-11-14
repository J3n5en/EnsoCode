import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSkillReadTool, type LoadedSkill } from './skills';

let dir = '';
let loaded: LoadedSkill[] = [];

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'skill-read-'));
  const own = path.join(dir, 'own', 'SKILL.md');
  mkdirSync(path.dirname(own), { recursive: true });
  writeFileSync(own, '---\nname: own\ndescription: 自有 skill\n---\n\n# 步骤\n\n- 跑测试\n');
  writeFileSync(path.join(dir, 'outside.md'), 'secret');
  loaded = [
    { name: 'own', description: '自有 skill', filePath: own },
    { name: 'missing-file', description: '文件没了', filePath: path.join(dir, 'gone.md') },
  ];
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = async (params: unknown) => {
  const tool = createSkillReadTool(() => loaded);
  return tool.execute('call-1', params as never, undefined, undefined, {} as never);
};

describe('skill_read', () => {
  it('按名字读出本次加载的 SKILL.md', async () => {
    const result = await read({ name: 'own' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toContain('# 步骤');
  });

  it('名字不在加载集合里就报错，并列出可用的名字', async () => {
    const result = await read({ name: 'outside' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Available: own');
  });

  it('不接受路径：带分隔符的名字同样找不到', async () => {
    for (const name of ['../outside.md', '/etc/passwd', 'own/SKILL.md']) {
      const result = await read({ name });
      expect(result.isError, name).toBe(true);
    }
  });

  it('文件读不到时把原因带回去', async () => {
    const result = await read({ name: 'missing-file' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Could not read skill');
  });

  it('缺名字时直接拒绝', async () => {
    expect((await read({})).isError).toBe(true);
    expect((await read({ name: '  ' })).isError).toBe(true);
  });
});
