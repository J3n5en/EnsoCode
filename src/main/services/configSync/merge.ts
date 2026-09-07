import { randomUUID } from 'node:crypto';

import { isReservedAgentTypeName } from '@shared/builtinAgents';
import type { ConfigSyncSummary } from '@shared/types';
import { BUILTIN_AGENT_TYPES, DEFAULT_PRESET_ID } from '@shared/types';

import type { ConfigSyncBundle } from './types';

type JsonRecord = Record<string, unknown>;
type MergeMode = 'merge' | 'replace';
type Category = ConfigSyncSummary['category'];

interface PlannedEntry {
  source: JsonRecord;
  sourceId: string;
  destinationId: string;
  existing?: JsonRecord;
}

interface CategoryPlan {
  current: JsonRecord[];
  entries: PlannedEntry[];
  idMap: Record<string, string>;
}

const SUMMARY_CATEGORIES: readonly Exclude<Category, 'subagentModels' | 'settings'>[] = [
  'providers',
  'presets',
  'agentTypes',
  'skills',
  'mcpServers',
  'instructions',
];

const SCALAR_SETTING_KEYS = [
  'theme',
  'language',
  'terminalTheme',
  'terminalFontSize',
  'terminalFontFamily',
  'terminalFontWeight',
  'terminalFontWeightBold',
  'favoriteTerminalThemes',
  'statusLineSegments',
  'loadLocalSkills',
  'loadHarnessAssets',
  'exploreFoldEnabled',
  'bashInterceptEnabled',
  'hashlineEditEnabled',
  'openChangesOnFileEdit',
  'compactReadOnlyTools',
  'generationStallTimeoutMin',
  'backgroundRandomInterval',
  'backgroundOpacity',
  'backgroundBlur',
  'backgroundBrightness',
  'backgroundSaturation',
  'backgroundComposerOpacity',
  'backgroundCodeOpacity',
  'backgroundSizeMode',
  'disabledBuiltinTools',
  'keybindings',
  'usageModelPricing',
  'defaultModel',
  'titleSummaryModel',
  'smartCompactModel',
  'approvalReviewer',
  'defaultPresetId',
  'titleSummaryEnabled',
  'smartCompactEnabled',
  'smartCompactMode',
  'defaultReasoningEnabled',
  'defaultThinkingLevel',
  'subagentModelsEnabled',
  'disabledBuiltinAgentTypes',
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord).map((entry) => clone(entry)) : [];
}

function sourceRecords(
  bundle: ConfigSyncBundle,
  key: keyof ConfigSyncBundle['state']
): JsonRecord[] {
  return records(bundle.state[key]);
}

function requiredId(entry: JsonRecord, category: string): string {
  if (typeof entry.id !== 'string' || !entry.id) throw new Error(`Invalid ${category} id`);
  return entry.id;
}

function normalizedName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  return normalized || undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left)
    .filter((key) => left[key] !== undefined)
    .sort();
  const rightKeys = Object.keys(right)
    .filter((key) => right[key] !== undefined)
    .sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameValue(left[key], right[rightKeys[index]])
    )
  );
}

function safeNewId(sourceId: string, used: Set<string>): string {
  if (!used.has(sourceId)) {
    used.add(sourceId);
    return sourceId;
  }
  let next = randomUUID();
  while (used.has(next)) next = randomUUID();
  used.add(next);
  return next;
}

