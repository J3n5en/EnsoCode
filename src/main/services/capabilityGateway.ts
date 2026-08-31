import { randomUUID } from 'node:crypto';
import { isReservedAgentTypeName } from '@shared/builtinAgents';
import {
  CAPABILITY_CATALOG,
  CAPABILITY_HANDLER_CONTRACT,
  type ExecutableCapabilityId,
} from '@shared/capabilities/catalog';
import type {
  AvailabilityRequirement,
  CapabilityAskDecisionAck,
  CapabilityAskHost,
  CapabilityAskRequest,
  CapabilityExecutionEnvelope,
  CapabilityInvocationContext,
  CapabilityInvokeRequest,
  CapabilityReceipt,
  CapabilityResult,
  CapabilitySpec,
  DangerousExecutionState,
  JsonSchema,
  OauthFlowLocator,
  ReceiptLifecycleEvent,
  StartOauthResult,
} from '@shared/capabilities/types';
import { modelUsability } from '@shared/defaultModel';
import { normalizeLocale, translate } from '@shared/i18n';
import {
  type AgentTypeEntry,
  BUILTIN_AGENT_TYPES,
  BUILTIN_TOOLS,
  MODEL_THINKING_LEVEL_OVERRIDES,
  type ModelProvider,
  type Preset,
} from '@shared/types';
import type { ModelMetaResult } from '@shared/types/modelMeta';
import type {
  OauthAccountUsage,
  OauthLoginEvent,
  OauthProviderInfo,
} from '@shared/types/oauthProviders';
import type { RecentProject } from '@shared/types/project';
import type { ListModelsResult, TestProviderResult } from '@shared/types/providerApi';
import type { TeamExecutionGuard } from './agentDispatchService';
import type { AgentSessionIndex } from './agentSessionIndex';
import { createSecretSet, type SecretSet } from './secretRedactor';

export type CapabilityResponseResult = CapabilityAskDecisionAck;

export interface CapabilityGatewayTransport {
  hasWindow(webContentsId: number): boolean;
  sendAsk(webContentsId: number, request: CapabilityAskRequest): void;
  appendChildReceipt(
    identity: { sessionId: string; generation: string },
    receipt: CapabilityReceipt
  ): Promise<boolean>;
  observeReceipt(event: ReceiptLifecycleEvent): void;
}

interface SettingsPatchResult {
  ok: boolean;
  previous?: unknown;
  value?: unknown;
  error?: string;
}

interface InstructionReadResult {
  ok: boolean;
  content: string;
  error?: string;
}

export interface CapabilityDomainServices {
  readSettings(): Record<string, unknown> | null;
  patchSettings(field: string, value: unknown, ownerWebContentsId?: number): SettingsPatchResult;
  removeProject(projectId: string, ownerWebContentsId?: number): SettingsPatchResult;
  listModels(config: {
    api: ModelProvider['api'];
    apiKey: string;
    baseUrl: string;
  }): Promise<ListModelsResult>;
  testProvider(
    config: { api: ModelProvider['api']; apiKey: string; baseUrl: string },
    modelId?: string
  ): Promise<TestProviderResult>;
  queryModelMeta(query: { oauthAccountKey?: string; modelIds: string[] }): Promise<ModelMetaResult>;
  listOauthProviders(): Promise<OauthProviderInfo[]>;
  readOauthCredentialKeys(): Promise<ReadonlySet<string>>;
  readSecretValues(): Promise<readonly string[]>;
  beginOauthLogin(
    providerId: string,
    locator: OauthFlowLocator,
    signal: AbortSignal
  ): {
    start: StartOauthResult;
    completion?: Promise<OauthLoginEvent>;
  };
  oauthLogout(accountKey: string, ownerWebContentsId?: number): Promise<void>;
  getOauthAccountUsage(accountKey: string): Promise<OauthAccountUsage>;
  cancelOauthLogin(locator: OauthFlowLocator): boolean;
  reopenOauthLogin(locator: OauthFlowLocator): boolean;
  readInstruction(id: string, local: boolean, sourcePath?: string): InstructionReadResult;
  writeInstruction(id: string, content: string): { ok: boolean; bytes: number };
  deleteInstruction(id: string): void;
  getRecentProjects(): Promise<RecentProject[]>;
  updaterAvailable(): boolean;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  sessionIndex: AgentSessionIndex;
  hireCoworker(
    parentConversationId: string,
    name: string,
    agentType?: string,
    guard?: TeamExecutionGuard
  ): Promise<CapabilityResult>;
  dismissCoworker(
    parentConversationId: string,
    coworkerId: string,
    guard?: TeamExecutionGuard
  ): Promise<CapabilityResult>;
}

/**
 * 把 handler 的取消上下文折成 dispatch service 认的 guard。
 *
 * hire/dismiss 是有外溢的不可逆动作，且跨 reserve/spawn/ready/handshake 多个异步边界。
 * 只在入口处检一次 assertExecutionCurrent 不够——用户批准后关窗/结束 parent/终止
 * generation 都发生在那之后，而外部动作可能已经跑了。
 */
function teamGuardOf(context: CapabilityHandlerContext): TeamExecutionGuard {
  return {
    signal: context.signal,
    assertExecutionCurrent: () => context.assertExecutionCurrent() === null,
  };
}

interface CapabilityHandlerContext extends CapabilityInvocationContext {
  capabilityId: ExecutableCapabilityId;
  requestId: string;
  signal: AbortSignal;
  assertExecutionCurrent(): CapabilityResult | null;
  setOauthFlow(locator: OauthFlowLocator): void;
  getOauthFlow(): OauthFlowLocator | undefined;
}

type CapabilityHandler = (
  context: CapabilityHandlerContext,
  params: Record<string, unknown>
) => Promise<CapabilityResult> | CapabilityResult;

interface ReceiptReservation {
  receiptId: string;
  receiptSeq: number;
  started: boolean;
}

interface PendingAsk {
  context: CapabilityHandlerContext;
  spec: CapabilitySpec;
  params: Record<string, unknown>;
  summary: string;
  host?: CapabilityAskHost;
  controller: AbortController;
  reservation: ReceiptReservation;
  execute: () => Promise<CapabilityExecutionEnvelope>;
  resolve: (envelope: CapabilityExecutionEnvelope) => void;
  state: DangerousExecutionState;
  decided: boolean;
}

const REDACTED_KEYS =
  /api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|secret|password|env/i;

