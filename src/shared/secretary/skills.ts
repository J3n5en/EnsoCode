import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { SecretarySkillDraft } from '../types/secretary';

/** 目录名同时是 skill 名：只允许小写字母、数字与单连字符，天然排除路径穿越 */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

export const SKILL_NAME_MAX = 48;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_BODY_MAX = 20_000;

/** skill 与工具共用同一套 slug 规则 */
export function isSecretarySlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SKILL_NAME_MAX && NAME_RE.test(value);
}

export const isSecretarySkillName = isSecretarySlug;

export type SkillDraftResult =
  | { ok: true; draft: SecretarySkillDraft }
  | { ok: false; error: string };

/** 提案参数、卡片草案与磁盘内容共用同一套收窄 */
export function parseSecretarySkillDraft(value: unknown): SkillDraftResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'invalid skill' };
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!isSecretarySkillName(name)) return { ok: false, error: 'invalid skill name' };
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  if (!description || description.length > SKILL_DESCRIPTION_MAX || /[\r\n]/u.test(description)) {
    return { ok: false, error: 'invalid skill description' };
  }
  const body = typeof record.body === 'string' ? record.body.trim() : '';
  if (!body || body.length > SKILL_BODY_MAX) return { ok: false, error: 'invalid skill body' };
  return { ok: true, draft: { name, description, body } };
}

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
