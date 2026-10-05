import { APPROVAL_MODES, type ApprovalMode } from '../types/agent';
import {
  BOT_NAME_MAX,
  BOT_ROUTING_MODES,
  type BotChat,
  type BotChatRouting,
  type BotId,
  type BotProfile,
  type BotRoutingMode,
  checkBotName,
} from '../types/bot';
import type { BotDraftInput } from '../types/botIpc';

/** 团队 = 群配置 + 成员档案与人设；不含记忆、会话、时间线、看板、例行任务、模型、技能、MCP、项目路径 */
export const TEAM_FILE_FORMAT = 'enso-bot-team';
export const TEAM_FILE_VERSION = 1;
export const TEAM_FILE_MAX_CHARS = 256_000;
export const TEAM_MEMBERS_MAX = 12;

const MAX = { short: 200, scope: 2_000, persona: 20_000 } as const;
const KEY_RE = /^[a-z0-9_-]{1,32}$/iu;
const COLOR_RE = /^#[0-9a-f]{6}$/iu;

/** 成员之间的委派关系用团队内 key 引用 */
export type TeamRefList = 'any' | string[];

export interface TeamMemberSpec {
  key: string;
  name: string;
  title: string;
  scope: string;
  persona: string;
  avatar: { color: string };
  tools: BotProfile['tools'];
  approvalMode: ApprovalMode;
  delegation: { canDelegateTo: TeamRefList; acceptFrom: TeamRefList };
  memory: { enabled: boolean };
}

export interface TeamSpec {
  title: string;
  bossKey: string;
  workspace: 'chat-home' | 'project';
  routing: BotChatRouting;
  members: TeamMemberSpec[];
}

export interface TeamFile {
  format: typeof TEAM_FILE_FORMAT;
  version: typeof TEAM_FILE_VERSION;
  exportedAt?: string;
  team: TeamSpec;
}

export type TeamFileError = 'too-large' | 'invalid-json' | 'unsupported-version' | 'invalid';
export type TeamRename = { key: string; from: string; to: string };
export type TeamMemberDraft = Required<
  Pick<
    BotDraftInput,
    | 'name'
    | 'title'
    | 'scope'
    | 'persona'
    | 'avatar'
    | 'tools'
    | 'approvalMode'
    | 'skillIds'
    | 'mcpServerIds'
    | 'delegation'
    | 'memory'
  >
>;

type Rec = Record<string, unknown>;
const record = (value: unknown): Rec | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
const exactKeys = (value: Rec, required: readonly string[], optional: readonly string[] = []) =>
  required.every((key) => key in value) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
const intIn = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

function refList(value: unknown): TeamRefList | null {
  if (value === 'any') return 'any';
  return Array.isArray(value) &&
    value.length <= TEAM_MEMBERS_MAX &&
    value.every((item) => typeof item === 'string' && KEY_RE.test(item))
    ? [...new Set(value as string[])]
    : null;
}

function parseMember(value: unknown): TeamMemberSpec | null {
  const input = record(value);
  const required = ['key', 'name', 'title', 'scope', 'persona', 'avatar', 'tools'];
  const rest = ['approvalMode', 'delegation', 'memory'];
  if (!input || !exactKeys(input, [...required, ...rest])) return null;
  const avatar = record(input.avatar);
  const delegation = record(input.delegation);
  const memory = record(input.memory);
  if (
    !text(input.key, 32) ||
    !KEY_RE.test(input.key) ||
    !text(input.name, MAX.short) ||
    !text(input.title, MAX.short) ||
    !text(input.scope, MAX.scope) ||
    !text(input.persona, MAX.persona) ||
    !avatar ||
    !exactKeys(avatar, ['color']) ||
    !text(avatar.color, 16) ||
    !COLOR_RE.test(avatar.color) ||
    (input.tools !== 'all' && input.tools !== 'readonly') ||
    !APPROVAL_MODES.includes(input.approvalMode as ApprovalMode) ||
    !delegation ||
    !exactKeys(delegation, ['canDelegateTo', 'acceptFrom']) ||
    !memory ||
    !exactKeys(memory, ['enabled']) ||
    typeof memory.enabled !== 'boolean'
  )
    return null;
  const name = checkBotName(input.name, [], []);
  if (!name.ok && name.reason === 'invalid') return null;
  const canDelegateTo = refList(delegation.canDelegateTo);
  const acceptFrom = refList(delegation.acceptFrom);
  if (!canDelegateTo || !acceptFrom) return null;
  return {
    key: input.key,
    name: input.name.trim().normalize('NFC'),
    title: input.title,
    scope: input.scope,
    persona: input.persona,
    avatar: { color: avatar.color },
    tools: input.tools,
    approvalMode: input.approvalMode as ApprovalMode,
    delegation: { canDelegateTo, acceptFrom },
    memory: { enabled: memory.enabled },
  };
}