function resultSettingField(capabilityId: string): string | null {
  const fields: Record<string, string> = {
    'general.language': 'language',
    'general.load-local-skills': 'loadLocalSkills',
    'general.automatic-updates': 'autoUpdate',
    'general.keybindings.set': 'keybindings',
    'general.keybindings.reset': 'keybindings',
    'appearance.theme': 'theme',
    'appearance.terminal-theme': 'terminalTheme',
    'appearance.terminal-font-size': 'terminalFontSize',
    'appearance.terminal-font-family': 'terminalFontFamily',
    'appearance.terminal-font-weight': 'terminalFontWeight',
    'appearance.terminal-bold-weight': 'terminalFontWeightBold',
    'appearance.favorite-terminal-themes': 'favoriteTerminalThemes',
    'appearance.status-line-segments': 'statusLineSegments',
    'providers.default-model': 'defaultModel',
    'providers.subagent-models.toggle': 'subagentModelsEnabled',
    'providers.subagent-models.add': 'subagentModels',
    'providers.subagent-models.update': 'subagentModels',
    'providers.subagent-models.remove': 'subagentModels',
    'tools.toggle-builtin': 'disabledBuiltinTools',
    'agent-types.toggle-builtin': 'disabledBuiltinAgentTypes',
  };
  return fields[capabilityId] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function settingsState(settings: Record<string, unknown> | null): Record<string, unknown> {
  const persisted = asRecord(settings?.['enso-settings']);
  return asRecord(persisted?.state) ?? {};
}

function providersOf(services: CapabilityDomainServices): ModelProvider[] {
  const providers = settingsState(services.readSettings()).providers;
  return Array.isArray(providers)
    ? providers.filter(
        (provider): provider is ModelProvider =>
          Boolean(provider) &&
          typeof provider === 'object' &&
          typeof (provider as ModelProvider).id === 'string'
      )
    : [];
}

function providerConfig(provider: ModelProvider) {
  return { api: provider.api, apiKey: provider.apiKey, baseUrl: provider.baseUrl };
}

function success(data: unknown): CapabilityResult {
  return { ok: true, data };
}

function invalid(error: string): CapabilityResult {
  return { ok: false, code: 'invalid', error };
}

function failed(error: string): CapabilityResult {
  return { ok: false, code: 'failed', error };
}

function unavailable(error: string, suggestedAction?: string): CapabilityResult {
  return {
    ok: false,
    code: 'unavailable',
    error,
    ...(suggestedAction ? { suggestedAction } : {}),
  };
}

function cancelled(error: string): CapabilityResult {
  return { ok: false, code: 'cancelled', error };
}

function requiredString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * agent-types.list 对模型只暴露 typeKey（custom:<id>），不暴露内部条目 id，而 custom 类型的
 * inputSchema 只写 `id: string` 也给不出提示——模型因此无从获得合法 id，edit/delete 等于不可用。
 * （builtin 类型不受影响：其 schema 带 enum，已向模型声明合法取值。）
 * 两种形式都收：前缀形式还原成内部 id，裸 id 原样透传。
 */
function customAgentTypeId(value: string): string {
  return value.startsWith('custom:') ? value.slice('custom:'.length) : value;
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/(bearer\s+|sk-[a-z0-9_-]*|token[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}

function sanitizeForRenderer(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForRenderer);
  const object = asRecord(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => !REDACTED_KEYS.test(key))
      .map(([key, entry]) => [key, sanitizeForRenderer(entry)])
  );
}

function validateJsonSchema(value: unknown, schema: JsonSchema, path = '$'): string | null {
  if (schema.enum && !schema.enum.some((entry) => Object.is(entry, value))) {
    return `${path} must be one of the declared enum values`;
  }
  if (!schema.type) return null;
  if (schema.type === 'null') return value === null ? null : `${path} must be null`;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (!schema.items) return null;
    for (let index = 0; index < value.length; index += 1) {
      const error = validateJsonSchema(value[index], schema.items, `${path}[${index}]`);
      if (error) return error;
    }
    return null;
  }
  if (schema.type === 'object') {
    const object = asRecord(value);
    if (!object) return `${path} must be an object`;
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(object, required)) return `${path}.${required} is required`;
    }
    for (const [key, dependents] of Object.entries(schema.dependentRequired ?? {})) {
      if (!Object.hasOwn(object, key)) continue;
      for (const dependent of dependents) {
        if (!Object.hasOwn(object, dependent)) {
          return `${path}.${dependent} is required when ${path}.${key} is present`;
        }
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!Object.hasOwn(properties, key)) return `${path}.${key} is not allowed`;
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(object, key)) continue;
      const error = validateJsonSchema(object[key], propertySchema, `${path}.${key}`);
      if (error) return error;
    }
    return null;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be a string`;
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${path} must contain at least ${schema.minLength} characters`;
    }
    return null;
  }
  if (schema.type === 'boolean')
    return typeof value === 'boolean' ? null : `${path} must be a boolean`;
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number`;
    if (schema.type === 'integer' && !Number.isInteger(value)) return `${path} must be an integer`;
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${path} must be at least ${schema.minimum}`;
    }
    return null;
  }
  return `${path} has an unsupported schema type`;
}

function patchResult(result: SettingsPatchResult, field: string): CapabilityResult {
  return result.ok
    ? success({
        field,
        previous: sanitizeForRenderer(result.previous),
        value: sanitizeForRenderer(result.value),
      })
    : failed(result.error ?? `Failed to update ${field}`);
}

function updateArrayById(
  services: CapabilityDomainServices,
  field: string,
  id: string,
  mutate: (entry: Record<string, unknown>) => Record<string, unknown> | null,
  ownerWebContentsId?: number
): CapabilityResult {
  const current = settingsState(services.readSettings())[field];
  if (!Array.isArray(current)) return unavailable(`${field} is not configured.`);
  let found = false;
  const next = current.flatMap((raw) => {
    const entry = asRecord(raw);
    if (!entry || entry.id !== id) return [raw];
    found = true;
    const changed = mutate(entry);
    return changed ? [changed] : [];
  });
  if (!found) return unavailable(`${field} entry not found: ${id}`);
  return patchResult(services.patchSettings(field, next, ownerWebContentsId), field);
}

function settingValueHandler(
  services: CapabilityDomainServices,
  field: string,
  isValid: (value: unknown) => boolean
): CapabilityHandler {
  return (context, params) => {
    if (!isValid(params.value)) return invalid(`Invalid value for ${field}`);
    return patchResult(
      services.patchSettings(field, params.value, context.ownerWebContentsId),
      field
    );
  };
}

function registeredIds(state: Record<string, unknown>, field: string): Set<string> {
  const entries = state[field];
  return new Set(
    Array.isArray(entries)
      ? entries.flatMap((raw) => {
          const entry = asRecord(raw);
          return typeof entry?.id === 'string' && entry.id.length > 0 ? [entry.id] : [];
        })
      : []
  );
}

function stringIds(value: unknown, field: string): string[] | CapabilityResult {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0)) {
    return invalid(`${field} must be an array of ids`);
  }
  return value as string[];
}

function unknownReferences(ids: string[], registered: Set<string>): string[] {
  return ids.filter((id) => !registered.has(id));
}

function referencedIds(
  params: Record<string, unknown>,
  state: Record<string, unknown>
): CapabilityResult | null {
  const skillIds = stringIds(params.skillIds, 'skillIds');
  if (!Array.isArray(skillIds)) return skillIds;
  const mcpServerIds = stringIds(params.mcpServerIds, 'mcpServerIds');
  if (!Array.isArray(mcpServerIds)) return mcpServerIds;
  const unknownSkills = unknownReferences(skillIds, registeredIds(state, 'skills'));
  if (unknownSkills.length > 0) return invalid(`Unknown skill ids: ${unknownSkills.join(', ')}`);
  const unknownMcp = unknownReferences(mcpServerIds, registeredIds(state, 'mcpServers'));
  if (unknownMcp.length > 0) return invalid(`Unknown MCP ids: ${unknownMcp.join(', ')}`);
  if (params.instructionId !== undefined) {
    if (typeof params.instructionId !== 'string' || params.instructionId.length === 0) {
      return invalid('instructionId must be a non-empty string');
    }
    if (!registeredIds(state, 'instructions').has(params.instructionId)) {
      return invalid(`Unknown instruction id: ${params.instructionId}`);
    }
  }
  if (params.providerId !== undefined || params.modelId !== undefined) {
    const providers = Array.isArray(state.providers) ? state.providers : [];
    const provider = providers.map(asRecord).find((entry) => entry?.id === params.providerId);
    const models = Array.isArray(provider?.models) ? provider.models : [];
    if (!models.some((model) => asRecord(model)?.id === params.modelId)) {
      return invalid('Unknown provider or model id');
    }
  }
  return null;
}

/**
 * subagent-models 条目字段解析：providerId/modelId 必须指向已配置且启用的模型行；
 * reasoning/thinkingLevel 的 'follow' 表示清除覆盖（存储层不落 'follow'）；
 * 推理非 'on' 时档位无意义，一律丢弃，与设置页交互保持一致。
 */
