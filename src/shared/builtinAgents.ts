import { type AgentTypeEntry, BUILTIN_AGENT_TYPES } from './types/assets';

export const ENSO_AGENT_TYPE_KEY = 'agent:enso' as const;
export const ENSO_LOCKED_PROFILE_ID = 'enso-locked-v1' as const;
export const ENSO_SYSTEM_PROMPT_ID = 'enso-system-v1' as const;
export const ENSO_LOCKED_TOOL_IDS = ['enso_capabilities', 'enso_app', 'ask_user'] as const;

export type AgentTypeKey = typeof ENSO_AGENT_TYPE_KEY | `builtin:${string}` | `custom:${string}`;

export interface AgentTypeCandidate {
  typeKey: AgentTypeKey;
  displayName: string;
  description: string;
  source: 'system' | 'builtin' | 'custom';
  locked: boolean;
  canDisable: boolean;
  canEdit: boolean;
}

export interface AgentTypeRegistrySnapshot {
  revision: number;
  candidates: readonly AgentTypeCandidate[];
}

export const ENSO_LOCKED_PROFILE = {
  profileId: ENSO_LOCKED_PROFILE_ID,
  typeKey: ENSO_AGENT_TYPE_KEY,
  agentId: 'enso',
  inheritParentModel: true,
  systemPromptId: ENSO_SYSTEM_PROMPT_ID,
  toolIds: ENSO_LOCKED_TOOL_IDS,
  skillPaths: [] as const,
  mcpServers: [] as const,
} as const;

export type LockedAgentProfile = typeof ENSO_LOCKED_PROFILE;

export interface SessionIdentity {
  sessionId: string;
  generation: string;
}

export interface ChildSessionIdentity extends SessionIdentity {
  parent: SessionIdentity;
  instanceId: string;
  instanceName: string;
  typeKey: AgentTypeKey;
  profileId?: typeof ENSO_LOCKED_PROFILE_ID;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUILTIN_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const RESERVED_AGENT_NAMES: Readonly<Record<string, true>> = {
  enso: true,
  [ENSO_AGENT_TYPE_KEY]: true,
  [ENSO_LOCKED_PROFILE_ID]: true,
  [ENSO_SYSTEM_PROMPT_ID]: true,
};
const RESERVED_AGENT_PREFIXES = ['agent:', 'builtin:', 'custom:', 'builtin-agent:'] as const;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function normalizeAgentTypeName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

/** Settings 与 Main registry 共用；保留名/命名空间一律 fail-closed。 */
export function isReservedAgentTypeName(value: string): boolean {
  const normalized = normalizeAgentTypeName(value);
  return (
    !normalized ||
    Object.hasOwn(RESERVED_AGENT_NAMES, normalized) ||
    RESERVED_AGENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

export function parseAgentTypeKey(value: unknown): AgentTypeKey | null {
  if (value === ENSO_AGENT_TYPE_KEY) return ENSO_AGENT_TYPE_KEY;
  if (typeof value !== 'string') return null;
  if (value.startsWith('builtin:')) {
    const name = value.slice('builtin:'.length);
    return BUILTIN_NAME_PATTERN.test(name) && name !== 'general' && name !== 'enso'
      ? (value as AgentTypeKey)
      : null;
  }
  if (value.startsWith('custom:')) {
    return isUuid(value.slice('custom:'.length)) ? (value as AgentTypeKey) : null;
  }
  return null;
}

export function parseSessionIdentity(value: unknown): SessionIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  if (
    Object.keys(identity).length !== 2 ||
    typeof identity.sessionId !== 'string' ||
    !identity.sessionId ||
    !isUuid(identity.generation)
  ) {
    return null;
  }
  return { sessionId: identity.sessionId, generation: identity.generation };
}

export function parseChildSessionIdentity(value: unknown): ChildSessionIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  const allowed = [
    'sessionId',
    'generation',
    'parent',
    'instanceId',
    'instanceName',
    'typeKey',
    'profileId',
  ];
  if (
    Object.keys(identity).length < 6 ||
    Object.keys(identity).some((key) => !allowed.includes(key))
  ) {
    return null;
  }
  const own = parseSessionIdentity({
    sessionId: identity.sessionId,
    generation: identity.generation,
  });
  const parent = parseSessionIdentity(identity.parent);
  const typeKey = parseAgentTypeKey(identity.typeKey);
  if (
    !own ||
    !parent ||
    !isUuid(identity.instanceId) ||
    typeof identity.instanceName !== 'string' ||
    !identity.instanceName ||
    !typeKey ||
    own.sessionId === parent.sessionId ||
    own.generation === parent.generation ||
    (typeKey === ENSO_AGENT_TYPE_KEY && identity.profileId !== ENSO_LOCKED_PROFILE_ID) ||
    (typeKey !== ENSO_AGENT_TYPE_KEY && identity.profileId !== undefined)
  ) {
    return null;
  }
  return identity as unknown as ChildSessionIdentity;
}

export function isSameSessionIdentity(
  expected: SessionIdentity,
  value: unknown
): value is SessionIdentity {
  const actual = parseSessionIdentity(value);
  return (
    actual !== null &&
    actual.sessionId === expected.sessionId &&
    actual.generation === expected.generation
  );
}

export function isSameChildSessionIdentity(
  expected: ChildSessionIdentity,
  value: unknown
): value is ChildSessionIdentity {
  const actual = parseChildSessionIdentity(value);
  return (
    actual !== null &&
    actual.sessionId === expected.sessionId &&
    actual.generation === expected.generation &&
    actual.parent.sessionId === expected.parent.sessionId &&
    actual.parent.generation === expected.parent.generation &&
    actual.instanceId === expected.instanceId &&
    actual.typeKey === expected.typeKey &&
    actual.profileId === expected.profileId
  );
}

export function parseAgentTypeCandidate(value: unknown): AgentTypeCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const typeKey = parseAgentTypeKey(candidate.typeKey);
  if (
    Object.keys(candidate).length !== 7 ||
    !typeKey ||
    typeof candidate.displayName !== 'string' ||
    !candidate.displayName.trim() ||
    typeof candidate.description !== 'string' ||
    (candidate.source !== 'system' &&
      candidate.source !== 'builtin' &&
      candidate.source !== 'custom') ||
    typeof candidate.locked !== 'boolean' ||
    typeof candidate.canDisable !== 'boolean' ||
    typeof candidate.canEdit !== 'boolean'
  ) {
    return null;
  }
  if (
    typeKey === ENSO_AGENT_TYPE_KEY &&
    (candidate.source !== 'system' ||
      candidate.displayName !== 'Enso' ||
      !candidate.locked ||
      candidate.canDisable ||
      candidate.canEdit)
  ) {
    return null;
  }
  return candidate as unknown as AgentTypeCandidate;
}