function planCategory(
  current: JsonRecord[],
  incoming: JsonRecord[],
  category: string
): CategoryPlan {
  const byId = new Map<string, JsonRecord[]>();
  const byName = new Map<string, JsonRecord[]>();
  const used = new Set<string>();
  for (const entry of current) {
    if (typeof entry.id === 'string' && entry.id) {
      const matches = byId.get(entry.id) ?? [];
      matches.push(entry);
      byId.set(entry.id, matches);
      used.add(entry.id);
    }
    const name = normalizedName(entry.name);
    if (name) {
      const matches = byName.get(name) ?? [];
      matches.push(entry);
      byName.set(name, matches);
    }
  }

  const entries: PlannedEntry[] = [];
  const idMap = Object.create(null) as Record<string, string>;
  const claimedDestinations = new Set<string>();
  const incomingNames = new Set<string>();
  for (const source of incoming) {
    const sourceName = normalizedName(source.name);
    if (sourceName && incomingNames.has(sourceName)) {
      throw new Error(`Ambiguous imported ${category} name`);
    }
    if (sourceName) incomingNames.add(sourceName);
    const sourceId = requiredId(source, category);
    const exact = byId.get(sourceId) ?? [];
    if (exact.length > 1) throw new Error(`Ambiguous ${category} id`);
    let existing = exact[0];
    if (!existing) {
      const name = normalizedName(source.name);
      const matches = name ? (byName.get(name) ?? []) : [];
      if (matches.length > 1) throw new Error(`Ambiguous ${category} name`);
      existing = matches[0];
    }
    const destinationId = existing ? requiredId(existing, category) : safeNewId(sourceId, used);
    if (claimedDestinations.has(destinationId)) {
      throw new Error(`Ambiguous imported ${category} identity`);
    }
    claimedDestinations.add(destinationId);
    idMap[sourceId] = destinationId;
    entries.push({ source, sourceId, destinationId, existing });
  }
  return { current, entries, idMap };
}

function mappedId(value: unknown, map: Record<string, string>, label: string): string {
  if (typeof value !== 'string' || !Object.hasOwn(map, value) || typeof map[value] !== 'string') {
    throw new Error(`Unknown ${label} reference`);
  }
  return map[value];
}