function parseSubagentModelFields(
  params: Record<string, unknown>,
  services: CapabilityDomainServices,
  existing?: Record<string, unknown>
): { value: Record<string, unknown> } | CapabilityResult {
  const providerId =
    requiredString(params, 'providerId') ??
    (typeof existing?.providerId === 'string' ? existing.providerId : null);
  const modelId =
    requiredString(params, 'modelId') ??
    (typeof existing?.modelId === 'string' ? existing.modelId : null);
  if (!providerId || !modelId) return invalid('providerId and modelId are required');
  const provider = providersOf(services).find((entry) => entry.id === providerId);
  if (!provider || provider.enabled === false) {
    return unavailable(`provider not available: ${providerId}`);
  }
  const model = Array.isArray(provider.models)
    ? provider.models.find((entry) => asRecord(entry)?.id === modelId)
    : undefined;
  if (!model || model.enabled === false) return unavailable(`model not available: ${modelId}`);
  const description =
    typeof params.description === 'string'
      ? params.description
      : typeof existing?.description === 'string'
        ? existing.description
        : '';
  const reasoning =
    params.reasoning === 'follow'
      ? undefined
      : params.reasoning === 'on' || params.reasoning === 'off'
        ? params.reasoning
        : existing?.reasoning === 'on' || existing?.reasoning === 'off'
          ? existing.reasoning
          : undefined;
  const levelInput =
    params.thinkingLevel === 'follow'
      ? undefined
      : typeof params.thinkingLevel === 'string' &&
          (MODEL_THINKING_LEVEL_OVERRIDES as readonly string[]).includes(params.thinkingLevel)
        ? params.thinkingLevel
        : typeof existing?.thinkingLevel === 'string' &&
            (MODEL_THINKING_LEVEL_OVERRIDES as readonly string[]).includes(existing.thinkingLevel)
          ? existing.thinkingLevel
          : undefined;
  const thinkingLevel = reasoning === 'on' ? levelInput : undefined;
  return {
    value: {
      providerId,
      modelId,
      description,
      ...(reasoning ? { reasoning } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    },
  };
}

function parsePresetFields(
  params: Record<string, unknown>,
  state: Record<string, unknown>,
  existing?: Record<string, unknown>
): { ok: true; value: Omit<Preset, 'id'> } | CapabilityResult {
  const name =
    requiredString(params, 'name') ?? (typeof existing?.name === 'string' ? existing.name : null);
  if (!name) return invalid('name is required');
  const refs = referencedIds(params, state);
  if (refs) return refs;
  const skillIds = stringIds(params.skillIds ?? existing?.skillIds, 'skillIds');
  if (!Array.isArray(skillIds)) return skillIds;
  const mcpServerIds = stringIds(params.mcpServerIds ?? existing?.mcpServerIds, 'mcpServerIds');
  if (!Array.isArray(mcpServerIds)) return mcpServerIds;
  const instructionId =
    typeof params.instructionId === 'string'
      ? params.instructionId
      : typeof existing?.instructionId === 'string'
        ? existing.instructionId
        : undefined;
  return {
    ok: true,
    value: {
      name,
      skillIds,
      mcpServerIds,
      ...(instructionId ? { instructionId } : {}),
    },
  };
}

function parseAgentTypeFields(
  params: Record<string, unknown>,
  state: Record<string, unknown>,
  existing?: Record<string, unknown>
): { ok: true; value: Omit<AgentTypeEntry, 'id'> } | CapabilityResult {
  const name =
    requiredString(params, 'name') ?? (typeof existing?.name === 'string' ? existing.name : null);
  if (!name) return invalid('name is required');
  if (isReservedAgentTypeName(name)) return invalid(`Reserved agent type name: ${name}`);
  const refs = referencedIds(params, state);
  if (refs) return refs;
  const skillIds = stringIds(params.skillIds ?? existing?.skillIds, 'skillIds');
  if (!Array.isArray(skillIds)) return skillIds;
  const mcpServerIds = stringIds(params.mcpServerIds ?? existing?.mcpServerIds, 'mcpServerIds');
  if (!Array.isArray(mcpServerIds)) return mcpServerIds;
  const tools =
    params.tools === 'all' || params.tools === 'readonly'
      ? params.tools
      : existing?.tools === 'all' || existing?.tools === 'readonly'
        ? existing.tools
        : 'readonly';
  const providerId =
    typeof params.providerId === 'string'
      ? params.providerId
      : typeof existing?.providerId === 'string'
        ? existing.providerId
        : undefined;
  const modelId =
    typeof params.modelId === 'string'
      ? params.modelId
      : typeof existing?.modelId === 'string'
        ? existing.modelId
        : undefined;
  return {
    ok: true,
    value: {
      name,
      description:
        typeof params.description === 'string'
          ? params.description
          : typeof existing?.description === 'string'
            ? existing.description
            : '',
      systemPrompt:
        typeof params.systemPrompt === 'string'
          ? params.systemPrompt
          : typeof existing?.systemPrompt === 'string'
            ? existing.systemPrompt
            : '',
      tools,
      ...(providerId && modelId ? { providerId, modelId } : {}),
      ...(skillIds.length > 0 ? { skillIds } : {}),
      ...(mcpServerIds.length > 0 ? { mcpServerIds } : {}),
    },
  };
}

const DEFAULT_KEYBINDINGS: Record<string, string> = {
  'toggle-sidebar': 'mod+b',
  'open-settings': 'mod+,',
  'new-conversation': 'mod+n',
  'next-tab': process.platform === 'darwin' ? 'ctrl+tab' : 'mod+tab',
  'prev-tab': process.platform === 'darwin' ? 'ctrl+shift+tab' : 'mod+shift+tab',
};

export function createCapabilityHandlers(
  services: CapabilityDomainServices
): Record<ExecutableCapabilityId, CapabilityHandler> {
  const booleanValue = (value: unknown) => typeof value === 'boolean';
  const stringValue = (value: unknown) => typeof value === 'string';
  const stringArrayValue = (value: unknown) =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  const providerById = (providerId: string) =>
    providersOf(services).find((provider) => provider.id === providerId);

  const handlers = {
    'general.language': settingValueHandler(services, 'language', stringValue),
    'general.load-local-skills': settingValueHandler(services, 'loadLocalSkills', booleanValue),
    'general.automatic-updates': settingValueHandler(services, 'autoUpdate', booleanValue),
    'general.keybindings.list': () => {
      const overrides = asRecord(settingsState(services.readSettings()).keybindings) ?? {};
      const sanitized = Object.fromEntries(
        Object.entries(overrides).filter(
          ([action, binding]) => typeof action === 'string' && typeof binding === 'string'
        )
      );
      return success({ ...DEFAULT_KEYBINDINGS, ...sanitized });
    },
    'general.keybindings.set': (context, params) => {
      const action = requiredString(params, 'action');
      const binding = requiredString(params, 'binding');
      if (!action || !binding) return invalid('action and binding are required');
      const current = asRecord(settingsState(services.readSettings()).keybindings) ?? {};
      return patchResult(
        services.patchSettings(
          'keybindings',
          { ...current, [action]: binding },
          context.ownerWebContentsId
        ),
        'keybindings'
      );
    },
    'general.keybindings.reset': (context, params) => {
      const action = requiredString(params, 'action');
      if (!action) return invalid('action is required');
      const current = asRecord(settingsState(services.readSettings()).keybindings) ?? {};
      const next = { ...current };
      delete next[action];
      return patchResult(
        services.patchSettings('keybindings', next, context.ownerWebContentsId),
        'keybindings'
      );
    },
    'appearance.theme': settingValueHandler(services, 'theme', stringValue),
    'appearance.terminal-theme': settingValueHandler(services, 'terminalTheme', stringValue),
    'appearance.terminal-font-size': settingValueHandler(
      services,
      'terminalFontSize',
      (value) => typeof value === 'number' && Number.isFinite(value) && value > 0
    ),
    'appearance.terminal-font-family': settingValueHandler(
      services,
      'terminalFontFamily',
      stringValue
    ),
    'appearance.terminal-font-weight': settingValueHandler(
      services,
      'terminalFontWeight',
      stringValue
    ),
    'appearance.terminal-bold-weight': settingValueHandler(
      services,
      'terminalFontWeightBold',
      stringValue
    ),
    'appearance.favorite-terminal-themes': settingValueHandler(
      services,
      'favoriteTerminalThemes',
      stringArrayValue
    ),
    'appearance.status-line-segments': settingValueHandler(
      services,
      'statusLineSegments',
      stringArrayValue
    ),
    'providers.list': () =>
      success(
        providersOf(services).map(
          ({ id, name, api, baseUrl, enabled, models, importedFrom, oauthAccountKey }) => ({
            id,
            name,
            api,
            baseUrl,
            enabled,
            models,
            ...(importedFrom ? { importedFrom } : {}),
            ...(oauthAccountKey ? { oauthAccountKey } : {}),
          })
        )
      ),
    'providers.remove': async (context, params) => {
      const id = requiredString(params, 'id');
      if (!id) return invalid('id is required');
      const provider = providerById(id);
      if (!provider) return unavailable(`Provider not found: ${id}`);
      const stale = context.assertExecutionCurrent();
      if (stale) return stale;
      try {
        if (provider.oauthAccountKey) {
          await services.oauthLogout(provider.oauthAccountKey, context.ownerWebContentsId);
          const staleAfterLogout = context.assertExecutionCurrent();
          if (staleAfterLogout) return staleAfterLogout;
        }
      } catch (error) {
        return failed(safeError(error));
      }
      return updateArrayById(services, 'providers', id, () => null, context.ownerWebContentsId);
    },
    'providers.fetch-models': async (_context, params) => {
      const providerId = requiredString(params, 'providerId');
      if (!providerId) return invalid('providerId is required');
      const provider = providerById(providerId);
      if (!provider) return unavailable(`Provider not found: ${providerId}`);
      const result = await services.listModels(providerConfig(provider));
      // capability 契约保持 string id 数组；元数据只供设置 UI 落地，不对 agent 工具暴露
      return result.ok
        ? success({ models: result.models.map((model) => model.id) })
        : failed(result.error ?? 'Model fetch failed');
    },
    'providers.test-connection': async (_context, params) => {
      const providerId = requiredString(params, 'providerId');
      const modelId = requiredString(params, 'modelId');
      if (!providerId || !modelId) return invalid('providerId and modelId are required');
      const provider = providerById(providerId);
      if (!provider) return unavailable(`Provider not found: ${providerId}`);
      const result = await services.testProvider(providerConfig(provider), modelId);
      return result.ok
        ? success({ latencyMs: result.latencyMs, message: result.message })
        : failed(result.message);
    },
    'providers.model-meta': async (_context, params) => {
      const providerId = requiredString(params, 'providerId');
      const modelId = requiredString(params, 'modelId');
      if (!providerId || !modelId) return invalid('providerId and modelId are required');
      const provider = providerById(providerId);
      if (!provider) return unavailable(`Provider not found: ${providerId}`);
      const result = await services.queryModelMeta({
        ...(provider.oauthAccountKey ? { oauthAccountKey: provider.oauthAccountKey } : {}),
        modelIds: [modelId],
      });
      return result.ok
        ? success({ models: result.models })
        : failed(result.error ?? 'Metadata lookup failed');
    },
    'providers.toggle-provider': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id || typeof params.enabled !== 'boolean') return invalid('id and enabled are required');
      return updateArrayById(
        services,
        'providers',
        id,
        (entry) => ({ ...entry, enabled: params.enabled }),
        context.ownerWebContentsId
      );
    },
    'providers.toggle-model': (context, params) => {
      const providerId = requiredString(params, 'providerId');
      const modelId = requiredString(params, 'modelId');
      if (!providerId || !modelId || typeof params.enabled !== 'boolean') {
        return invalid('providerId, modelId, and enabled are required');
      }
      return updateArrayById(
        services,
        'providers',
        providerId,
        (entry) => {
          if (!Array.isArray(entry.models)) return entry;
          const models = entry.models.map((model) => {
            const item = asRecord(model);
            return item?.id === modelId ? { ...item, enabled: params.enabled } : model;
          });
          return { ...entry, models };
        },
        context.ownerWebContentsId
      );
    },
    'providers.default-model': async (context, params) => {
      const providerId = requiredString(params, 'providerId');
      const modelId = requiredString(params, 'modelId');
      if (!providerId || !modelId) return invalid('Choose a configured provider and model');
      const providers = providersOf(services);
      let authenticatedAccountKeys: ReadonlySet<string>;
      try {
        authenticatedAccountKeys = await services.readOauthCredentialKeys();
      } catch (error) {
        return unavailable(`OAuth credentials unavailable: ${safeError(error)}`);
      }
      const selection = { providerId, modelId };
      const usability = modelUsability(selection, providers, {
        oauthCredentials: { status: 'ready', authenticatedAccountKeys },
      });
      if (usability !== 'usable') return unavailable(`Default model is not usable: ${usability}`);
      const stale = context.assertExecutionCurrent();
      if (stale) return stale;
      return patchResult(
        services.patchSettings('defaultModel', selection, context.ownerWebContentsId),
        'defaultModel'
      );
    },
    'providers.subagent-models': () => {
      const state = settingsState(services.readSettings());
      return success({
        enabled: state.subagentModelsEnabled === true,
        entries: Array.isArray(state.subagentModels) ? state.subagentModels : [],
      });
    },
    'providers.subagent-models.toggle': (context, params) => {
      if (typeof params.value !== 'boolean') return invalid('value must be a boolean');
      return patchResult(
        services.patchSettings('subagentModelsEnabled', params.value, context.ownerWebContentsId),
        'subagentModelsEnabled'
      );
    },
    'providers.subagent-models.add': (context, params) => {
      const parsed = parseSubagentModelFields(params, services);
      if (!('value' in parsed)) return parsed;
      const current = settingsState(services.readSettings()).subagentModels;
      const entry = { id: randomUUID(), ...parsed.value };
      const stale = context.assertExecutionCurrent();
      if (stale) return stale;
      return patchResult(
        services.patchSettings(
          'subagentModels',
          [...(Array.isArray(current) ? current : []), entry],
          context.ownerWebContentsId
        ),
        'subagentModels'
      );
    },
    'providers.subagent-models.update': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id) return invalid('id is required');
      const current = settingsState(services.readSettings()).subagentModels;
      const existing = Array.isArray(current)
        ? current.map(asRecord).find((entry) => entry?.id === id)
        : undefined;
      if (!existing) return unavailable(`subagent model entry not found: ${id}`);
      const parsed = parseSubagentModelFields(params, services, existing);
      if (!('value' in parsed)) return parsed;
      return updateArrayById(
        services,
        'subagentModels',
        id,
        () => ({ id, ...parsed.value }),
        context.ownerWebContentsId
      );
    },
    'providers.subagent-models.remove': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id) return invalid('id is required');
      const stale = context.assertExecutionCurrent();
      return (
        stale ??
        updateArrayById(services, 'subagentModels', id, () => null, context.ownerWebContentsId)
      );
    },
    'providers.oauth.list': async () => success(await services.listOauthProviders()),
    'providers.oauth.login': async (context, params) => {
      const providerId = requiredString(params, 'providerId');
      if (!providerId) return invalid('providerId is required');
      const locator: OauthFlowLocator = {
        flowId: randomUUID(),
        ownerWebContentsId: context.ownerWebContentsId,
        host: 'agent-child-tab',
        child: context.child,
        turnId: context.turnId,
        requestId: context.requestId,
      };
      const stale = context.assertExecutionCurrent();
      if (stale) return stale;
      const handle = services.beginOauthLogin(providerId, locator, context.signal);
      if (handle.start.status === 'busy') {
        return failed(`OAuth login is busy in ${handle.start.activeHost}`);
      }
      if (handle.start.status === 'failed') return failed(handle.start.message);
      context.setOauthFlow(locator);
      const terminal = await handle.completion;
      if (terminal?.type === 'done') {
        return success({
          providerId: terminal.providerId,
          accountKey: terminal.account.key,
          locator,
        });
      }
      if (context.signal.aborted) return cancelled('OAuth login was cancelled.');
      return terminal?.type === 'error'
        ? failed(terminal.message)
        : failed('OAuth login ended without an account.');
    },
    'providers.oauth.logout': async (context, params) => {
      const accountKey = requiredString(params, 'accountKey');
      if (!accountKey) return invalid('accountKey is required');
      const providers = await services.listOauthProviders();
      const accountExists = providers.some((provider) =>
        provider.accounts.some((account) => account.key === accountKey)
      );
      if (!accountExists) return unavailable(`OAuth account not found: ${accountKey}`);
      const stale = context.assertExecutionCurrent();
      if (stale) return stale;
      try {
        await services.oauthLogout(accountKey, context.ownerWebContentsId);
        const staleAfterLogout = context.assertExecutionCurrent();
        if (staleAfterLogout) return staleAfterLogout;
        return success({ accountKey, status: 'signed-out' });
      } catch (error) {
        return failed(safeError(error));
      }
    },
    'providers.oauth.usage': async (_context, params) => {
      const accountKey = requiredString(params, 'accountKey');
      if (!accountKey) return invalid('accountKey is required');
      const providers = await services.listOauthProviders();
      if (
        !providers.some((provider) =>
          provider.accounts.some((account) => account.key === accountKey)
        )
      ) {
        return unavailable(`OAuth account not found: ${accountKey}`);
      }
      return success(await services.getOauthAccountUsage(accountKey));
    },
    'providers.oauth.cancel-login': (context) => {
      const locator = context.getOauthFlow();
      return locator && services.cancelOauthLogin(locator)
        ? success({ status: 'cancel-requested', locator })
        : unavailable('No OAuth login owned by this Enso child.');
    },
    'providers.oauth.reopen-login': (context) => {
      const locator = context.getOauthFlow();
      const stale = context.assertExecutionCurrent();
      if (stale) return stale;
      return locator && services.reopenOauthLogin(locator)
        ? success({ status: 'reopened', locator })
        : unavailable('No OAuth login owned by this Enso child.');
    },
    'skills.list': () => success(settingsState(services.readSettings()).skills ?? []),
    'skills.toggle': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id || typeof params.enabled !== 'boolean') return invalid('id and enabled are required');
      return updateArrayById(
        services,
        'skills',
        id,
        (entry) => ({ ...entry, enabled: params.enabled }),
        context.ownerWebContentsId
      );
    },
    'skills.remove': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id) return invalid('id is required');
      const stale = context.assertExecutionCurrent();
      return (
        stale ?? updateArrayById(services, 'skills', id, () => null, context.ownerWebContentsId)
      );
    },
    'mcp.list': () => {
      const servers = settingsState(services.readSettings()).mcpServers;
      return success(
        Array.isArray(servers)
          ? servers.map((raw) => {
              const entry = asRecord(raw) ?? {};
              return {
                id: entry.id,
                name: entry.name,
                transport: entry.transport,
                enabled: entry.enabled,
                source: entry.source,
              };
            })
          : []
      );
    },
    'mcp.toggle': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id || typeof params.enabled !== 'boolean') return invalid('id and enabled are required');
      return updateArrayById(
        services,
        'mcpServers',
        id,
        (entry) => ({ ...entry, enabled: params.enabled }),
        context.ownerWebContentsId
      );
    },
    'mcp.remove': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id) return invalid('id is required');
      const stale = context.assertExecutionCurrent();
      return (
        stale ?? updateArrayById(services, 'mcpServers', id, () => null, context.ownerWebContentsId)
      );
    },
    'instructions.list': () => success(settingsState(services.readSettings()).instructions ?? []),
    'instructions.toggle': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id || typeof params.enabled !== 'boolean') return invalid('id and enabled are required');
      const instructions = settingsState(services.readSettings()).instructions;
      if (!Array.isArray(instructions)) return unavailable('Instructions are not configured.');
      const next = instructions.map((raw) => {
        const entry = asRecord(raw);
        if (!entry) return raw;
        return { ...entry, enabled: entry.id === id ? params.enabled : false };
      });
      return patchResult(
        services.patchSettings('instructions', next, context.ownerWebContentsId),
        'instructions'
      );
    },
    'instructions.read': (_context, params) => {
      const id = requiredString(params, 'id');
      if (!id) return invalid('id is required');
      const entries = settingsState(services.readSettings()).instructions;
      const entry = Array.isArray(entries)
        ? entries.map(asRecord).find((candidate) => candidate?.id === id)
        : undefined;
      if (!entry) return unavailable(`Instruction not found: ${id}`);
      const result = services.readInstruction(
        id,
        entry.local === true,
        typeof entry.sourcePath === 'string' ? entry.sourcePath : undefined
      );
      return result.ok
        ? success({ id, content: result.content })
        : failed(result.error ?? 'Instruction read failed');
    },
    'instructions.edit-local-copy': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id || typeof params.content !== 'string') return invalid('id and content are required');
      const result = services.writeInstruction(id, params.content);
      if (!result.ok) return failed('Instruction write failed');
      const updated = updateArrayById(
        services,
        'instructions',
        id,
        (entry) => ({ ...entry, local: true, bytes: result.bytes }),
        context.ownerWebContentsId
      );
      return updated.ok ? success({ id, bytes: result.bytes }) : updated;
    },
    'instructions.remove': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id) return invalid('id is required');
      const stale = context.assertExecutionCurrent();
      if (stale) return stale;
      services.deleteInstruction(id);
      return updateArrayById(services, 'instructions', id, () => null, context.ownerWebContentsId);
    },
    'presets.list': () => success(settingsState(services.readSettings()).presets ?? []),
    'presets.create': (context, params) => {
      const parsed = parsePresetFields(params, settingsState(services.readSettings()));
      if (!('value' in parsed)) return parsed;
      const preset: Preset = { id: randomUUID(), ...parsed.value };
      const current = settingsState(services.readSettings()).presets;
      return patchResult(
        services.patchSettings(
          'presets',
          [...(Array.isArray(current) ? current : []), preset],
          context.ownerWebContentsId
        ),
        'presets'
      );
    },
    'presets.edit': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id) return invalid('id is required');
      const current = settingsState(services.readSettings()).presets;
      const existing = Array.isArray(current)
        ? current.map(asRecord).find((entry) => entry?.id === id)
        : undefined;
      if (!existing) return unavailable(`presets entry not found: ${id}`);
      const parsed = parsePresetFields(params, settingsState(services.readSettings()), existing);
      if (!('value' in parsed)) return parsed;
      return updateArrayById(
        services,
        'presets',
        id,
        () => ({ id, ...parsed.value }),
        context.ownerWebContentsId
      );
    },
    'presets.delete': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id) return invalid('id is required');
      const stale = context.assertExecutionCurrent();
      return (
        stale ?? updateArrayById(services, 'presets', id, () => null, context.ownerWebContentsId)
      );
    },
    'agent-types.list': () => success(services.sessionIndex.listAgentTypes()),
    'agent-types.create': (context, params) => {
      const parsed = parseAgentTypeFields(params, settingsState(services.readSettings()));
      if (!('value' in parsed)) return parsed;
      const entry: AgentTypeEntry = { id: randomUUID(), ...parsed.value };
      const current = settingsState(services.readSettings()).agentTypes;
      return patchResult(
        services.patchSettings(
          'agentTypes',
          [...(Array.isArray(current) ? current : []), entry],
          context.ownerWebContentsId
        ),
        'agentTypes'
      );
    },
    'agent-types.edit': (context, params) => {
      const rawId = requiredString(params, 'id');
      if (!rawId) return invalid('id is required');
      const id = customAgentTypeId(rawId);
      const current = settingsState(services.readSettings()).agentTypes;
      const existing = Array.isArray(current)
        ? current.map(asRecord).find((entry) => entry?.id === id)
        : undefined;
      if (!existing) return unavailable(`agentTypes entry not found: ${id}`);
      const parsed = parseAgentTypeFields(params, settingsState(services.readSettings()), existing);
      if (!('value' in parsed)) return parsed;
      return updateArrayById(
        services,
        'agentTypes',
        id,
        () => ({ id, ...parsed.value }),
        context.ownerWebContentsId
      );
    },
    'agent-types.toggle-builtin': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id || typeof params.enabled !== 'boolean') return invalid('id and enabled are required');
      if (!BUILTIN_AGENT_TYPES.some((entry) => entry.name === id && entry.name !== 'general')) {
        return invalid(`Unknown or locked built-in agent type: ${id}`);
      }
      const current = settingsState(services.readSettings()).disabledBuiltinAgentTypes;
      const disabled = new Set(
        Array.isArray(current)
          ? current.filter((name): name is string => typeof name === 'string')
          : []
      );
      if (params.enabled) disabled.delete(id);
      else disabled.add(id);
      return patchResult(
        services.patchSettings(
          'disabledBuiltinAgentTypes',
          Array.from(disabled),
          context.ownerWebContentsId
        ),
        'disabledBuiltinAgentTypes'
      );
    },
    'agent-types.delete': (context, params) => {
      const rawId = requiredString(params, 'id');
      if (!rawId) return invalid('id is required');
      const id = customAgentTypeId(rawId);
      const stale = context.assertExecutionCurrent();
      return (
        stale ?? updateArrayById(services, 'agentTypes', id, () => null, context.ownerWebContentsId)
      );
    },
    'tools.list': () => {
      const current = settingsState(services.readSettings()).disabledBuiltinTools;
      const disabled = new Set(
        Array.isArray(current) ? current.filter((id): id is string => typeof id === 'string') : []
      );
      return success(BUILTIN_TOOLS.map((tool) => ({ ...tool, enabled: !disabled.has(tool.id) })));
    },
    'tools.toggle-builtin': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id || typeof params.enabled !== 'boolean') return invalid('id and enabled are required');
      if (!BUILTIN_TOOLS.some((tool) => tool.id === id))
        return invalid(`Unknown built-in tool: ${id}`);
      const current = settingsState(services.readSettings()).disabledBuiltinTools;
      const disabled = new Set(
        Array.isArray(current)
          ? current.filter((value): value is string => typeof value === 'string')
          : []
      );
      if (params.enabled) disabled.delete(id);
      else disabled.add(id);
      return patchResult(
        services.patchSettings(
          'disabledBuiltinTools',
          Array.from(disabled),
          context.ownerWebContentsId
        ),
        'disabledBuiltinTools'
      );
    },
    'projects.list': () => success(settingsState(services.readSettings()).projects ?? []),
    'projects.recent': async () => success(await services.getRecentProjects()),
    'projects.remove': (context, params) => {
      const id = requiredString(params, 'id');
      if (!id) return invalid('id is required');
      const stale = context.assertExecutionCurrent();
      return (
        stale ?? patchResult(services.removeProject(id, context.ownerWebContentsId), 'projects')
      );
    },
    'conversations.list': () => {
      const store = asRecord(services.readSettings()?.['enso-conversations']);
      const state = asRecord(store?.state);
      const conversations = asRecord(state?.conversations) ?? {};
      return success(
        Object.values(conversations).flatMap((raw) => {
          const entry = asRecord(raw);
          if (!entry || typeof entry.id !== 'string') return [];
          return [
            {
              id: entry.id,
              projectId: entry.projectId,
              title: entry.title,
              started: entry.started === true,
              createdAt: entry.createdAt,
              status: entry.status,
              coworkerIds: entry.coworkerIds,
            },
          ];
        })
      );
    },
    'team.list-agent-types': () => success(services.sessionIndex.listAgentTypes()),
    'team.list-coworkers': (context) => {
      const result = services.sessionIndex.listCoworkers(
        context.parentBinding.parentConversationId
      );
      return result.ok ? success(result.data) : result;
    },
    'team.hire-coworker': async (context, params) => {
      const name = requiredString(params, 'name');
      if (!name) return invalid('name is required');
      const allowed = new Set(['name', 'agentType']);
      if (Object.keys(params).some((key) => !allowed.has(key))) {
        return invalid('Unknown hire field');
      }
      const stale = context.assertExecutionCurrent();
      if (stale) return stale;
      // 入口处检一次不够：hire 要跨 reserve → spawn → ready 好几个异步边界。
      // 把 guard 一并交给 dispatch service，让它在每个不可逆边界前重验。
      return services.hireCoworker(
        context.parentBinding.parentConversationId,
        name,
        typeof params.agentType === 'string' ? params.agentType : undefined,
        teamGuardOf(context)
      );
    },
    'team.dismiss-coworker': async (context, params) => {
      const coworkerId = requiredString(params, 'coworkerId');
      if (!coworkerId) return invalid('coworkerId is required');
      const stale = context.assertExecutionCurrent();
      if (stale) return stale;
      return services.dismissCoworker(
        context.parentBinding.parentConversationId,
        coworkerId,
        teamGuardOf(context)
      );
    },
    'updates.check': async () => {
      await services.checkForUpdates();
      return success({ status: 'checked' });
    },
    'updates.download': async () => {
      await services.downloadUpdate();
      return success({ status: 'download-started' });
    },
  } satisfies Record<ExecutableCapabilityId, CapabilityHandler>;

  for (const handlerId of Object.keys(CAPABILITY_HANDLER_CONTRACT) as ExecutableCapabilityId[]) {
    if (typeof handlers[handlerId] !== 'function')
      throw new Error(`Missing capability handler: ${handlerId}`);
  }
  return handlers;
}