/** 严格校验：未知字段、越界、悬空引用一律拒绝 */
export function parseTeamSpec(value: unknown): TeamSpec | null {
  const input = record(value);
  if (!input || !exactKeys(input, ['title', 'bossKey', 'workspace', 'routing', 'members']))
    return null;
  const routing = record(input.routing);
  if (
    !text(input.title, MAX.short) ||
    typeof input.bossKey !== 'string' ||
    (input.workspace !== 'chat-home' && input.workspace !== 'project') ||
    !routing ||
    !exactKeys(routing, ['mode', 'maxHops', 'maxTurnsPerBot']) ||
    !BOT_ROUTING_MODES.includes(routing.mode as BotRoutingMode) ||
    !intIn(routing.maxHops, 1, 20) ||
    !intIn(routing.maxTurnsPerBot, 1, 10) ||
    !Array.isArray(input.members) ||
    input.members.length < 2 ||
    input.members.length > TEAM_MEMBERS_MAX
  )
    return null;
  const members: TeamMemberSpec[] = [];
  for (const item of input.members) {
    const member = parseMember(item);
    if (!member) return null;
    members.push(member);
  }
  const keys = new Set(members.map((member) => member.key));
  if (keys.size !== members.length || !keys.has(input.bossKey)) return null;
  const dangling = (list: TeamRefList) => list !== 'any' && list.some((key) => !keys.has(key));
  if (
    members.some(
      (member) =>
        dangling(member.delegation.canDelegateTo) || dangling(member.delegation.acceptFrom)
    )
  )
    return null;
  return {
    title: input.title,
    bossKey: input.bossKey,
    workspace: input.workspace,
    routing: {
      mode: routing.mode as BotRoutingMode,
      maxHops: routing.maxHops as number,
      maxTurnsPerBot: routing.maxTurnsPerBot as number,
    },
    members,
  };
}