export function parseAgentTypeRegistrySnapshot(value: unknown): AgentTypeRegistrySnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (
    Object.keys(snapshot).length !== 2 ||
    !Number.isInteger(snapshot.revision) ||
    (snapshot.revision as number) < 0 ||
    !Array.isArray(snapshot.candidates) ||
    snapshot.candidates.some((candidate) => parseAgentTypeCandidate(candidate) === null)
  ) {
    return null;
  }
  const typeKeys = snapshot.candidates.map(
    (candidate) => (candidate as AgentTypeCandidate).typeKey
  );
  if (new Set(typeKeys).size !== typeKeys.length || typeKeys[0] !== ENSO_AGENT_TYPE_KEY) {
    return null;
  }
  return snapshot as unknown as AgentTypeRegistrySnapshot;
}

export function buildAgentTypeRegistrySnapshot(input: {
  revision: number;
  disabledBuiltinAgentTypes: readonly string[];
  customAgentTypes: readonly AgentTypeEntry[];
}): AgentTypeRegistrySnapshot {
  const disabled = new Set(input.disabledBuiltinAgentTypes);
  const candidates: AgentTypeCandidate[] = [
    {
      typeKey: ENSO_AGENT_TYPE_KEY,
      displayName: 'Enso',
      description: 'EnsoCode system agent for product capabilities and team setup',
      source: 'system',
      locked: true,
      canDisable: false,
      canEdit: false,
    },
  ];
  for (const builtin of BUILTIN_AGENT_TYPES) {
    if (builtin.name === 'general' || builtin.name === 'enso' || disabled.has(builtin.name)) {
      continue;
    }
    candidates.push({
      typeKey: `builtin:${builtin.name}`,
      displayName: builtin.name,
      description: builtin.description,
      source: 'builtin',
      locked: false,
      canDisable: true,
      canEdit: false,
    });
  }
  for (const custom of input.customAgentTypes) {
    if (!isUuid(custom.id) || isReservedAgentTypeName(custom.name)) continue;
    candidates.push({
      typeKey: `custom:${custom.id}`,
      displayName: custom.name.trim(),
      description: custom.description,
      source: 'custom',
      locked: false,
      canDisable: false,
      canEdit: true,
    });
  }
  return { revision: input.revision, candidates };
}