export class CapabilityGateway {
  private static readonly MAX_RECENT_REQUESTS = 256;
  private static readonly MAX_INVOCATION_CONTEXTS = 128;

  private readonly invocations = new Map<string, CapabilityInvocationContext>();
  private readonly invocationOrder: string[] = [];
  private readonly settledRequestIds = new Set<string>();
  private readonly settledRequestOrder: string[] = [];
  private readonly pendingByRequestId = new Map<string, PendingAsk>();
  private readonly queue: PendingAsk[] = [];
  private readonly receiptSequences = new Map<string, number>();
  private readonly oauthFlows = new Map<string, OauthFlowLocator>();
  private active: PendingAsk | null = null;

  constructor(
    private readonly services: CapabilityDomainServices,
    private readonly transport: CapabilityGatewayTransport,
    private readonly handlers = createCapabilityHandlers(services)
  ) {}

  registerInvocation(context: CapabilityInvocationContext): boolean {
    if (
      context.child.typeKey !== 'agent:enso' ||
      context.child.profileId !== 'enso-locked-v1' ||
      context.child.parent.sessionId !== context.parentBinding.parentConversationId ||
      !this.transport.hasWindow(context.ownerWebContentsId)
    ) {
      return false;
    }
    // 授权以 child generation 为单位：一次派发 = 一个 locked Enso child，注册只发生一次。
    // 不能用 turnId 做键：child 内部的 agent turn 是模型循环产物（agent_end 会清空
    // currentTurnId，下一轮重新生成随机 uuid），而这里没有任何“每轮重新授权”的路径，
    // 以 turnId 为键会让能力调用在第二轮起静默失效。真正的门是 exact generation
    // 比对（sameChild）与 terminateGeneration 的级联撤销。
    const key = this.generationKey(context.child);
    if (this.invocations.has(key)) return false;
    const immutable: CapabilityInvocationContext = {
      child: {
        ...context.child,
        parent: { ...context.child.parent },
      },
      parentBinding: { ...context.parentBinding },
      turnId: context.turnId,
      ownerWebContentsId: context.ownerWebContentsId,
    };
    this.invocations.set(key, immutable);
    this.invocationOrder.push(key);
    while (this.invocationOrder.length > CapabilityGateway.MAX_INVOCATION_CONTEXTS) {
      const oldest = this.invocationOrder.shift();
      if (oldest) this.invocations.delete(oldest);
    }
    return true;
  }

