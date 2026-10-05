import { APPROVAL_MODES, type ApprovalMode } from '../types/agent';
import { type BotProfile, checkBotName } from '../types/bot';
import type { BotDraftInput } from '../types/botIpc';
import { parseTeamSpec, TEAM_MEMBERS_MAX, type TeamRefList, type TeamSpec } from './team';

/** 成员 / 团队模板库：内置模板的覆盖与隐藏 + 自定义模板；文本为用户编辑后的单语言 */
export const TEMPLATE_LIBRARY_VERSION = 1;
export const CUSTOM_TEMPLATES_MAX = 100;

const MAX = { short: 200, summary: 500, scope: 2_000, persona: 20_000 } as const;
const BUILTIN_ID_RE = /^[a-z0-9-]{1,40}$/u;
const CUSTOM_ID_RE = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COLOR_RE = /^#[0-9a-f]{6}$/iu;
const ROUTING: TeamSpec['routing'] = { mode: 'smart', maxHops: 6, maxTurnsPerBot: 2 };

export interface MemberTemplateData {
  name: string;
  title: string;
  scope: string;
  summary: string;
  persona: string;
  color: string;
  tools: BotProfile['tools'];
  approvalMode: ApprovalMode;
}

export interface TeamTemplateMemberData {
  key: string;
  name: string;
  title: string;
  scope: string;
  persona: string;
  color: string;
  tools: BotProfile['tools'];
  approvalMode: ApprovalMode;
  canDelegateTo: TeamRefList;
  acceptFrom: TeamRefList;
}

export interface TeamTemplateData {
  title: string;
  summary: string;
  bossKey: string;
  workspace: TeamSpec['workspace'];
  members: TeamTemplateMemberData[];
}

export type CustomTemplate<T> = T & { id: string };

export interface TemplateSection<T> {
  overrides: Record<string, T>;
  hidden: string[];
  custom: CustomTemplate<T>[];
}

export interface BotTemplateLibrary {
  schemaVersion: number;
  members: TemplateSection<MemberTemplateData>;
  teams: TemplateSection<TeamTemplateData>;
}

export interface ResolvedTemplate<T> {
  id: string;
  source: 'builtin' | 'custom';
  modified: boolean;
  hidden: boolean;
  data: T;
}

type Rec = Record<string, unknown>;
const record = (value: unknown): Rec | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
const validName = (name: string) => {
  const result = checkBotName(name, [], []);
  return result.ok || result.reason !== 'invalid';
};

export const isTemplateId = (id: string) => BUILTIN_ID_RE.test(id) || CUSTOM_ID_RE.test(id);
export const isCustomTemplateId = (id: string) => CUSTOM_ID_RE.test(id);

export const emptyTemplateLibrary = (): BotTemplateLibrary => ({
  schemaVersion: TEMPLATE_LIBRARY_VERSION,
  members: { overrides: {}, hidden: [], custom: [] },
  teams: { overrides: {}, hidden: [], custom: [] },
});

export function parseMemberTemplate(value: unknown): MemberTemplateData | null {
  const input = record(value);
  if (
    !input ||
    !text(input.name, MAX.short) ||
    !text(input.title, MAX.short) ||
    !text(input.scope, MAX.scope) ||
    !text(input.summary, MAX.summary) ||
    !text(input.persona, MAX.persona) ||
    !text(input.color, 16) ||
    !COLOR_RE.test(input.color) ||
    (input.tools !== 'all' && input.tools !== 'readonly') ||
    !APPROVAL_MODES.includes(input.approvalMode as ApprovalMode) ||
    !validName(input.name)
  )
    return null;
  return {
    name: input.name.trim().normalize('NFC'),
    title: input.title,
    scope: input.scope,
    summary: input.summary,
    persona: input.persona,
    color: input.color,
    tools: input.tools,
    approvalMode: input.approvalMode as ApprovalMode,
  };
}

export function memberDraftOfTemplate(data: MemberTemplateData): BotDraftInput {
  return {
    name: data.name,
    title: data.title,
    scope: data.scope,
    persona: data.persona,
    avatar: { color: data.color },
    tools: data.tools,
    approvalMode: data.approvalMode,
  };
}

export function teamSpecOfTemplate(data: TeamTemplateData): TeamSpec {
  return {
    title: data.title,
    bossKey: data.bossKey,
    workspace: data.workspace,
    routing: { ...ROUTING },
    members: data.members.map((member) => ({
      key: member.key,
      name: member.name,
      title: member.title,
      scope: member.scope,
      persona: member.persona,
      avatar: { color: member.color },
      tools: member.tools,
      approvalMode: member.approvalMode,
      delegation: { canDelegateTo: member.canDelegateTo, acceptFrom: member.acceptFrom },
      memory: { enabled: true },
    })),
  };
}

/** 团队文件 → 模板：路由与记忆开关不入模板 */
export function teamTemplateFromSpec(spec: TeamSpec, summary = ''): TeamTemplateData {
  return {
    title: spec.title,
    summary,
    bossKey: spec.bossKey,
    workspace: spec.workspace,
    members: spec.members.map((member) => ({
      key: member.key,
      name: member.name,
      title: member.title,
      scope: member.scope,
      persona: member.persona,
      color: member.avatar.color,
      tools: member.tools,
      approvalMode: member.approvalMode,
      canDelegateTo: member.delegation.canDelegateTo,
      acceptFrom: member.delegation.acceptFrom,
    })),
  };
}