export function parseTeamFile(
  raw: string
): { ok: true; team: TeamSpec } | { ok: false; error: TeamFileError } {
  if (raw.length > TEAM_FILE_MAX_CHARS) return { ok: false, error: 'too-large' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  const input = record(value);
  if (!input || input.format !== TEAM_FILE_FORMAT) return { ok: false, error: 'invalid' };
  if (input.version !== TEAM_FILE_VERSION) return { ok: false, error: 'unsupported-version' };
  if (
    !exactKeys(input, ['format', 'version', 'team'], ['exportedAt']) ||
    (input.exportedAt !== undefined && !text(input.exportedAt, 64))
  )
    return { ok: false, error: 'invalid' };
  const team = parseTeamSpec(input.team);
  return team ? { ok: true, team } : { ok: false, error: 'invalid' };
}

/** 与 taken / 保留名冲突时追加 2、3…，截断原名保证不超长 */
export function uniqueBotName(
  name: string,
  taken: readonly string[],
  reserved: readonly string[]
): string {
  const others = taken.map((item, index) => ({ id: String(index), name: item }));
  if (checkBotName(name, others, reserved).ok) return name;
  const chars = [...name];
  for (let n = 2; ; n += 1) {
    const suffix = String(n);
    const candidate = chars.slice(0, BOT_NAME_MAX - suffix.length).join('') + suffix;
    if (checkBotName(candidate, others, reserved).ok) return candidate;
  }
}

export function assignTeamNames(
  team: TeamSpec,
  existing: readonly Pick<BotProfile, 'id' | 'name'>[],
  reserved: readonly string[]
): { team: TeamSpec; renamed: TeamRename[] } {
  const taken = existing.map((bot) => bot.name);
  const renamed: TeamRename[] = [];
  const members = team.members.map((member) => {
    const name = uniqueBotName(member.name, taken, reserved);
    taken.push(name);
    if (name === member.name) return member;
    renamed.push({ key: member.key, from: member.name, to: name });
    return { ...member, name };
  });
  return { team: { ...team, members }, renamed };
}

/** 只保留 keys 中的成员并清理委派引用；群主必须保留，至少 2 人 */
export function selectTeamMembers(team: TeamSpec, keys: readonly string[]): TeamSpec | null {
  const kept = new Set(keys);
  if (!kept.has(team.bossKey)) return null;
  const members = team.members.filter((member) => kept.has(member.key));
  if (members.length < 2) return null;
  const prune = (list: TeamRefList): TeamRefList =>
    list === 'any' ? 'any' : list.filter((key) => kept.has(key));
  return {
    ...team,
    members: members.map((member) => ({
      ...member,
      delegation: {
        canDelegateTo: prune(member.delegation.canDelegateTo),
        acceptFrom: prune(member.delegation.acceptFrom),
      },
    })),
  };
}

/** 成员 key → bot id；不带模型（跟随默认）、技能、MCP */
/** 建队时按成员 key 选的技能 / MCP（本机 id，不进团队文件） */
export type TeamMemberAssets = Readonly<
  Record<string, { skillIds: string[]; mcpServerIds: string[] }>
>;

export function teamMemberDrafts(
  team: TeamSpec,
  ids: Readonly<Record<string, BotId>>,
  assets: TeamMemberAssets = {}
): { key: string; id: BotId; draft: TeamMemberDraft }[] {
  const map = (list: TeamRefList) => (list === 'any' ? 'any' : list.map((key) => ids[key]));
  return team.members.map((member) => ({
    key: member.key,
    id: ids[member.key],
    draft: {
      name: member.name,
      title: member.title,
      scope: member.scope,
      persona: member.persona,
      avatar: { color: member.avatar.color },
      tools: member.tools,
      approvalMode: member.approvalMode,
      skillIds: [...(assets[member.key]?.skillIds ?? [])],
      mcpServerIds: [...(assets[member.key]?.mcpServerIds ?? [])],
      delegation: {
        canDelegateTo: map(member.delegation.canDelegateTo),
        acceptFrom: map(member.delegation.acceptFrom),
      },
      memory: { enabled: member.memory.enabled },
    },
  }));
}

/** 群 → 团队文件；委派引用到群外成员的条目丢弃 */
export function buildTeamFile(
  chat: BotChat,
  bots: readonly BotProfile[],
  personas: Readonly<Record<BotId, string>>,
  exportedAt: string
): TeamFile {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const members = chat.members.filter((botId) => byId.has(botId));
  const keyOf = new Map(members.map((botId, index) => [botId, `m${index + 1}`]));
  const refs = (list: BotProfile['delegation']['canDelegateTo']): TeamRefList =>
    list === 'any'
      ? 'any'
      : list.flatMap((botId) => {
          const key = keyOf.get(botId);
          return key ? [key] : [];
        });
  return {
    format: TEAM_FILE_FORMAT,
    version: TEAM_FILE_VERSION,
    exportedAt,
    team: {
      title: chat.title,
      bossKey: keyOf.get(chat.bossBotId ?? '') ?? 'm1',
      workspace: chat.workspace.kind === 'project' ? 'project' : 'chat-home',
      routing: {
        mode: chat.routing.mode,
        maxHops: chat.routing.maxHops,
        maxTurnsPerBot: chat.routing.maxTurnsPerBot,
      },
      members: members.map((botId) => {
        const bot = byId.get(botId) as BotProfile;
        return {
          key: keyOf.get(botId) as string,
          name: bot.name,
          title: bot.title.slice(0, MAX.short),
          scope: bot.scope.slice(0, MAX.scope),
          persona: (personas[botId] ?? '').slice(0, MAX.persona),
          avatar: { color: bot.avatar.color },
          tools: bot.tools,
          approvalMode: bot.approvalMode,
          delegation: {
            canDelegateTo: refs(bot.delegation.canDelegateTo),
            acceptFrom: refs(bot.delegation.acceptFrom),
          },
          memory: { enabled: bot.memory.enabled },
        };
      }),
    },
  };
}