  releaseWindow(webContentsId: number): void {
    const affected = [...this.invocations.values()].filter(
      (context) => context.ownerWebContentsId === webContentsId
    );
    for (const context of affected) this.terminateGeneration(context.child, 'Owner window closed.');
  }

  async invoke(request: CapabilityInvokeRequest): Promise<CapabilityExecutionEnvelope> {
    const spec = CAPABILITY_CATALOG[request.capabilityId] as CapabilitySpec;
    const context = this.invocations.get(this.generationKey(request.child));
    if (!context || !this.sameChild(context.child, request.child)) {
      return this.unprojectedEnvelope(
        request,
        spec,
        invalid('Capability invocation is not bound to this locked Enso child generation')
      );
    }
    const replayKey = this.requestKey(request.child, request.requestId);
    if (this.settledRequestIds.has(replayKey) || this.pendingByRequestId.has(replayKey)) {
      return this.unprojectedEnvelope(
        request,
        spec,
        invalid('Capability requestId is duplicate or expired')
      );
    }
    const reservation = this.reserveReceipt(context);
    const schemaError = validateJsonSchema(request.params, spec.inputSchema);
    if (schemaError) {
      return this.finish(context, spec, request, invalid(schemaError), reservation);
    }
    const params = asRecord(request.params);
    if (!params) {
      return this.finish(
        context,
        spec,
        request,
        invalid('Capability params must be an object'),
        reservation
      );
    }
    const availability = await this.checkAvailability(spec.availability, context);
    if (availability) return this.finish(context, spec, request, availability, reservation);
    if (spec.execution.kind === 'known-unavailable') {
      return this.finish(
        context,
        spec,
        request,
        unavailable(spec.execution.reason, spec.execution.suggestedAction),
        reservation
      );
    }
    const handler = this.handlers[spec.execution.handlerId as ExecutableCapabilityId];
    if (!handler) {
      return this.finish(
        context,
        spec,
        request,
        unavailable(`No handler registered for ${request.capabilityId}`),
        reservation
      );
    }
    const controller = new AbortController();
    const flowKey = this.generationKey(context.child);
    const handlerContext: CapabilityHandlerContext = {
      ...context,
      capabilityId: spec.execution.handlerId as ExecutableCapabilityId,
      requestId: request.requestId,
      signal: controller.signal,
      assertExecutionCurrent: () =>
        controller.signal.aborted || !this.invocations.has(this.generationKey(context.child))
          ? cancelled('Capability generation was terminated before commit.')
          : null,
      setOauthFlow: (locator) => this.oauthFlows.set(flowKey, locator),
      getOauthFlow: () => this.oauthFlows.get(flowKey),
    };
    const execute = async (): Promise<CapabilityExecutionEnvelope> => {
      this.emitReceiptStarted(context, request, reservation, 'executing');
      let result: CapabilityResult;
      if (controller.signal.aborted) {
        result = cancelled('Capability generation was terminated.');
      } else {
        try {
          result = await handler(handlerContext, params);
        } catch (error) {
          result = failed(safeError(error));
        }
      }
      return this.finish(context, spec, request, result, reservation);
    };
    if (spec.risk !== 'dangerous') return execute();

    const askSecrets = await this.secrets();
    let host: CapabilityAskHost | undefined;
    if (handlerContext.capabilityId === 'providers.oauth.login') {
      const providerId = requiredString(params, 'providerId');
      if (!providerId) {
        return this.finish(context, spec, request, invalid('providerId is required'), reservation);
      }
      const providers = await this.services.listOauthProviders();
      const match = providers.find((provider) => provider.id === providerId);
      if (!match) {
        return this.finish(
          context,
          spec,
          request,
          unavailable(`OAuth provider not found: ${providerId}`),
          reservation
        );
      }
      host = {
        kind: 'oauth-login',
        providerId,
        providerLabel: askSecrets.redact(match.name),
      };
    }

    const { promise, resolve } = Promise.withResolvers<CapabilityExecutionEnvelope>();
    const pending: PendingAsk = {
      context: handlerContext,
      spec,
      params,
      summary: askSecrets.redact(this.askSummary(spec, this.resolveSubject(spec, params, context))),
      ...(host ? { host } : {}),
      controller,
      reservation,
      execute,
      resolve,
      state: 'queued',
      decided: false,
    };
    this.pendingByRequestId.set(replayKey, pending);
    this.queue.push(pending);
    this.pump();
    return promise;
  }

