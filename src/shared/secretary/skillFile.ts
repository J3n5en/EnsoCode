import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { SecretarySkillDraft } from '../types/secretary';
import { parseSecretarySkillDraft } from './skills';

export function renderSecretarySkillFile(draft: SecretarySkillDraft): string {
  const frontmatter = stringifyYaml({ name: draft.name, description: draft.description });
  return `---\n${frontmatter}---\n\n${draft.body}\n`;
}

/** 只认本应用写出的格式；读不懂就当作没有，免得把坏文件当成 skill 挂上去 */
export function parseSecretarySkillFile(raw: string): SecretarySkillDraft | null {
  const text = raw.replace(/^\uFEFF/u, '');
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  let fields: unknown;
  try {
    fields = parseYaml(text.slice(3, end));
  } catch {
    return null;
  }
  if (!fields || typeof fields !== 'object') return null;
  const { name, description } = fields as Record<string, unknown>;
  const parsed = parseSecretarySkillDraft({
    name,
    description,
    body: text.slice(end + 4),
  });
  return parsed.ok ? parsed.draft : null;
}
