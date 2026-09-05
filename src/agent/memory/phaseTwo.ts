import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets, sanitizeSkillName } from './sanitize';

export type PhaseTwoSkill = { name: string; content: string };

export type PhaseTwoOutput = {
  memory_md: string;
  memory_summary: string;
  skills: PhaseTwoSkill[];
};

function unwrapJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const want = [...expected].sort();
  return keys.length === want.length && keys.every((key, i) => key === want[i]);
}

function parseSkills(value: unknown): PhaseTwoSkill[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const skills: PhaseTwoSkill[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const data = item as Record<string, unknown>;
    if (typeof data.name !== 'string' || typeof data.content !== 'string') return undefined;
    skills.push({ name: data.name, content: data.content });
  }
  return skills;
}

export function parsePhaseTwoResponse(text: string): PhaseTwoOutput | undefined {
  try {
    const parsed: unknown = JSON.parse(unwrapJsonText(text));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (!hasExactKeys(value, ['memory_md', 'memory_summary', 'skills'])) return undefined;
    if (typeof value.memory_md !== 'string' || typeof value.memory_summary !== 'string') {
      return undefined;
    }
    const skills = parseSkills(value.skills);
    if (!skills) return undefined;
    return { memory_md: value.memory_md, memory_summary: value.memory_summary, skills };
  } catch {
    return undefined;
  }
}

export async function applyConsolidation(
  memoryRoot: string,
  output: PhaseTwoOutput
): Promise<void> {
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(
    path.join(memoryRoot, 'MEMORY.md'),
    `${redactSecrets(output.memory_md).trim()}\n`,
    'utf8'
  );
  await writeFile(
    path.join(memoryRoot, 'memory_summary.md'),
    `${redactSecrets(output.memory_summary).trim()}\n`,
    'utf8'
  );
  const skillsDir = path.join(memoryRoot, 'skills');
  await mkdir(skillsDir, { recursive: true });
  const keep = new Set<string>();
  for (const skill of output.skills) {
    let name = skill.name;
    try {
      name = sanitizeSkillName(skill.name);
    } catch {
      continue;
    }
    keep.add(name);
    const dir = path.join(skillsDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), redactSecrets(skill.content), 'utf8');
  }
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    await rm(path.join(skillsDir, entry.name), { recursive: true, force: true });
  }
}