  respond(
    webContentsId: number,
    response: {
      child: CapabilityInvokeRequest['child'];
      turnId: string;
      requestId: string;
      decision: 'allow' | 'deny';
    }
  ): CapabilityResponseResult {
    const pending = this.active;
    if (
      !pending ||
      pending.decided ||
      pending.context.turnId !== response.turnId ||
      pending.context.requestId !== response.requestId ||
      !this.sameChild(pending.context.child, response.child)
    ) {
      return { ok: true, accepted: false, state: pending?.state ?? 'settled' };
    }
    if (
      pending.context.ownerWebContentsId !== webContentsId ||
      !this.transport.hasWindow(webContentsId)
    ) {
      return {
        ok: false,
        accepted: false,
        state: pending.state,
        error: 'Response owner does not match this child TAB',
      };
    }
    pending.decided = true;
    pending.state = 'executing';
    void this.runActive(pending, response.decision);
    return { ok: true, accepted: true, state: 'executing' };
  }

  terminateGeneration(
    child: CapabilityInvokeRequest['child'],
    reason = 'The Enso child generation terminated.'
  ): void {
    const generation = this.generationKey(child);
    for (const [key, context] of this.invocations) {
      if (this.generationKey(context.child) === generation) this.invocations.delete(key);
    }
    this.oauthFlows.delete(generation);
    const queued = this.queue.filter(
      (pending) => this.generationKey(pending.context.child) === generation
    );
    for (const pending of queued) {
      const index = this.queue.indexOf(pending);
      if (index >= 0) this.queue.splice(index, 1);
      pending.controller.abort();
      pending.state = 'cancel-requested';
      void this.settleCancelled(pending, reason);
    }
    this.receiptSequences.delete(generation);
    if (this.active && this.generationKey(this.active.context.child) === generation) {
      this.requestActiveCancellation(this.active, reason);
    }
  }

