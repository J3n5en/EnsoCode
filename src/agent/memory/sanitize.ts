import path from 'node:path';

export function neutralizeInjection(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[<>`]/g, '')
    .replace(/~{2,}/g, '~')
    .replace(/\s+/g, ' ')
    .trim();
}

export function redactSecrets(input: string): string {
  let out = input;
  const patterns = [
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    /(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/gi,
    /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
    /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /npm_[A-Za-z0-9]{30,}/g,
    /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    /AIza[A-Za-z0-9_-]{30,}/g,
  ];
  for (const pattern of patterns) out = out.replace(pattern, '[REDACTED]');
  return out;
}

export function normalizeLearnedText(text: string, maxChars: number): string {
  const cleaned = redactSecrets(neutralizeInjection(text)).trim();
  if (cleaned.length <= maxChars) return cleaned;
  const sliced = cleaned.slice(0, maxChars);
  return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function sanitizeSkillName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid skill name "${raw}". Use lowercase letters, digits, and hyphens (1-64 chars, starting with a letter or digit).`
    );
  }
  return name;
}

export function resolveMemoryUri(uri: string, memoryRoot: string): string | undefined {
  if (!uri.startsWith('memory://root/')) return undefined;
  const rest = uri.slice('memory://root/'.length);
  const resolved = path.resolve(memoryRoot, rest);
  const root = path.resolve(memoryRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return undefined;
  return resolved;
}