function mappedIds(value: unknown, map: Record<string, string>, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid ${label} references`);
  return value.map((id) => mappedId(id, map, label));
}

function omissionSet(entry: JsonRecord): Set<string> {
  return new Set(
    Array.isArray(entry.omittedFields)
      ? entry.omittedFields.filter((field): field is string => typeof field === 'string')
      : []
  );
}

function mergeSensitiveField(
  target: JsonRecord,
  source: JsonRecord,
  existing: JsonRecord | undefined,
  field: string,
  omitted: ReadonlySet<string>
): void {
  if ((omitted.has(field) || source[field] === undefined) && existing?.[field] !== undefined) {
    target[field] = clone(existing[field]);
  }
}

function preserveUrlParts(
  imported: unknown,
  local: unknown,
  omitted: ReadonlySet<string>,
  prefix: 'url' | 'baseUrl'
): unknown {
  if (typeof imported !== 'string' || typeof local !== 'string') return imported;
  if (
    !omitted.has(`${prefix}Credentials`) &&
    !omitted.has(`${prefix}Query`) &&
    !omitted.has(`${prefix}Fragment`)
  ) {
    return imported;
  }
  try {
    const next = new URL(imported);
    const existing = new URL(local);
    if (omitted.has(`${prefix}Credentials`)) {
      next.username = existing.username;
      next.password = existing.password;
    }
    if (omitted.has(`${prefix}Query`)) next.search = existing.search;
    if (omitted.has(`${prefix}Fragment`)) next.hash = existing.hash;
    return next.toString();
  } catch {
    return imported;
  }
}

function providerEntry(plan: PlannedEntry, mode: MergeMode): JsonRecord {
  const omitted = omissionSet(plan.source);
  const next: JsonRecord = {
    ...clone(plan.existing ?? {}),
    ...clone(plan.source),
    id: plan.destinationId,
  };
  mergeSensitiveField(next, plan.source, plan.existing, 'apiKey', omitted);
  if (mode === 'merge' && plan.existing) {
    const importedModels = records(plan.source.models);
    const importedIds = new Set(importedModels.map((model) => String(model.id)));
    next.models = [
      ...importedModels,
      ...records(plan.existing.models).filter((model) => !importedIds.has(String(model.id))),
    ];
  }
  // OAuth login state is device-local; imported keys are dropped, matched local keys kept.
  delete next.oauthAccountKey;
  if (plan.existing && plan.existing.oauthAccountKey !== undefined) {
    next.oauthAccountKey = clone(plan.existing.oauthAccountKey);
  }
  if (plan.existing) {
    next.baseUrl = preserveUrlParts(next.baseUrl, plan.existing.baseUrl, omitted, 'baseUrl');
  }
  delete next.omittedFields;
  if (next.api !== 'ollama' && !next.apiKey && !next.oauthAccountKey) {
    next.enabled = false;
  }
  return next;
}

function importedEnvConflicts(
  source: JsonRecord,
  existing: JsonRecord,
  omitted: ReadonlySet<string>
): boolean {
  if (omitted.has('env') || source.env === undefined) return false;
  return !sameValue(existing.env, source.env);
}

function mcpEntry(plan: PlannedEntry): JsonRecord {
  const omitted = omissionSet(plan.source);
  const next: JsonRecord = {
    ...clone(plan.existing ?? {}),
    ...clone(plan.source),
    id: plan.destinationId,
  };
  mergeSensitiveField(next, plan.source, plan.existing, 'args', omitted);
  mergeSensitiveField(next, plan.source, plan.existing, 'env', omitted);
  if (plan.existing) next.url = preserveUrlParts(next.url, plan.existing.url, omitted, 'url');
  delete next.omittedFields;
  if (plan.existing && importedEnvConflicts(plan.source, plan.existing, omitted)) {
    next.env = clone(plan.existing.env);
    next.enabled = false;
  } else if (!plan.existing && omitted.size > 0) {
    next.enabled = false;
  }
  return next;
}

function plainEntry(plan: PlannedEntry): JsonRecord {
  const next: JsonRecord = {
    ...clone(plan.existing ?? {}),
    ...clone(plan.source),
    id: plan.destinationId,
  };
  delete next.omittedFields;
  return next;
}

function outputEntries(
  plan: CategoryPlan,
  mode: MergeMode,
  transform: (entry: PlannedEntry) => JsonRecord
): { values: JsonRecord[]; transformed: Map<string, JsonRecord> } {
  const transformed = new Map(
    plan.entries.map((entry) => [entry.destinationId, transform(entry)] as const)
  );
  if (mode === 'replace') {
    return {
      values: plan.entries.map((entry) => transformed.get(entry.destinationId) as JsonRecord),
      transformed,
    };
  }
  const values = plan.current.map((entry) => {
    const id = typeof entry.id === 'string' ? entry.id : undefined;
    return id && transformed.has(id) ? (transformed.get(id) as JsonRecord) : clone(entry);
  });
  const currentIds = new Set(
    plan.current.map((entry) => entry.id).filter((id): id is string => typeof id === 'string')
  );
  for (const entry of plan.entries) {
    if (!currentIds.has(entry.destinationId)) {
      values.push(transformed.get(entry.destinationId) as JsonRecord);
    }
  }
  return { values, transformed };
}

function summaryFor(
  category: Category,
  plan: CategoryPlan,
  transformed: ReadonlyMap<string, JsonRecord>,
  mode: MergeMode
): ConfigSyncSummary {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const entry of plan.entries) {
    if (!entry.existing) added += 1;
    else if (sameValue(entry.existing, transformed.get(entry.destinationId))) skipped += 1;
    else updated += 1;
  }
  const matched = new Set(
    plan.entries.flatMap((entry) => (entry.existing ? [entry.existing] : []))
  );
  const removed = mode === 'replace' ? plan.current.length - matched.size : 0;
  return { category, added, updated, skipped, ...(removed > 0 ? { removed } : {}) };
}

function assertSafeAgentTypes(entries: JsonRecord[]): void {
  const builtinNames = new Set(BUILTIN_AGENT_TYPES.map((entry) => normalizedName(entry.name)));
  for (const entry of entries) {
    const id = requiredId(entry, 'agent type');
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (
      id.startsWith('builtin:') ||
      isReservedAgentTypeName(name) ||
      builtinNames.has(normalizedName(name))
    ) {
      throw new Error('Reserved built-in agent type cannot be imported');
    }
  }
}

function remapModelRef(value: unknown, providers: Record<string, string>, label: string): unknown {
  if (value === null || value === undefined) return value;
  if (!isRecord(value) || typeof value.modelId !== 'string') throw new Error(`Invalid ${label}`);
  return {
    ...clone(value),
    providerId: mappedId(value.providerId, providers, `${label} provider`),
  };
}

function planSubagentModels(
  current: JsonRecord[],
  incoming: JsonRecord[],
  providerMap: Record<string, string>,
  mode: MergeMode
): { plan: CategoryPlan; output: ReturnType<typeof outputEntries> } {
  const remapped = incoming.map((entry) => ({
    ...entry,
    providerId: mappedId(entry.providerId, providerMap, 'subagent model provider'),
  }));
  const plan = planCategory(current, remapped, 'subagent model');
  return { plan, output: outputEntries(plan, mode, plainEntry) };
}

function normalizedProviderEndpoint(entry: JsonRecord, omitted: ReadonlySet<string>): string {
  if (typeof entry.baseUrl !== 'string') return '';
  try {
    const url = new URL(entry.baseUrl);
    url.username = '';
    url.password = '';
    if (omitted.has('baseUrlQuery')) url.search = '';
    if (omitted.has('baseUrlFragment')) url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return `${String(entry.api)}:${url.toString()}`;
  } catch {
    const value = entry.baseUrl.trim().replace(/\/+$/u, '');
    return `${String(entry.api)}:${omitted.has('baseUrlQuery') ? value.replace(/[?#].*$/u, '') : value}`;
  }
}

function assertProviderMatchesAreSafe(plan: CategoryPlan): void {
  for (const entry of plan.entries) {
    if (!entry.existing) continue;
    const omitted = omissionSet(entry.source);
    if (
      normalizedProviderEndpoint(entry.source, omitted) !==
      normalizedProviderEndpoint(entry.existing, omitted)
    ) {
      throw new Error('Provider identity conflicts with a different API endpoint');
    }
  }
}

function normalizedMcpIdentity(entry: JsonRecord, omitted: ReadonlySet<string>): string {
  const transport = String(entry.transport ?? '');
  const args = omitted.has('args') ? '' : JSON.stringify(entry.args ?? []);
  if (transport === 'stdio') {
    return `${transport}:${String(entry.command ?? '').trim()}:${args}`;
  }
  if (transport !== 'http' && transport !== 'sse') return transport;
  if (typeof entry.url !== 'string') return `${transport}:${args}`;
  try {
    const url = new URL(entry.url);
    url.username = '';
    url.password = '';
    if (omitted.has('urlQuery')) url.search = '';
    if (omitted.has('urlFragment')) url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return `${transport}:${url.toString()}:${args}`;
  } catch {
    const value = entry.url.trim().replace(/\/+$/u, '');
    return `${transport}:${omitted.has('urlQuery') ? value.replace(/[?#].*$/u, '') : value}:${args}`;
  }
}

function assertMcpMatchesAreSafe(plan: CategoryPlan): void {
  for (const entry of plan.entries) {
    if (!entry.existing) continue;
    const omitted = omissionSet(entry.source);
    if (
      normalizedMcpIdentity(entry.source, omitted) !==
      normalizedMcpIdentity(entry.existing, omitted)
    ) {
      throw new Error('MCP execution command, transport, or URL conflicts with the local server');
    }
  }
}

function scalarSummary(
  current: JsonRecord,
  next: JsonRecord,
  bundle: ConfigSyncBundle
): ConfigSyncSummary {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const fields: string[] = [];
  for (const key of SCALAR_SETTING_KEYS) {
    if (!(key in bundle.state) && sameValue(current[key], next[key])) continue;
    if (!(key in current)) {
      added += 1;
      fields.push(key);
    } else if (sameValue(current[key], next[key])) skipped += 1;
    else {
      updated += 1;
      fields.push(key);
    }
  }
  return { category: 'settings', added, updated, skipped, ...(fields.length ? { fields } : {}) };
}

function mcpEnvConflictWarnings(
  plan: CategoryPlan,
  transformed: ReadonlyMap<string, JsonRecord>
): string[] {
  const names: string[] = [];
  for (const entry of plan.entries) {
    if (!entry.existing) continue;
    const omitted = omissionSet(entry.source);
    if (!importedEnvConflicts(entry.source, entry.existing, omitted)) continue;
    const next = transformed.get(entry.destinationId);
    const name = typeof next?.name === 'string' ? next.name : entry.destinationId;
    names.push(name);
  }
  if (names.length === 0) return [];
  return [
    `Imported MCP env differed from the local server (${names.join(', ')}); local env was kept and those servers were disabled.`,
  ];
}

function hostOf(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function previewDisclosureWarnings(
  bundle: ConfigSyncBundle,
  next: JsonRecord,
  current: JsonRecord
): string[] {
  const warnings: string[] = [];
  for (const provider of bundle.state.providers) {
    const host = hostOf(provider.baseUrl);
    warnings.push(
      host
        ? `Provider ${provider.name} (${provider.api} ${host})`
        : `Provider ${provider.name} (${provider.api})`
    );
  }
  for (const server of bundle.state.mcpServers) {
    const target =
      server.transport === 'stdio'
        ? String(server.command ?? '')
        : typeof server.url === 'string'
          ? hostOf(server.url) || server.url
          : '';
    warnings.push(`MCP ${server.name} (${server.transport}${target ? ` ${target}` : ''})`);
  }
  for (const key of [
    'defaultModel',
    'titleSummaryModel',
    'smartCompactModel',
    'approvalReviewer',
  ] as const) {
    const before = current[key];
    const after = next[key];
    if (sameValue(before, after)) continue;
    if (!isRecord(after) || typeof after.modelId !== 'string') continue;
    warnings.push(`${key} now points to ${String(after.providerId)}/${after.modelId}`);
  }
  return warnings;
}

function addWarnings(bundle: ConfigSyncBundle): string[] {
  const warnings: string[] = [];
  const hasProviderOmissions = bundle.state.providers.some(
    (entry) => Array.isArray(entry.omittedFields) && entry.omittedFields.length > 0
  );
  const hasMcpOmissions = bundle.state.mcpServers.some(
    (entry) => Array.isArray(entry.omittedFields) && entry.omittedFields.length > 0
  );
  if (hasProviderOmissions || hasMcpOmissions) {
    warnings.push(
      'Sensitive provider or MCP values were omitted; existing local values were preserved when available.'
    );
  }
  if (
    bundle.state.providers.some(
      (entry) =>
        entry.oauthAccountKey !== undefined ||
        (Array.isArray(entry.omittedFields) && entry.omittedFields.includes('oauthAccountKey'))
    )
  ) {
    warnings.push('OAuth login state is not included; sign in again after import.');
  }
  if (bundle.state.mcpServers.length > 0) {
    warnings.push('Imported MCP servers may require external commands, packages, or paths.');
  }
  return warnings;
}

/** 生成不写磁盘的配置导入计划，并在提交前完成引用重映射。 */
export function planImport(
  current: Record<string, unknown>,
  bundle: ConfigSyncBundle,
  mode: MergeMode
): {
  state: Record<string, unknown>;
  summary: ConfigSyncSummary[];
  warnings: string[];
  skillIdMap: Record<string, string>;
  instructionIdMap: Record<string, string>;
} {
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Unsupported config sync mode');
  const state = clone(current);
  const incoming = {
    providers: sourceRecords(bundle, 'providers'),
    skills: sourceRecords(bundle, 'skills'),
    mcpServers: sourceRecords(bundle, 'mcpServers'),
    instructions: sourceRecords(bundle, 'instructions'),
    presets: sourceRecords(bundle, 'presets'),
    agentTypes: sourceRecords(bundle, 'agentTypes'),
    subagentModels: sourceRecords(bundle, 'subagentModels'),
  };
  if (incoming.presets.some((entry) => entry.id === DEFAULT_PRESET_ID)) {
    throw new Error('Reserved default preset cannot be imported');
  }
  assertSafeAgentTypes(incoming.agentTypes);
  if (incoming.instructions.filter((entry) => entry.enabled === true).length > 1) {
    throw new Error('Multiple enabled imported instructions');
  }

  const currentState = clone(state);
  const plans = {
    providers: planCategory(records(state.providers), incoming.providers, 'provider'),
    skills: planCategory(records(state.skills), incoming.skills, 'skill'),
    mcpServers: planCategory(records(state.mcpServers), incoming.mcpServers, 'MCP server'),
    instructions: planCategory(records(state.instructions), incoming.instructions, 'instruction'),
    presets: planCategory(records(state.presets), incoming.presets, 'preset'),
    agentTypes: planCategory(records(state.agentTypes), incoming.agentTypes, 'agent type'),
  };
  assertProviderMatchesAreSafe(plans.providers);
  assertMcpMatchesAreSafe(plans.mcpServers);

  const providerOutput = outputEntries(plans.providers, mode, (entry) =>
    providerEntry(entry, mode)
  );
  const skillOutput = outputEntries(plans.skills, mode, plainEntry);
  const mcpOutput = outputEntries(plans.mcpServers, mode, mcpEntry);
  const instructionOutput = outputEntries(plans.instructions, mode, plainEntry);

  const presetOutput = outputEntries(plans.presets, mode, (entry) => {
    const next = plainEntry(entry);
    next.skillIds = mappedIds(entry.source.skillIds, plans.skills.idMap, 'preset skill');
    next.mcpServerIds = mappedIds(
      entry.source.mcpServerIds,
      plans.mcpServers.idMap,
      'preset MCP server'
    );
    if (entry.source.instructionId === undefined) delete next.instructionId;
    else {
      next.instructionId = mappedId(
        entry.source.instructionId,
        plans.instructions.idMap,
        'preset instruction'
      );
    }
    return next;
  });

  const agentOutput = outputEntries(plans.agentTypes, mode, (entry) => {
    const next = plainEntry(entry);
    next.skillIds = mappedIds(entry.source.skillIds, plans.skills.idMap, 'agent skill');
    next.mcpServerIds = mappedIds(
      entry.source.mcpServerIds,
      plans.mcpServers.idMap,
      'agent MCP server'
    );
    if (entry.source.providerId !== undefined) {
      next.providerId = mappedId(
        entry.source.providerId,
        plans.providers.idMap,
        'agent model provider'
      );
    }
    return next;
  });

  const enabledInstruction = plans.instructions.entries.find(
    (entry) => entry.source.enabled === true
  );
  if (enabledInstruction) {
    for (const entry of instructionOutput.values) {
      entry.enabled = entry.id === enabledInstruction.destinationId;
    }
  }

  state.providers = providerOutput.values;
  state.skills = skillOutput.values;
  state.mcpServers = mcpOutput.values;
  state.instructions = instructionOutput.values;
  state.presets = presetOutput.values;
  state.agentTypes = agentOutput.values;
  const subagentModelResult = planSubagentModels(
    records(state.subagentModels),
    incoming.subagentModels,
    plans.providers.idMap,
    mode
  );
  state.subagentModels = subagentModelResult.output.values;

  for (const key of [
    'defaultModel',
    'titleSummaryModel',
    'smartCompactModel',
    'approvalReviewer',
  ] as const) {
    if (key in bundle.state) {
      state[key] = remapModelRef(bundle.state[key], plans.providers.idMap, key);
    }
  }
  if (bundle.state.defaultPresetId !== undefined) {
    state.defaultPresetId =
      bundle.state.defaultPresetId === DEFAULT_PRESET_ID
        ? DEFAULT_PRESET_ID
        : mappedId(bundle.state.defaultPresetId, plans.presets.idMap, 'default preset');
  }
  for (const key of [
    'theme',
    'language',
    'terminalTheme',
    'terminalFontSize',
    'terminalFontFamily',
    'terminalFontWeight',
    'terminalFontWeightBold',
    'favoriteTerminalThemes',
    'statusLineSegments',
    'loadLocalSkills',
    'loadHarnessAssets',
    'exploreFoldEnabled',
    'bashInterceptEnabled',
    'hashlineEditEnabled',
    'titleSummaryEnabled',
    'smartCompactEnabled',
    'smartCompactMode',
    'defaultReasoningEnabled',
    'defaultThinkingLevel',
    'subagentModelsEnabled',
    'disabledBuiltinAgentTypes',
    'disabledBuiltinTools',
    'openChangesOnFileEdit',
    'compactReadOnlyTools',
    'generationStallTimeoutMin',
    'backgroundRandomInterval',
    'backgroundOpacity',
    'backgroundBlur',
    'backgroundBrightness',
    'backgroundSaturation',
    'backgroundComposerOpacity',
    'backgroundCodeOpacity',
    'backgroundSizeMode',
    'keybindings',
    'usageModelPricing',
  ] as const) {
    if (key in bundle.state) state[key] = clone(bundle.state[key]);
  }

  const availableModels = new Map(
    records(state.providers).map((provider) => [
      String(provider.id),
      new Set(records(provider.models).map((model) => String(model.id))),
    ])
  );
  for (const key of [
    'defaultModel',
    'titleSummaryModel',
    'smartCompactModel',
    'approvalReviewer',
  ] as const) {
    const ref = state[key];
    if (
      ref !== null &&
      ref !== undefined &&
      (!isRecord(ref) ||
        typeof ref.providerId !== 'string' ||
        typeof ref.modelId !== 'string' ||
        !availableModels.get(ref.providerId)?.has(ref.modelId))
    ) {
      state[key] = null;
    }
  }
  if (
    state.defaultPresetId !== undefined &&
    state.defaultPresetId !== DEFAULT_PRESET_ID &&
    !records(state.presets).some((preset) => preset.id === state.defaultPresetId)
  ) {
    state.defaultPresetId = DEFAULT_PRESET_ID;
  }

  const outputs = {
    providers: providerOutput,
    presets: presetOutput,
    agentTypes: agentOutput,
    skills: skillOutput,
    mcpServers: mcpOutput,
    instructions: instructionOutput,
  };
  const summary = [
    ...SUMMARY_CATEGORIES.map((category) => {
      const row = summaryFor(category, plans[category], outputs[category].transformed, mode);
      if (category !== 'instructions' || !enabledInstruction || mode !== 'merge') return row;
      const matchedIds = new Set(
        plans.instructions.entries.flatMap((entry) =>
          typeof entry.existing?.id === 'string' ? [entry.existing.id] : []
        )
      );
      const disabledUnmatched = records(currentState.instructions).filter(
        (local) =>
          local.enabled === true && typeof local.id === 'string' && !matchedIds.has(local.id)
      ).length;
      if (disabledUnmatched === 0) return row;
      return { ...row, updated: row.updated + disabledUnmatched };
    }),
    summaryFor(
      'subagentModels',
      subagentModelResult.plan,
      subagentModelResult.output.transformed,
      mode
    ),
    scalarSummary(currentState, state, bundle),
  ];
  return {
    state,
    summary,
    warnings: [
      ...addWarnings(bundle),
      ...mcpEnvConflictWarnings(plans.mcpServers, mcpOutput.transformed),
      ...previewDisclosureWarnings(bundle, state, currentState),
    ],
    skillIdMap: plans.skills.idMap,
    instructionIdMap: plans.instructions.idMap,
  };
}