  denyAll(reason: string): void {
    for (const pending of [...this.queue]) {
      const index = this.queue.indexOf(pending);
      if (index >= 0) this.queue.splice(index, 1);
      pending.controller.abort();
      pending.state = 'cancel-requested';
      void this.settleCancelled(pending, reason);
    }
    if (this.active) this.requestActiveCancellation(this.active, reason);
  }

  get cacheSizes(): {
    invocations: number;
    pending: number;
    settled: number;
    oauthFlows: number;
  } {
    return {
      invocations: this.invocations.size,
      pending: this.pendingByRequestId.size,
      settled: this.settledRequestIds.size,
      oauthFlows: this.oauthFlows.size,
    };
  }

  private requestActiveCancellation(pending: PendingAsk, reason: string): void {
    pending.controller.abort();
    if (!pending.decided) {
      pending.state = 'cancel-requested';
      void this.settleCancelled(pending, reason);
      return;
    }
    if (pending.state === 'settled' || pending.state === 'cancel-requested') return;
    pending.state = 'cancel-requested';
    this.emitReceiptStarted(
      pending.context,
      this.requestFromPending(pending),
      pending.reservation,
      'cancel-requested'
    );
  }

  private async runActive(pending: PendingAsk, decision: 'allow' | 'deny'): Promise<void> {
    const envelope =
      decision === 'deny'
        ? await this.finish(
            pending.context,
            pending.spec,
            this.requestFromPending(pending),
            { ok: false, code: 'denied', error: 'User denied this operation.' },
            pending.reservation
          )
        : await pending.execute();
    pending.state = 'settled';
    pending.resolve(envelope);
    this.completeActive(pending);
  }

  private async settleCancelled(pending: PendingAsk, reason: string): Promise<void> {
    if (pending.state === 'settled') return;
    const envelope = await this.finish(
      pending.context,
      pending.spec,
      this.requestFromPending(pending),
      cancelled(reason),
      pending.reservation
    );
    pending.state = 'settled';
    pending.resolve(envelope);
    const replayKey = this.requestKey(pending.context.child, pending.context.requestId);
    this.pendingByRequestId.delete(replayKey);
    this.rememberSettled(replayKey);
    if (this.active === pending) this.completeActive(pending);
  }

  private async finish(
    context: CapabilityInvocationContext,
    spec: CapabilitySpec,
    request: CapabilityInvokeRequest,
    result: CapabilityResult,
    reservation: ReceiptReservation
  ): Promise<CapabilityExecutionEnvelope> {
    this.rememberSettled(this.requestKey(request.child, request.requestId));
    const secrets = await this.secrets();
    secrets.addFromUnknown(result);
    const modelResult = secrets.redact(
      result.ok ? { ok: true, data: sanitizeForRenderer(result.data) } : result
    ) as CapabilityResult;
    const receipt = secrets.redact(
      this.createReceipt(context, spec, request, modelResult, reservation)
    ) as CapabilityReceipt;
    try {
      await this.transport.appendChildReceipt(context.child, receipt);
    } catch {
      // The coordinator still needs the real settled outcome; a terminated child may reject projection.
    }
    this.transport.observeReceipt({
      type: 'receipt-settled',
      child: context.child,
      // 用绑定上下文的 turnId（= 派发轮次），不用 child 内部的每轮 uuid，
      // 否则跨 agent turn 的 receipt 在协调器侧关联不上，完成通知会丢 summary。
      turnId: context.turnId,
      requestId: request.requestId,
      receiptId: reservation.receiptId,
      receiptSeq: reservation.receiptSeq,
      executionState: 'settled',
      receipt,
    });
    return { modelResult, receipt };
  }

  private reserveReceipt(context: CapabilityInvocationContext): ReceiptReservation {
    const generation = this.generationKey(context.child);
    const receiptSeq = this.receiptSequences.get(generation) ?? 0;
    this.receiptSequences.set(generation, receiptSeq + 1);
    return { receiptId: randomUUID(), receiptSeq, started: false };
  }

  private emitReceiptStarted(
    context: CapabilityInvocationContext,
    request: CapabilityInvokeRequest,
    reservation: ReceiptReservation,
    executionState: 'executing' | 'cancel-requested'
  ): void {
    if (executionState === 'executing' && reservation.started) return;
    reservation.started = true;
    this.transport.observeReceipt({
      type: 'receipt-started',
      child: context.child,
      turnId: context.turnId,
      requestId: request.requestId,
      receiptId: reservation.receiptId,
      receiptSeq: reservation.receiptSeq,
      executionState,
    });
  }

  private requestFromPending(pending: PendingAsk): CapabilityInvokeRequest {
    return {
      child: pending.context.child,
      turnId: pending.context.turnId,
      requestId: pending.context.requestId,
      capabilityId: pending.context.capabilityId,
      params: pending.params,
    };
  }

  private unprojectedEnvelope(
    request: CapabilityInvokeRequest,
    spec: CapabilitySpec,
    result: CapabilityResult
  ): CapabilityExecutionEnvelope {
    const occurredAt = Date.now();
    return {
      modelResult: result,
      receipt: {
        receiptId: randomUUID(),
        operationId: request.requestId,
        child: request.child,
        turnId: request.turnId,
        requestId: request.requestId,
        capabilityId: request.capabilityId,
        risk: spec.risk,
        subject: { kind: 'other', id: request.capabilityId, label: request.capabilityId },
        outcome: result.ok ? 'succeeded' : this.outcome(result.code),
        summary: result.ok ? 'Capability succeeded.' : result.error,
        ...(result.ok || !result.suggestedAction
          ? {}
          : { suggestedAction: result.suggestedAction }),
        occurredAt,
        sequence: 0,
      },
    };
  }

