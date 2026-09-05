import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { neutralizeInjection, redactSecrets, sanitizeSkillName } from './sanitize';

export const MANAGED_SKILLS_DIR = 'managed-skills';
export const MAX_MANAGED_SKILL_BYTES = 64_000;

export function getManagedSkillsDir(agentDir: string): string {
  return path.join(agentDir, MANAGED_SKILLS_DIR);
}

export type ManagedSkillInput = {
  action: 'create' | 'update';
  name: string;
  description: string;
  body: string;
};

export type ManagedSkillWrite =
  | { ok: true; name: string; path: string }
  | { ok: false; error: string; shadowed?: boolean };

export function authoredSkillNames(skillPaths: string[]): Set<string> {
  return new Set(
    skillPaths.map((p) => path.basename(p).toLowerCase()).filter((name) => name.length > 0)
  );
}

export async function writeManagedSkill(
  agentDir: string,
  input: ManagedSkillInput,
  authored: Set<string>
): Promise<ManagedSkillWrite> {
  let name: string;
  try {
    name = sanitizeSkillName(input.name);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (input.action === 'create' && authored.has(name)) {
    return {
      ok: false,
      shadowed: true,
      error: `Did not create managed skill "${input.name}": an authored skill of that name already exists.`,
    };
  }
  const description = neutralizeInjection(input.description);
  const body = redactSecrets(input.body.trim());
  if (!description)
    return { ok: false, error: `Managed skill "${name}" needs a non-empty description.` };
  if (!body) return { ok: false, error: `Managed skill "${name}" needs a non-empty body.` };
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_MANAGED_SKILL_BYTES) {
    return { ok: false, error: `Managed skill is larger than ${MAX_MANAGED_SKILL_BYTES} bytes.` };
  }
  const file = path.join(getManagedSkillsDir(agentDir), name, 'SKILL.md');
  if (input.action === 'update') {
    const { access } = await import('node:fs/promises');
    try {
      await access(file);
    } catch {
      return { ok: false, error: `Managed skill "${name}" does not exist. Use action "create".` };
    }
  }
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(
      file,
      content,
      input.action === 'create' ? { encoding: 'utf8', flag: 'wx' } : 'utf8'
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, error: `Managed skill "${name}" already exists. Use action "update".` };
    }
    throw error;
  }
  return { ok: true, name, path: file };
}