/** key 唯一、群主在团队内、委派只引用团队内 key、2–12 人；不查重名 */
export function parseTeamTemplate(value: unknown): TeamTemplateData | null {
  const input = record(value);
  if (!input || !text(input.summary, MAX.summary) || !Array.isArray(input.members)) return null;
  const members = input.members.map(record);
  if (members.some((member) => !member)) return null;
  const spec = parseTeamSpec({
    title: input.title,
    bossKey: input.bossKey,
    workspace: input.workspace,
    routing: { ...ROUTING },
    members: (members as Rec[]).map((member) => ({
      key: member.key,
      name: member.name,
      title: member.title,
      scope: member.scope,
      persona: member.persona,
      avatar: { color: member.color },
      tools: member.tools,
      approvalMode: member.approvalMode,
      delegation: { canDelegateTo: member.canDelegateTo, acceptFrom: member.acceptFrom },
      memory: { enabled: true },
    })),
  });
  return spec?.title.trim() ? teamTemplateFromSpec(spec, input.summary) : null;
}

export function teamTemplateIssue(
  data: TeamTemplateData
): 'title' | 'members' | 'name' | 'invalid' | null {
  if (!data.title.trim()) return 'title';
  if (data.members.length < 2 || data.members.length > TEAM_MEMBERS_MAX) return 'members';
  if (data.members.some((member) => !validName(member.name))) return 'name';
  return parseTeamTemplate(data) ? null : 'invalid';
}

function parseSection<T>(value: unknown, parse: (value: unknown) => T | null): TemplateSection<T> {
  const input = record(value);
  const section: TemplateSection<T> = { overrides: {}, hidden: [], custom: [] };
  if (!input) return section;
  for (const [id, raw] of Object.entries(record(input.overrides) ?? {})) {
    const data = BUILTIN_ID_RE.test(id) ? parse(raw) : null;
    if (data) section.overrides[id] = data;
  }
  if (Array.isArray(input.hidden))
    section.hidden = [
      ...new Set(
        input.hidden.filter((id): id is string => typeof id === 'string' && BUILTIN_ID_RE.test(id))
      ),
    ];
  if (Array.isArray(input.custom))
    for (const raw of input.custom) {
      if (section.custom.length >= CUSTOM_TEMPLATES_MAX) break;
      const id = record(raw)?.id;
      if (typeof id !== 'string' || !CUSTOM_ID_RE.test(id)) continue;
      if (section.custom.some((item) => item.id === id)) continue;
      const data = parse(raw);
      if (data) section.custom.push({ id, ...data });
    }
  return section;
}

/** 坏条目逐个丢弃，不阻断整体 */
export function parseTemplateLibrary(value: unknown): BotTemplateLibrary {
  const input = record(value);
  return {
    schemaVersion: TEMPLATE_LIBRARY_VERSION,
    members: parseSection(input?.members, parseMemberTemplate),
    teams: parseSection(input?.teams, parseTeamTemplate),
  };
}

export function resolveTemplates<T>(
  builtins: readonly { id: string; data: T }[],
  section: TemplateSection<T>
): ResolvedTemplate<T>[] {
  return [
    ...builtins.map(({ id, data }) => {
      const override = Object.hasOwn(section.overrides, id) ? section.overrides[id] : undefined;
      return {
        id,
        source: 'builtin' as const,
        modified: override !== undefined,
        hidden: section.hidden.includes(id),
        data: override ?? data,
      };
    }),
    ...section.custom.map(({ id, ...data }) => ({
      id,
      source: 'custom' as const,
      modified: false,
      hidden: false,
      data: data as T,
    })),
  ];
}

export function saveTemplate<T>(
  section: TemplateSection<T>,
  id: string,
  data: T,
  builtinIds: readonly string[]
): TemplateSection<T> {
  if (builtinIds.includes(id))
    return { ...section, overrides: { ...section.overrides, [id]: data } };
  if (!section.custom.some((item) => item.id === id)) return section;
  return {
    ...section,
    custom: section.custom.map((item) => (item.id === id ? { id, ...data } : item)),
  };
}

export function addCustomTemplate<T>(
  section: TemplateSection<T>,
  data: T,
  uuid: string
): TemplateSection<T> {
  return { ...section, custom: [...section.custom, { id: `custom:${uuid}`, ...data }] };
}

/** 自定义：删除；内置：删除覆盖即恢复默认 */
export function removeTemplate<T>(section: TemplateSection<T>, id: string): TemplateSection<T> {
  const { [id]: _removed, ...overrides } = section.overrides;
  return { ...section, overrides, custom: section.custom.filter((item) => item.id !== id) };
}

export function setTemplateHidden<T>(
  section: TemplateSection<T>,
  id: string,
  hidden: boolean
): TemplateSection<T> {
  const rest = section.hidden.filter((item) => item !== id);
  return { ...section, hidden: hidden ? [...rest, id] : rest };
}
