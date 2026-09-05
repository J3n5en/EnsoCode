import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getManagedSkillsDir, writeManagedSkill } from './managedSkill';

describe('writeManagedSkill', () => {
  it('creates SKILL.md under agentDir/managed-skills/<name>', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'enso-ms-'));
    const result = await writeManagedSkill(
      agentDir,
      {
        action: 'create',
        name: 'Login-Fix',
        description: 'How we retry auth',
        body: 'Check the null token first.',
      },
      new Set()
    );
    expect(result.ok).toBe(true);
    const file = path.join(getManagedSkillsDir(agentDir), 'login-fix', 'SKILL.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('Check the null token first.');
  });

  it('refuses to shadow an authored skill name', async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), 'enso-ms-'));
    const result = await writeManagedSkill(
      agentDir,
      {
        action: 'create',
        name: 'login-fix',
        description: 'dup',
        body: 'body',
      },
      new Set(['login-fix'])
    );
    expect(result).toMatchObject({ ok: false, shadowed: true });
    expect(existsSync(path.join(getManagedSkillsDir(agentDir), 'login-fix'))).toBe(false);
  });
});
