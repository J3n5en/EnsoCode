export const CHAT_TYPOGRAPHY_ROLES = [
  'body',
  'h1',
  'h2',
  'h3',
  'h4',
  'table',
  'inlineCode',
  'codeBlock',
] as const;

export type ChatTypographyRole = (typeof CHAT_TYPOGRAPHY_ROLES)[number];

export const CHAT_TYPOGRAPHY_WEIGHTS = [300, 400, 500, 600, 700] as const;

export type ChatTypographyWeight = (typeof CHAT_TYPOGRAPHY_WEIGHTS)[number];

export interface ChatTypographyEntry {
  size: number;
  weight: ChatTypographyWeight;
}

export type ChatTypography = Record<ChatTypographyRole, ChatTypographyEntry>;

export const CHAT_TYPOGRAPHY_SPEC: Record<
  ChatTypographyRole,
  { unit: 'px' | '%'; min: number; max: number; step: number; default: ChatTypographyEntry }
> = {
  body: { unit: 'px', min: 12, max: 20, step: 0.5, default: { size: 14.5, weight: 400 } },
  h1: { unit: '%', min: 100, max: 250, step: 5, default: { size: 150, weight: 600 } },
  h2: { unit: '%', min: 100, max: 250, step: 5, default: { size: 130, weight: 600 } },
  h3: { unit: '%', min: 100, max: 250, step: 5, default: { size: 115, weight: 600 } },
  h4: { unit: '%', min: 80, max: 200, step: 5, default: { size: 100, weight: 600 } },
  table: { unit: '%', min: 70, max: 120, step: 5, default: { size: 90, weight: 400 } },
  inlineCode: { unit: '%', min: 70, max: 120, step: 5, default: { size: 85, weight: 400 } },
  codeBlock: { unit: 'px', min: 9, max: 20, step: 0.5, default: { size: 10.5, weight: 400 } },
};

function cloneEntry(entry: ChatTypographyEntry): ChatTypographyEntry {
  return { size: entry.size, weight: entry.weight };
}

export const DEFAULT_CHAT_TYPOGRAPHY: ChatTypography = Object.fromEntries(
  CHAT_TYPOGRAPHY_ROLES.map((role) => [role, cloneEntry(CHAT_TYPOGRAPHY_SPEC[role].default)])
) as ChatTypography;

function isWeight(value: unknown): value is ChatTypographyWeight {
  return (CHAT_TYPOGRAPHY_WEIGHTS as readonly number[]).includes(value as number);
}

function alignSize(size: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, size));
  const steps = Math.round((clamped - min) / step);
  const aligned = min + steps * step;
  const factor = step < 1 ? 10 : 1;
  return Math.round(aligned * factor) / factor;
}

function normalizeEntry(value: unknown, role: ChatTypographyRole): ChatTypographyEntry {
  const spec = CHAT_TYPOGRAPHY_SPEC[role];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return cloneEntry(spec.default);
  const record = value as Record<string, unknown>;
  const size =
    typeof record.size === 'number' && Number.isFinite(record.size)
      ? alignSize(record.size, spec.min, spec.max, spec.step)
      : spec.default.size;
  const weight = isWeight(record.weight) ? record.weight : spec.default.weight;
  return { size, weight };
}

export function normalizeChatTypography(value: unknown): ChatTypography {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return Object.fromEntries(
      CHAT_TYPOGRAPHY_ROLES.map((role) => [role, cloneEntry(CHAT_TYPOGRAPHY_SPEC[role].default)])
    ) as ChatTypography;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    CHAT_TYPOGRAPHY_ROLES.map((role) => [
      role,
      role in record
        ? normalizeEntry(record[role], role)
        : cloneEntry(CHAT_TYPOGRAPHY_SPEC[role].default),
    ])
  ) as ChatTypography;
}

/** 配置同步只接受已经对齐规格的对象，不在导入时悄悄改字号。 */
export function isStoredChatTypography(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== CHAT_TYPOGRAPHY_ROLES.length) return false;
  const normalized = normalizeChatTypography(value);
  return CHAT_TYPOGRAPHY_ROLES.every((role) => {
    const entry = record[role];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const fields = entry as Record<string, unknown>;
    return (
      Object.keys(fields).length === 2 &&
      fields.size === normalized[role].size &&
      fields.weight === normalized[role].weight
    );
  });
}

function formatCssNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

function roleKebab(role: string): string {
  return role.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

export function chatTypographyCssVars(typography: ChatTypography): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const role of CHAT_TYPOGRAPHY_ROLES) {
    const spec = CHAT_TYPOGRAPHY_SPEC[role];
    const kebab = roleKebab(role);
    const size = typography[role].size;
    vars[`--chat-${kebab}-size`] =
      spec.unit === '%' ? `${formatCssNumber(size / 100)}em` : `${formatCssNumber(size)}px`;
    vars[`--chat-${kebab}-weight`] = String(typography[role].weight);
  }
  return vars;
}
