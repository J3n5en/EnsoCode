import { APPROVAL_MODES, type ApprovalMode } from '../types/agent';
import type { BotList, BotProfile } from '../types/bot';

/** 「自动设置能力」：便宜模型按成员描述推荐能力配置；结果只做建议，由用户逐项确认后写入表单 */

export interface AbilityValues {
  tools: BotProfile['tools'];
  approvalMode: ApprovalMode;
  skillIds: string[];
  mcpServerIds: string[];
  canDelegateTo: BotList;
  acceptFrom: BotList;
}

export type AbilityField = keyof AbilityValues;

export const ABILITY_FIELDS: readonly AbilityField[] = [
  'tools',
  'approvalMode',
  'skillIds',
  'mcpServerIds',
  'canDelegateTo',
  'acceptFrom',
];

export interface AbilityCatalogItem {
  id: string;
  name: string;
  description?: string;
}

export interface AbilitySuggestInput {
  profile: { name: string; title: string; scope: string; persona: string };
  language: 'zh' | 'en';
  skills: AbilityCatalogItem[];
  mcpServers: AbilityCatalogItem[];
  /** 可委派 / 被委派的其他成员（不含自己、已归档） */
  members: Array<AbilityCatalogItem & { title?: string; scope?: string }>;
}

export type AbilitySuggestion = {
  [K in AbilityField]?: { value: AbilityValues[K]; reason: string };
};

export type AbilityChange = {
  [K in AbilityField]: { field: K; from: AbilityValues[K]; to: AbilityValues[K]; reason: string };
}[AbilityField];

const TOOLS = ['all', 'readonly'] as const;
const PERSONA_MAX = 2_000;
const TEXT_MAX = 600;
const REASON_MAX = 300;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;
const escapeTags = (text: string): string => text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
const line = (text: string | undefined, max = TEXT_MAX) =>
  escapeTags(clip((text ?? '').replace(/\s+/g, ' ').trim(), max));

function catalog(tag: string, items: readonly AbilityCatalogItem[]): string[] {
  return [
    `<${tag}>`,
    ...(items.length === 0
      ? ['(none)']
      : items.map((item) => {
          const rest = item as { title?: string; scope?: string };
          const detail = [rest.title, rest.scope, item.description].filter(Boolean).join(' — ');
          return `- id=${item.id} | ${line(item.name, 120)}${detail ? ` | ${line(detail)}` : ''}`;
        })),
    `</${tag}>`,
  ];
}

export function abilitySuggestPrompt(input: AbilitySuggestInput): {
  systemPrompt: string;
  userText: string;
} {
  const delegation = input.members.length > 0;
  const systemPrompt = [
    'You configure the abilities of an AI team member from its description.',
    'Reply with one JSON object only, no prose. Every key is optional; omit a key to keep the current value.',
    'Each key maps to {"value": ..., "reason": "<one short sentence>"}; always include the reason, also for arrays:',
    '- tools: "all" (can edit files and run commands) or "readonly" (only reads and searches).',
    '- approvalMode: "supervised" (approve every command and edit), "auto-edits" (edits run freely, commands ask), "full" (run everything without asking) or "assistant" (a model reviews each action).',
    '- skillIds: array of skill ids from <skills> that clearly help this role; [] if none.',
    '- mcpServerIds: array of MCP server ids from <mcp_servers> that clearly help this role; [] if none.',
    ...(delegation
      ? ['- canDelegateTo / acceptFrom: "any" or an array of member ids from <members>.']
      : []),
    'Example: {"tools":{"value":"readonly","reason":"..."},"skillIds":{"value":["<id>"],"reason":"..."}}',
    'Only use ids that appear in the lists. Prefer the least privilege that still lets the member do its job.',
    `Write every reason in ${input.language === 'zh' ? 'Simplified Chinese' : 'English'}.`,
  ].join('\n');
  const { profile } = input;
  const userText = [
    '<profile>',
    `name: ${line(profile.name, 120)}`,
    `title: ${line(profile.title, 120)}`,
    `responsibilities: ${line(profile.scope)}`,
    `persona: ${line(profile.persona, PERSONA_MAX)}`,
    '</profile>',
    ...catalog('skills', input.skills),
    ...catalog('mcp_servers', input.mcpServers),
    ...(delegation ? catalog('members', input.members) : []),
  ].join('\n');
  return { systemPrompt, userText };
}

function extractObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** id 精确匹配优先，其次名称大小写不敏感；未知项丢弃 */
function resolveIds(raw: unknown, items: readonly AbilityCatalogItem[]): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim().toLowerCase();
    const hit =
      items.find((item) => item.id === entry.trim()) ??
      items.find((item) => item.name.trim().toLowerCase() === key);
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  // 模型点了名却一个都不存在：视为无效建议，而不是「清空」
  return raw.length > 0 && ids.length === 0 ? null : ids;
}

export function parseAbilitySuggestion(
  text: string,
  input: Pick<AbilitySuggestInput, 'skills' | 'mcpServers' | 'members'>
): AbilitySuggestion | null {
  const object = extractObject(text);
  if (!object) return null;
  const result: AbilitySuggestion = {};
  const entry = (key: AbilityField) => {
    const raw = object[key];
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) {
      const reason = (raw as { reason?: unknown }).reason;
      return {
        value: (raw as { value: unknown }).value,
        reason: typeof reason === 'string' ? clip(reason.trim(), REASON_MAX) : '',
      };
    }
    return raw === undefined ? null : { value: raw, reason: '' };
  };

  const tools = entry('tools');
  if (tools && TOOLS.includes(tools.value as (typeof TOOLS)[number]))
    result.tools = { value: tools.value as AbilityValues['tools'], reason: tools.reason };
  const approval = entry('approvalMode');
  if (approval && APPROVAL_MODES.includes(approval.value as ApprovalMode))
    result.approvalMode = { value: approval.value as ApprovalMode, reason: approval.reason };
  for (const [key, items] of [
    ['skillIds', input.skills],
    ['mcpServerIds', input.mcpServers],
  ] as const) {
    const picked = entry(key);
    const ids = picked && resolveIds(picked.value, items);
    if (picked && ids) result[key] = { value: ids, reason: picked.reason };
  }
  // 没有其他成员时不谈委派：建议 [] 会把以后加入的成员也挡在外面
  for (const key of input.members.length > 0 ? (['canDelegateTo', 'acceptFrom'] as const) : []) {
    const picked = entry(key);
    if (!picked) continue;
    const ids = picked.value === 'any' ? 'any' : resolveIds(picked.value, input.members);
    if (ids) result[key] = { value: ids, reason: picked.reason };
  }
  return Object.keys(result).length > 0 ? result : null;
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item) => b.includes(item));
  return a === b;
};

/** 只列出与当前值不同的建议项，按 ABILITY_FIELDS 顺序 */
export function abilityChanges(
  current: AbilityValues,
  suggestion: AbilitySuggestion
): AbilityChange[] {
  return ABILITY_FIELDS.flatMap((field) => {
    const next = suggestion[field];
    if (!next || sameValue(current[field], next.value)) return [];
    return [{ field, from: current[field], to: next.value, reason: next.reason } as AbilityChange];
  });
}

export function applyAbilityChanges(
  current: AbilityValues,
  changes: readonly AbilityChange[],
  fields: readonly AbilityField[]
): AbilityValues {
  const next = { ...current };
  for (const change of changes) {
    if (fields.includes(change.field)) Object.assign(next, { [change.field]: change.to });
  }
  return next;
}