  private createReceipt(
    context: CapabilityInvocationContext,
    spec: CapabilitySpec,
    request: CapabilityInvokeRequest,
    result: CapabilityResult,
    reservation: ReceiptReservation
  ): CapabilityReceipt {
    const subject = this.resolveSubject(spec, asRecord(request.params) ?? {}, context);
    const data = result.ok ? asRecord(result.data) : null;
    const changes =
      data &&
      typeof data.field === 'string' &&
      Object.hasOwn(data, 'previous') &&
      Object.hasOwn(data, 'value')
        ? [{ field: data.field, previous: data.previous, value: data.value }]
        : undefined;
    const outcome = result.ok ? 'succeeded' : this.outcome(result.code);
    return {
      receiptId: reservation.receiptId,
      operationId: request.requestId,
      child: context.child,
      turnId: request.turnId,
      requestId: request.requestId,
      capabilityId: request.capabilityId,
      risk: spec.risk,
      subject,
      outcome,
      summary: result.ok
        ? `${subject.label}: ${request.capabilityId} succeeded.`
        : `${subject.label}: ${result.error}`,
      ...(changes ? { changes } : {}),
      ...(!result.ok && result.suggestedAction ? { suggestedAction: result.suggestedAction } : {}),
      occurredAt: Date.now(),
      sequence: reservation.receiptSeq,
    };
  }

  private outcome(code: Exclude<CapabilityResult, { ok: true }>['code']) {
    switch (code) {
      case 'denied':
        return 'denied' as const;
      case 'unavailable':
        return 'unavailable' as const;
      case 'cancelled':
        return 'cancelled' as const;
      case 'invalid':
      case 'failed':
        return 'failed' as const;
    }
  }

  private async secrets(): Promise<SecretSet> {
    let stored: readonly string[] = [];
    try {
      stored = await this.services.readSecretValues();
    } catch {}
    return createSecretSet(this.services.readSettings(), stored);
  }

  private async checkAvailability(
    requirements: readonly AvailabilityRequirement[],
    context: CapabilityInvocationContext
  ): Promise<CapabilityResult | null> {
    const state = settingsState(this.services.readSettings());
    for (const requirement of requirements) {
      switch (requirement.kind) {
        case 'default-model':
          if (!asRecord(state.defaultModel)) {
            return unavailable('No global default model is configured.');
          }
          break;
        case 'configured-provider':
          if (providersOf(this.services).length === 0) {
            return unavailable('No provider is configured.');
          }
          break;
        case 'oauth-provider':
          if ((await this.services.listOauthProviders()).length === 0) {
            return unavailable('No subscription provider is available.');
          }
          break;
        case 'origin-window':
          if (!this.transport.hasWindow(context.ownerWebContentsId)) {
            return unavailable('The child owner window is no longer available.');
          }
          break;
        case 'origin-project':
          if (!context.parentBinding.parentProjectPath) {
            return unavailable('No origin project is bound to this child.');
          }
          break;
        case 'origin-conversation':
          if (!context.parentBinding.parentConversationId) {
            return unavailable('No origin conversation is bound to this child.');
          }
          break;
        case 'started-origin-conversation': {
          const target = this.services.sessionIndex.listCoworkers(
            context.parentBinding.parentConversationId
          );
          if (!target.ok) return target;
          break;
        }
        case 'desktop-updater':
          if (!this.services.updaterAvailable()) {
            return unavailable('Desktop updater is unavailable.');
          }
          break;
      }
    }
    return null;
  }

  private resolveSubject(
    spec: CapabilitySpec,
    params: Record<string, unknown>,
    context?: CapabilityInvocationContext
  ): CapabilityReceipt['subject'] {
    const state = settingsState(this.services.readSettings());
    const providerId =
      typeof params.providerId === 'string'
        ? params.providerId
        : spec.id.startsWith('providers.') && typeof params.id === 'string'
          ? params.id
          : undefined;
    if (providerId) {
      const provider = providersOf(this.services).find((entry) => entry.id === providerId);
      return {
        kind: 'provider',
        id: providerId,
        label: provider?.name ?? `Unknown provider (${providerId})`,
      };
    }
    if (typeof params.accountKey === 'string') {
      const key = params.accountKey;
      const provider = providersOf(this.services).find((entry) => entry.oauthAccountKey === key);
      return {
        kind: 'account',
        id: key,
        label: provider?.name ?? `Unknown account (${key})`,
      };
    }
    if (typeof params.coworkerId === 'string') {
      const target = context
        ? this.services.sessionIndex.listCoworkers(context.parentBinding.parentConversationId)
        : unavailable('No bound parent conversation.');
      const data = target.ok && Array.isArray(target.data) ? target.data : [];
      const coworker = data.map(asRecord).find((entry) => entry?.id === params.coworkerId);
      return {
        kind: 'coworker',
        id: params.coworkerId,
        label:
          typeof coworker?.name === 'string'
            ? coworker.name
            : `Unknown coworker (${params.coworkerId})`,
      };
    }
    const settingField = resultSettingField(spec.id);
    if (settingField) return { kind: 'setting', id: settingField, label: settingField };
    if (typeof params.id === 'string') {
      for (const [field, kind] of [
        ['agentTypes', 'agent-type'],
        ['presets', 'preset'],
        ['skills', 'other'],
        ['mcpServers', 'other'],
        ['projects', 'project'],
      ] as const) {
        const entries = state[field];
        const entry = Array.isArray(entries)
          ? entries.map(asRecord).find((candidate) => candidate?.id === params.id)
          : undefined;
        if (entry) {
          return {
            kind,
            id: params.id,
            label: typeof entry.name === 'string' ? entry.name : params.id,
          };
        }
      }
    }
    return { kind: 'other', id: spec.id, label: spec.id };
  }

  private askSummary(spec: CapabilitySpec, subject: CapabilityReceipt['subject']): string {
    const state = settingsState(this.services.readSettings());
    const locale = normalizeLocale(typeof state.language === 'string' ? state.language : undefined);
    return `${translate(locale, spec.description)} ${subject.label}`;
  }

  private pump(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    next.state = 'waiting-decision';
    this.active = next;
    if (!this.transport.hasWindow(next.context.ownerWebContentsId)) {
      next.controller.abort();
      void this.settleCancelled(next, 'Owner window is unavailable.');
      return;
    }
    this.transport.sendAsk(next.context.ownerWebContentsId, {
      child: next.context.child,
      turnId: next.context.turnId,
      requestId: next.context.requestId,
      capabilityId: next.context.capabilityId,
      summary: next.summary,
      ...(next.host ? { host: next.host } : {}),
    });
  }

  private completeActive(pending: PendingAsk): void {
    if (this.active !== pending) return;
    this.active = null;
    const replayKey = this.requestKey(pending.context.child, pending.context.requestId);
    this.pendingByRequestId.delete(replayKey);
    this.rememberSettled(replayKey);
    this.pump();
  }

  private rememberSettled(key: string): void {
    if (this.settledRequestIds.has(key)) return;
    this.settledRequestIds.add(key);
    this.settledRequestOrder.push(key);
    while (this.settledRequestOrder.length > CapabilityGateway.MAX_RECENT_REQUESTS) {
      const oldest = this.settledRequestOrder.shift();
      if (oldest) this.settledRequestIds.delete(oldest);
    }
  }

  private generationKey(child: CapabilityInvokeRequest['child']): string {
    return `${child.sessionId}:${child.generation}`;
  }

  private requestKey(child: CapabilityInvokeRequest['child'], requestId: string): string {
    return `${this.generationKey(child)}:${requestId}`;
  }

  private sameChild(
    left: CapabilityInvokeRequest['child'],
    right: CapabilityInvokeRequest['child']
  ): boolean {
    return (
      left.sessionId === right.sessionId &&
      left.generation === right.generation &&
      left.parent.sessionId === right.parent.sessionId &&
      left.parent.generation === right.parent.generation &&
      left.instanceId === right.instanceId &&
      left.typeKey === right.typeKey &&
      left.profileId === right.profileId
    );
  }
}

export { validateJsonSchema };
