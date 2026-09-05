import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLearnTool } from './learn';
import { getMemoryRoot } from './localMemory';

describe('createLearnTool (OMP-aligned)', () => {
  const agentDir = () => mkdtempSync(path.join(tmpdir(), 'enso-agent-'));
  const cwd = '/Users/me/proj';

  it('exposes learn metadata: name/label/description/required params', () => {
    const tool = createLearnTool({ agentDir: agentDir(), cwd });
    expect(tool.name).toBe('learn');
    expect(tool.label).toBe('Learn');
    expect(tool.description).toMatch(/lesson/i);
    expect(tool.description).toMatch(/skill/i);
    const schema = tool.parameters as unknown as {
      required?: string[];
      properties: { memory?: { type?: string }; context?: { type?: string } };
    };
    expect(schema.required).toEqual(['memory']);
    expect(schema.properties.memory?.type).toBe('string');
    expect(schema.properties.context?.type).toBe('string');
  });

  it('happy path saves the lesson and returns a text confirmation with details.skill=null', async () => {
    const dir = agentDir();
    const tool = createLearnTool({ agentDir: dir, cwd });
    const result = await tool.execute(
      't1',
      { memory: 'Prefer Bun.file over readFileSync.', context: 'from the build' } as never,
      undefined,
      undefined,
      {} as never
    );
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text.endsWith('.') || /Lesson/.test(text)).toBe(true);
    expect(result.details).toEqual({ skill: null });
    const file = path.join(getMemoryRoot(dir, cwd), 'learned.md');
    expect(readFileSync(file, 'utf8')).toBe(
      '- Prefer Bun.file over readFileSync. _(context: from the build)_\n'
    );
  });

  it('empty memory throws and does not create learned.md', async () => {
    const dir = agentDir();
    const tool = createLearnTool({ agentDir: dir, cwd });
    await expect(
      tool.execute('t2', { memory: '   ' } as never, undefined, undefined, {} as never)
    ).rejects.toThrow();
    const file = path.join(getMemoryRoot(dir, cwd), 'learned.md');
    expect(existsSync(file)).toBe(false);
  });

  it('never writes {cwd}/.enso/learned.md', async () => {
    const dir = agentDir();
    const realCwd = mkdtempSync(path.join(tmpdir(), 'enso-cwd-'));
    const tool = createLearnTool({ agentDir: dir, cwd: realCwd });
    await tool.execute('t3', { memory: 'alpha' } as never, undefined, undefined, {} as never);
    expect(existsSync(path.join(realCwd, '.enso', 'learned.md'))).toBe(false);
  });

  it('writes an optional managed skill after the lesson', async () => {
    const dir = agentDir();
    const tool = createLearnTool({ agentDir: dir, cwd });
    const result = await tool.execute(
      't4',
      {
        memory: 'Retry auth after 401.',
        skill: {
          action: 'create',
          name: 'login-fix',
          description: 'How we retry auth',
          body: 'Check the null token first.',
        },
      } as never,
      undefined,
      undefined,
      {} as never
    );
    expect((result.content[0] as { text: string }).text).toMatch(/Managed skill/);
    expect(existsSync(path.join(dir, 'managed-skills', 'login-fix', 'SKILL.md'))).toBe(true);
  });

  it('keeps the lesson when skill name is shadowed by authored skills', async () => {
    const dir = agentDir();
    const tool = createLearnTool({
      agentDir: dir,
      cwd,
      skillPaths: ['/users/skills/login-fix'],
    });
    const result = await tool.execute(
      't5',
      {
        memory: 'Keep this lesson.',
        skill: {
          action: 'create',
          name: 'login-fix',
          description: 'dup',
          body: 'body',
        },
      } as never,
      undefined,
      undefined,
      {} as never
    );
    expect(result.isError).toBe(true);
    expect(readFileSync(path.join(getMemoryRoot(dir, cwd), 'learned.md'), 'utf8')).toContain(
      'Keep this lesson.'
    );
    expect(existsSync(path.join(dir, 'managed-skills', 'login-fix'))).toBe(false);
  });
});
