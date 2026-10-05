import {
  parseTeamFile,
  parseTeamSpec,
  type TeamFileError,
  type TeamMemberAssets,
  type TeamSpec,
} from '@shared/bots/team';
import { isBotId } from '@shared/types/bot';
import type { BotTeamCreateRequest } from '@shared/types/botIpc';

type Rec = Record<string, unknown>;
const record = (value: unknown): Rec | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
const only = (value: Rec, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const ids = (value: unknown): string[] | null =>
  Array.isArray(value) &&
  value.length <= 200 &&
  value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 200)
    ? [...value]
    : null;

function parseAssets(value: unknown, team: TeamSpec): TeamMemberAssets | null {
  const input = record(value);
  if (!input) return null;
  const keys = new Set(team.members.map((member) => member.key));
  const out: Record<string, { skillIds: string[]; mcpServerIds: string[] }> = {};
  for (const [key, raw] of Object.entries(input)) {
    const entry = record(raw);
    if (!keys.has(key) || !entry || !only(entry, ['skillIds', 'mcpServerIds'])) return null;
    const skillIds = ids(entry.skillIds);
    const mcpServerIds = ids(entry.mcpServerIds);
    if (!skillIds || !mcpServerIds) return null;
    out[key] = { skillIds, mcpServerIds };
  }
  return out;
}

export function parseTeamPreviewInput(
  value: unknown
): { ok: true; team: TeamSpec } | { ok: false; error: TeamFileError } {
  const input = record(value);
  if (input && only(input, ['text']) && typeof input.text === 'string') {
    return parseTeamFile(input.text);
  }
  const team = input && only(input, ['team']) ? parseTeamSpec(input.team) : null;
  return team ? { ok: true, team } : { ok: false, error: 'invalid' };
}

export function parseTeamCreateInput(value: unknown): BotTeamCreateRequest | null {
  const input = record(value);
  if (!input) return null;
  const hasAssets = 'assets' in input;
  if (!only(input, hasAssets ? ['team', 'workspace', 'assets'] : ['team', 'workspace']))
    return null;
  const team = parseTeamSpec(input.team);
  const ws = record(input.workspace);
  if (!team || !ws) return null;
  const assets = hasAssets ? parseAssets(input.assets, team) : undefined;
  if (assets === null) return null;
  const extra = assets ? { assets } : {};
  if (ws.kind === 'chat-home' && only(ws, ['kind']))
    return { team, workspace: { kind: 'chat-home' }, ...extra };
  if (ws.kind === 'project' && only(ws, ['kind', 'projectId']) && isBotId(ws.projectId)) {
    return { team, workspace: { kind: 'project', projectId: ws.projectId }, ...extra };
  }
  return null;
}
