import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import { isReservedAgentTypeName } from '@shared/builtinAgents';
import { parseCompactStrategy } from '@shared/compactStrategy';
import { parseSmartCompactMode } from '@shared/smartCompactMode';
import { STATUS_LINE_SEGMENT_IDS } from '@shared/statusLine';
import {
  BUILTIN_AGENT_TYPES,
  BUILTIN_TOOLS,
  DEFAULT_PRESET_ID,
  MODEL_API_KINDS,
  THINKING_LEVELS,
} from '@shared/types';
import { hasBase64Shape } from './assets';
import type { ConfigSyncBundle, ConfigSyncMcpServer, ConfigSyncProvider } from './types';
import { CONFIG_SYNC_MCP_OMISSIONS, CONFIG_SYNC_PROVIDER_OMISSIONS } from './types';

export const CONFIG_SYNC_DECRYPT_ERROR_CODE = 'config-sync-decrypt-failed';

export class ConfigSyncCodecError extends Error {
  constructor(
    readonly code: typeof CONFIG_SYNC_DECRYPT_ERROR_CODE,
    message: string
  ) {
    super(message);
    this.name = 'ConfigSyncCodecError';
  }
}

const ENVELOPE_FORMAT = 'enso-config';
const VERSION = 1;
const ENCRYPTED_MARKER = 'enso-config-encrypted';
const AUTH_CONTEXT = Buffer.from('enso-code/config-sync/v1', 'utf8');
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 1024;
const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_STRING_BYTES = 4 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4;

const TOP_LEVEL_KEYS = ['format', 'version', 'createdAt', 'state', 'resources', 'secretsIncluded'];
const STATE_KEYS = [
  'providers',
  'skills',
  'mcpServers',
  'instructions',
  'presets',
  'agentTypes',
  'subagentModels',
  'defaultModel',
  'titleSummaryModel',
  'memoryDistillModel',
  'memoryChatModel',
  'memoryLanguage',
  'smartCompactModel',
  'approvalReviewer',
  'titleSummaryEnabled',
  'compactStrategy',
  'smartCompactEnabled',
  'smartCompactMode',
  'memoryEmbeddingModel',
  'memoryDistillEnabled',
  'memoryKgEnabled',
  'defaultReasoningEnabled',
  'defaultThinkingLevel',
  'defaultPresetId',
  'subagentModelsEnabled',
  'disabledBuiltinAgentTypes',
  'disabledBuiltinTools',
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
  'expandLiveEdits',
  'chatWide',
  'notifyMainAgentOnly',
  'maxActiveCoworkers',
  'generationStallTimeoutMin',
  'autoArchiveIdleDays',
  'autoArchiveMergedWorktrees',
  'autoDeleteArchivedDays',
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
];
const PROVIDER_KEYS = [
  'id',
  'name',
  'api',
  'apiKey',
  'oauthAccountKey',
  'baseUrl',
  'enabled',
  'models',
  'importedFrom',
  'catalogId',
  'omittedFields',
];
const SKILL_KEYS = ['id', 'name', 'description', 'path', 'source', 'enabled'];
const MCP_KEYS = [
  'id',
  'name',
  'transport',
  'command',
  'args',
  'env',
  'url',
  'connectTimeoutSec',
  'callTimeoutSec',
  'source',
  'enabled',
  'omittedFields',
];
const INSTRUCTION_KEYS = ['id', 'name', 'source', 'sourcePath', 'local', 'bytes', 'enabled'];
const PRESET_KEYS = ['id', 'name', 'skillIds', 'mcpServerIds', 'instructionId'];
const AGENT_TYPE_KEYS = [
  'id',
  'name',
  'description',
  'systemPrompt',
  'modelMode',
  'providerId',
  'modelId',
  'tools',
  'writeScope',
  'skillIds',
  'mcpServerIds',
];
const SUBAGENT_MODEL_KEYS = [
  'id',
  'providerId',
  'modelId',
  'description',
  'enabled',
  'reasoning',
  'thinkingLevel',
];
const MODEL_KEYS = [
  'id',
  'label',
  'enabled',
  'reasoning',
  'thinkingLevel',
  'contextWindow',
  'maxTokens',
];
const RESOURCE_KEYS = ['skills', 'instructions'];
const SKILL_RESOURCE_KEYS = ['id', 'files'];
const FILE_KEYS = ['path', 'content', 'executable'];
const INSTRUCTION_RESOURCE_KEYS = ['id', 'content'];
const ENCRYPTED_KEYS = ['format', 'version', 'kind', 'salt', 'iv', 'tag', 'ciphertext'];
const FONT_WEIGHTS = [
  'normal',
  'bold',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
] as const;
const KEYBINDING_ACTIONS = [
  'toggle-sidebar',
  'toggle-side-panel',
  'toggle-side-panel-fullscreen',
  'open-settings',
  'switch-model',
  'focus-composer',
  'find-in-chat',
  'search-workspace',
  'new-conversation',
  'next-tab',
  'prev-tab',
  'new-side-tab',
  'close-side-tab',
] as const;
const PRICING_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function assertExactKeys(value: RecordValue, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
}

function stringField(value: RecordValue, key: string, label: string, required?: true): string;
function stringField(
  value: RecordValue,
  key: string,
  label: string,
  required: false
): string | undefined;
function stringField(
  value: RecordValue,
  key: string,
  label: string,
  required = true
): string | undefined {
  if (value[key] === undefined && !required) return undefined;
  if (typeof value[key] !== 'string') throw new Error(`Invalid ${label}.${key}`);
  if (Buffer.byteLength(value[key], 'utf8') > MAX_STRING_BYTES) {
    throw new Error(`Oversized ${label}.${key}`);
  }
  return value[key];
}

function nonEmptyStringField(value: RecordValue, key: string, label: string): string {
  const text = stringField(value, key, label);
  if (!text.trim() || text.includes('\0')) throw new Error(`Invalid ${label}.${key}`);
  return text;
}

function deriveKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 32, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function booleanField(
  value: RecordValue,
  key: string,
  label: string,
  required = true
): boolean | undefined {
  if (value[key] === undefined && !required) return undefined;
  if (typeof value[key] !== 'boolean') throw new Error(`Invalid ${label}.${key}`);
  return value[key];
}

function arrayField(
  value: RecordValue,
  key: string,
  label: string,
  required = true
): unknown[] | undefined {
  if (value[key] === undefined && !required) return undefined;
  if (!Array.isArray(value[key])) throw new Error(`Invalid ${label}.${key}`);
  return value[key];
}

function numberField(
  value: RecordValue,
  key: string,
  label: string,
  min: number,
  max: number,
  integer = false
): number | undefined {
  if (value[key] === undefined) return undefined;
  const number = value[key];
  if (
    typeof number !== 'number' ||
    !Number.isFinite(number) ||
    number < min ||
    number > max ||
    (integer && !Number.isInteger(number))
  ) {
    throw new Error(`Invalid ${label}.${key}`);
  }
  return number;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

function passwordBytes(password: string | undefined): Buffer {
  if (
    typeof password !== 'string' ||
    password.length < PASSWORD_MIN ||
    password.length > PASSWORD_MAX
  ) {
    throw new Error('Invalid config sync password');
  }
  return Buffer.from(password, 'utf8');
}

function canonicalBase64(value: unknown, label: string, maxBytes = MAX_FILE_BYTES): Buffer {
  const maxLength =
    maxBytes === MAX_FILE_BYTES ? MAX_BASE64_LENGTH : Math.ceil((maxBytes * 4) / 3) + 4;
  if (typeof value !== 'string' || value.length > maxLength || !hasBase64Shape(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error(`Non-canonical ${label}`);
  if (decoded.byteLength > maxBytes) throw new Error(`Oversized ${label}`);
  return decoded;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function normalizedPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    hasControlCharacter(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error('Invalid resource path');
  }
  if (
    value.startsWith('/') ||
    value.split('/').some((segment) => segment === '' || segment === '..' || segment === '.')
  ) {
    throw new Error('Unsafe resource path');
  }
  const normalized = value.normalize('NFC');
  if (normalized !== value) throw new Error('Invalid resource path');
  return value;
}

function idList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return [...value];
}

function uniqueIds(entries: RecordValue[], category: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = nonEmptyStringField(entry, 'id', category);
    if (ids.has(id)) throw new Error(`Duplicate ${category} id`);
    ids.add(id);
  }
  return ids;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`Invalid ${label}`);
  return [...value];
}

function uniqueStringArray(value: unknown, allowed: readonly string[], label: string): string[] {
  const entries = optionalStringArray(value, label);
  if (
    !entries ||
    new Set(entries).size !== entries.length ||
    entries.some((entry) => !allowed.includes(entry))
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return entries;
}

function validateStringMap(value: unknown, allowedKeys: readonly string[], label: string): void {
  const record = assertRecord(value, label);
  assertExactKeys(record, allowedKeys, label);
  for (const key of Object.keys(record)) stringField(record, key, label);
}

function validatePricingTable(value: unknown): void {
  const table = assertRecord(value, 'usageModelPricing');
  for (const [modelId, rawPricing] of Object.entries(table)) {
    if (!modelId.trim() || modelId.includes('\0')) throw new Error('Invalid pricing model id');
    const pricing = assertRecord(rawPricing, `pricing ${modelId}`);
    assertExactKeys(pricing, PRICING_KEYS, 'pricing');
    for (const key of PRICING_KEYS) {
      if (typeof pricing[key] !== 'number' || !Number.isFinite(pricing[key]) || pricing[key] < 0) {
        throw new Error(`Invalid pricing ${key}`);
      }
    }
  }
}

function validateModels(value: unknown, provider: string): RecordValue[] {
  const models = Array.isArray(value) ? value : null;
  if (!models) throw new Error(`Invalid provider models: ${provider}`);
  const ids = new Set<string>();
  return models.map((raw, index) => {
    const entry = assertRecord(raw, `provider model ${provider}/${index}`);
    assertExactKeys(entry, MODEL_KEYS, 'model');
    const id = nonEmptyStringField(entry, 'id', 'model');
    if (ids.has(id)) throw new Error(`Duplicate model id: ${provider}/${id}`);
    ids.add(id);
    if (entry.label !== undefined) stringField(entry, 'label', 'model', false);
    booleanField(entry, 'enabled', 'model', false);
    if (entry.reasoning !== undefined && entry.reasoning !== 'on' && entry.reasoning !== 'off') {
      throw new Error('Invalid model reasoning override');
    }
    if (
      entry.thinkingLevel !== undefined &&
      !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(entry.thinkingLevel))
    ) {
      throw new Error('Invalid model thinking override');
    }
    for (const key of ['contextWindow', 'maxTokens']) {
      if (
        entry[key] !== undefined &&
        (typeof entry[key] !== 'number' || !Number.isFinite(entry[key]) || entry[key] <= 0)
      ) {
        throw new Error(`Invalid model ${key}`);
      }
    }
    return entry;
  });
}

function validateHttpUrl(value: string, label: string, allowEmpty = false): void {
  if (!value && allowEmpty) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
  } catch {
    throw new Error(`Invalid ${label} URL`);
  }
}

function validateProvider(raw: unknown): RecordValue {
  const entry = assertRecord(raw, 'provider');
  assertExactKeys(entry, PROVIDER_KEYS, 'provider');
  nonEmptyStringField(entry, 'id', 'provider');
  nonEmptyStringField(entry, 'name', 'provider');
  if (!MODEL_API_KINDS.includes(entry.api as (typeof MODEL_API_KINDS)[number]))
    throw new Error('Invalid provider API');
  stringField(entry, 'api', 'provider');
  if (entry.apiKey !== undefined) stringField(entry, 'apiKey', 'provider', false);
  if (entry.oauthAccountKey !== undefined) stringField(entry, 'oauthAccountKey', 'provider', false);
  const baseUrl = stringField(entry, 'baseUrl', 'provider');
  validateHttpUrl(baseUrl, 'provider', true);
  booleanField(entry, 'enabled', 'provider');
  validateModels(entry.models, String(entry.id));
  for (const key of ['importedFrom', 'catalogId'])
    if (entry[key] !== undefined) stringField(entry, key, 'provider', false);
  const omittedFields = optionalStringArray(entry.omittedFields, 'provider.omittedFields');
  if (omittedFields?.some((field) => !CONFIG_SYNC_PROVIDER_OMISSIONS.includes(field as never))) {
    throw new Error('Invalid provider omission marker');
  }
  return entry;
}

function validateSkill(raw: unknown): RecordValue {
  const entry = assertRecord(raw, 'skill');
  assertExactKeys(entry, SKILL_KEYS, 'skill');
  nonEmptyStringField(entry, 'id', 'skill');
  nonEmptyStringField(entry, 'name', 'skill');
  stringField(entry, 'description', 'skill');
  if (entry.path !== '') throw new Error('Skill source path must be empty in a portable bundle');
  stringField(entry, 'path', 'skill', false);
  stringField(entry, 'source', 'skill');
  booleanField(entry, 'enabled', 'skill');
  return entry;
}

function validateMcp(raw: unknown): RecordValue {
  const entry = assertRecord(raw, 'MCP server');
  assertExactKeys(entry, MCP_KEYS, 'MCP server');
  nonEmptyStringField(entry, 'id', 'MCP server');
  nonEmptyStringField(entry, 'name', 'MCP server');
  if (!['stdio', 'http', 'sse'].includes(String(entry.transport)))
    throw new Error('Invalid MCP transport');
  if (entry.command !== undefined) stringField(entry, 'command', 'MCP server', false);
  if (entry.url !== undefined) stringField(entry, 'url', 'MCP server', false);
  if (
    entry.transport === 'stdio' &&
    (typeof entry.command !== 'string' || !entry.command.trim() || entry.url !== undefined)
  ) {
    throw new Error('Invalid stdio MCP configuration');
  }
  if ((entry.transport === 'http' || entry.transport === 'sse') && typeof entry.url !== 'string') {
    throw new Error('Invalid URL MCP configuration');
  }
  if (typeof entry.url === 'string') validateHttpUrl(entry.url, 'MCP server');
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.some((item) => typeof item !== 'string'))
      throw new Error('Invalid MCP args');
  }
  if (entry.env !== undefined) {
    if (
      !isRecord(entry.env) ||
      Object.entries(entry.env).some(([key, value]) => !key || typeof value !== 'string')
    )
      throw new Error('Invalid MCP env');
  }
  for (const key of ['connectTimeoutSec', 'callTimeoutSec']) {
    if (
      entry[key] !== undefined &&
      (typeof entry[key] !== 'number' || !Number.isFinite(entry[key]) || entry[key] <= 0)
    )
      throw new Error(`Invalid MCP ${key}`);
  }
  stringField(entry, 'source', 'MCP server');
  booleanField(entry, 'enabled', 'MCP server');
  const omittedFields = optionalStringArray(entry.omittedFields, 'MCP server.omittedFields');
  if (omittedFields?.some((field) => !CONFIG_SYNC_MCP_OMISSIONS.includes(field as never))) {
    throw new Error('Invalid MCP omission marker');
  }
  return entry;
}

function validateInstruction(raw: unknown): RecordValue {
  const entry = assertRecord(raw, 'instruction');
  assertExactKeys(entry, INSTRUCTION_KEYS, 'instruction');
  nonEmptyStringField(entry, 'id', 'instruction');
  nonEmptyStringField(entry, 'name', 'instruction');
  stringField(entry, 'source', 'instruction');
  if (entry.sourcePath !== undefined && entry.sourcePath !== '')
    throw new Error('Instruction source path must be empty');
  if (entry.sourcePath !== undefined) stringField(entry, 'sourcePath', 'instruction', false);
  booleanField(entry, 'local', 'instruction');
  if (
    typeof entry.bytes !== 'number' ||
    !Number.isInteger(entry.bytes) ||
    entry.bytes < 0 ||
    entry.bytes > MAX_STRING_BYTES
  )
    throw new Error('Invalid instruction bytes');
  booleanField(entry, 'enabled', 'instruction');
  return entry;
}

function validatePreset(raw: unknown): RecordValue {
  const entry = assertRecord(raw, 'preset');
  assertExactKeys(entry, PRESET_KEYS, 'preset');
  nonEmptyStringField(entry, 'id', 'preset');
  if (entry.id === DEFAULT_PRESET_ID) throw new Error('Reserved default preset');
  nonEmptyStringField(entry, 'name', 'preset');
  idList(entry.skillIds, 'preset.skillIds');
  idList(entry.mcpServerIds, 'preset.mcpServerIds');
  if (entry.instructionId !== undefined) stringField(entry, 'instructionId', 'preset', false);
  return entry;
}

function validateAgentType(raw: unknown): RecordValue {
  const entry = assertRecord(raw, 'agent type');
  assertExactKeys(entry, AGENT_TYPE_KEYS, 'agent type');
  // 与设置页/registry 同口径：同名 custom 覆盖 builtin 是合法配置，仅保留名 fail-closed。
  const name = nonEmptyStringField(entry, 'name', 'agent type');
  if (isReservedAgentTypeName(name)) throw new Error('Reserved agent type name');
  const id = nonEmptyStringField(entry, 'id', 'agent type');
  if (id.startsWith('builtin:')) throw new Error('Reserved agent type id');
  stringField(entry, 'description', 'agent type');
  stringField(entry, 'systemPrompt', 'agent type');
  if (!['all', 'readonly'].includes(String(entry.tools)))
    throw new Error('Invalid agent type tools');
  if (
    entry.modelMode !== undefined &&
    !['agent_pick', 'follow', 'fixed'].includes(String(entry.modelMode))
  )
    throw new Error('Invalid agent type model mode');
  for (const key of ['providerId', 'modelId'])
    if (entry[key] !== undefined) nonEmptyStringField(entry, key, 'agent type');
  if (
    entry.modelMode === 'fixed' &&
    (typeof entry.providerId !== 'string' || typeof entry.modelId !== 'string')
  ) {
    throw new Error('Fixed agent type is missing a model');
  }
  if (
    (entry.modelMode === 'agent_pick' || entry.modelMode === 'follow') &&
    (entry.providerId !== undefined || entry.modelId !== undefined)
  ) {
    throw new Error('Non-fixed agent type cannot bind a model');
  }
  if ((entry.providerId === undefined) !== (entry.modelId === undefined)) {
    throw new Error('Incomplete agent model reference');
  }
  optionalStringArray(entry.writeScope, 'agent type.writeScope');
  if (entry.skillIds !== undefined) idList(entry.skillIds, 'agent type.skillIds');
  if (entry.mcpServerIds !== undefined) idList(entry.mcpServerIds, 'agent type.mcpServerIds');
  return entry;
}

function validateSubagentModel(raw: unknown): RecordValue {
  const entry = assertRecord(raw, 'subagent model');
  assertExactKeys(entry, SUBAGENT_MODEL_KEYS, 'subagent model');
  nonEmptyStringField(entry, 'id', 'subagent model');
  nonEmptyStringField(entry, 'providerId', 'subagent model');
  nonEmptyStringField(entry, 'modelId', 'subagent model');
  stringField(entry, 'description', 'subagent model');
  booleanField(entry, 'enabled', 'subagent model', false);
  if (entry.reasoning !== undefined && !['on', 'off'].includes(String(entry.reasoning)))
    throw new Error('Invalid subagent reasoning');
  if (
    entry.thinkingLevel !== undefined &&
    !THINKING_LEVELS.includes(entry.thinkingLevel as (typeof THINKING_LEVELS)[number])
  )
    throw new Error('Invalid subagent thinking level');
  return entry;
}

function validateRef(value: unknown, providers: Map<string, Set<string>>, label: string): void {
  if (!isRecord(value) || typeof value.providerId !== 'string' || typeof value.modelId !== 'string')
    throw new Error(`Invalid ${label}`);
  const models = providers.get(value.providerId);
  if (!models?.has(value.modelId)) throw new Error(`Unknown ${label} reference`);
}

function redactEndpoint(value: string): { value: string; omissions: string[] } {
  try {
    const parsed = new URL(value);
    const omissions: string[] = [];
    if (parsed.username || parsed.password) omissions.push('credentials');
    if (parsed.search) omissions.push('query');
    if (parsed.hash) omissions.push('fragment');
    return omissions.length === 0 ? { value, omissions } : { value: strippedUrl(value), omissions };
  } catch {
    const next = strippedUrl(value);
    return { value: next, omissions: next === value ? [] : ['query'] };
  }
}

function assertPlainBundle(bundle: ConfigSyncBundle): void {
  if (bundle.secretsIncluded) throw new Error('Sensitive config sync payload must be encrypted');
  if (bundle.resources.skills.length > 0 || bundle.resources.instructions.length > 0) {
    throw new Error('Plain config sync bundle cannot include resource contents');
  }
  if (
    bundle.state.providers.some(
      (entry) =>
        entry.apiKey !== undefined ||
        entry.oauthAccountKey !== undefined ||
        redactEndpoint(entry.baseUrl).omissions.length > 0
    ) ||
    bundle.state.mcpServers.some(
      (entry) =>
        entry.args !== undefined ||
        entry.env !== undefined ||
        (entry.url !== undefined && redactEndpoint(entry.url).omissions.length > 0)
    )
  ) {
    throw new Error('Plain config sync bundle contains sensitive fields');
  }
}

function validateReferences(
  state: RecordValue,
  providers: RecordValue[],
  skills: RecordValue[],
  mcpServers: RecordValue[],
  instructions: RecordValue[],
  presets: RecordValue[],
  agentTypes: RecordValue[],
  subagentModels: RecordValue[]
): void {
  const providerModels = new Map(
    providers.map((provider) => [
      String(provider.id),
      new Set(
        validateModels(provider.models, String(provider.id)).map((model) => String(model.id))
      ),
    ])
  );
  const skillIds = uniqueIds(skills, 'skill');
  const mcpIds = uniqueIds(mcpServers, 'MCP server');
  const instructionIds = uniqueIds(instructions, 'instruction');
  const presetIds = uniqueIds(presets, 'preset');
  uniqueIds(providers, 'provider');
  uniqueIds(agentTypes, 'agent type');
  uniqueIds(subagentModels, 'subagent model');
  const checkIds = (value: unknown, known: Set<string>, label: string) => {
    for (const id of idList(value, label))
      if (!known.has(id)) throw new Error(`Unknown ${label} reference`);
  };
  for (const preset of presets) {
    checkIds(preset.skillIds, skillIds, 'preset skill');
    checkIds(preset.mcpServerIds, mcpIds, 'preset MCP server');
    if (preset.instructionId !== undefined && !instructionIds.has(String(preset.instructionId)))
      throw new Error('Unknown preset instruction reference');
  }
  for (const agent of agentTypes) {
    if (agent.skillIds !== undefined) checkIds(agent.skillIds, skillIds, 'agent skill');
    if (agent.mcpServerIds !== undefined) checkIds(agent.mcpServerIds, mcpIds, 'agent MCP server');
    if (agent.providerId !== undefined || agent.modelId !== undefined)
      validateRef(
        { providerId: agent.providerId, modelId: agent.modelId },
        providerModels,
        'agent model'
      );
  }
  for (const entry of subagentModels) validateRef(entry, providerModels, 'subagent model');
  for (const key of [
    'defaultModel',
    'titleSummaryModel',
    'memoryDistillModel',
    'smartCompactModel',
    'approvalReviewer',
  ])
    if (state[key] !== undefined && state[key] !== null)
      validateRef(state[key], providerModels, key);
  if (
    state.defaultPresetId !== undefined &&
    state.defaultPresetId !== DEFAULT_PRESET_ID &&
    !presetIds.has(String(state.defaultPresetId))
  )
    throw new Error('Unknown default preset reference');
}

function validateResources(
  value: unknown,
  skillIds: Set<string>,
  instructionBytes: Map<string, number>
): RecordValue {
  const resources = assertRecord(value, 'resources');
  assertExactKeys(resources, RESOURCE_KEYS, 'resources');
  const skills = arrayField(resources, 'skills', 'resources') ?? [];
  const instructions = arrayField(resources, 'instructions', 'resources') ?? [];
  const resourceSkillIds = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  const skillResources = skills.map((raw) => {
    const entry = assertRecord(raw, 'skill resource');
    assertExactKeys(entry, SKILL_RESOURCE_KEYS, 'skill resource');
    const id = nonEmptyStringField(entry, 'id', 'skill resource');
    if (!skillIds.has(id) || resourceSkillIds.has(id))
      throw new Error('Invalid or duplicate skill resource id');
    resourceSkillIds.add(id);
    const files = arrayField(entry, 'files', 'skill resource') ?? [];
    const paths = new Set<string>();
    let hasSkill = false;
    const parsedFiles = files.map((rawFile) => {
      const file = assertRecord(rawFile, 'skill resource file');
      assertExactKeys(file, FILE_KEYS, 'skill resource file');
      const path = normalizedPath(file.path);
      const key = path.toLocaleLowerCase();
      if (paths.has(key)) throw new Error('Duplicate resource path');
      paths.add(key);
      if (path === 'SKILL.md') hasSkill = true;
      const content = canonicalBase64(file.content, 'skill resource content');
      totalBytes += content.byteLength;
      fileCount += 1;
      if (file.executable !== undefined && typeof file.executable !== 'boolean')
        throw new Error('Invalid executable flag');
      return file;
    });
    if (!hasSkill) throw new Error('Skill resource is missing SKILL.md');
    return { ...entry, files: parsedFiles };
  });
  const resourceInstructionIds = new Set<string>();
  const instructionResources = instructions.map((raw) => {
    const entry = assertRecord(raw, 'instruction resource');
    assertExactKeys(entry, INSTRUCTION_RESOURCE_KEYS, 'instruction resource');
    const id = nonEmptyStringField(entry, 'id', 'instruction resource');
    if (!instructionBytes.has(id) || resourceInstructionIds.has(id))
      throw new Error('Invalid or duplicate instruction resource id');
    resourceInstructionIds.add(id);
    const content = stringField(entry, 'content', 'instruction resource');
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (instructionBytes.get(id) !== contentBytes) {
      throw new Error('Instruction resource size does not match metadata');
    }
    totalBytes += contentBytes;
    fileCount += 1;
    return { ...entry, content };
  });
  if (fileCount > MAX_FILES || totalBytes > MAX_RESOURCE_BYTES)
    throw new Error('Resource limits exceeded');
  for (const id of skillIds)
    if (!resourceSkillIds.has(id)) throw new Error('Missing skill resource');
  for (const id of instructionBytes.keys())
    if (!resourceInstructionIds.has(id)) throw new Error('Missing instruction resource');
  return { skills: skillResources, instructions: instructionResources };
}

/** 严格校验未知输入并返回收窄后的版本 1 配置包。 */
export function validateBundle(value: unknown): ConfigSyncBundle {
  const bundle = assertRecord(value, 'bundle');
  assertExactKeys(bundle, TOP_LEVEL_KEYS, 'bundle');
  if (bundle.format !== ENVELOPE_FORMAT || bundle.version !== VERSION)
    throw new Error('Unsupported config sync bundle');
  const createdAt = stringField(bundle, 'createdAt', 'bundle');
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    throw new Error('Invalid bundle timestamp');
  }
  if (typeof bundle.secretsIncluded !== 'boolean') throw new Error('Invalid secretsIncluded');
  const state = assertRecord(bundle.state, 'state');
  assertExactKeys(state, STATE_KEYS, 'state');
  const providers = (arrayField(state, 'providers', 'state') ?? []).map(validateProvider);
  const skills = (arrayField(state, 'skills', 'state') ?? []).map(validateSkill);
  const mcpServers = (arrayField(state, 'mcpServers', 'state') ?? []).map(validateMcp);
  const instructions = (arrayField(state, 'instructions', 'state') ?? []).map(validateInstruction);
  const presets = (arrayField(state, 'presets', 'state') ?? []).map(validatePreset);
  const agentTypes = (arrayField(state, 'agentTypes', 'state') ?? []).map(validateAgentType);
  const subagentModels = (arrayField(state, 'subagentModels', 'state') ?? []).map(
    validateSubagentModel
  );
  const enabledInstructions = instructions.filter((entry) => entry.enabled === true);
  if (enabledInstructions.length > 1) throw new Error('Multiple enabled instructions');
  for (const key of [
    'titleSummaryEnabled',
    'smartCompactEnabled',
    'memoryDistillEnabled',
    'memoryKgEnabled',
    'defaultReasoningEnabled',
    'subagentModelsEnabled',
  ])
    booleanField(state, key, 'state', false);
  if (state.compactStrategy !== undefined && parseCompactStrategy(state.compactStrategy) === null)
    throw new Error('Invalid state.compactStrategy');
  if (
    state.smartCompactMode !== undefined &&
    parseSmartCompactMode(state.smartCompactMode) === null
  )
    throw new Error('Invalid state.smartCompactMode');
  if (
    state.defaultThinkingLevel !== undefined &&
    !THINKING_LEVELS.includes(state.defaultThinkingLevel as (typeof THINKING_LEVELS)[number])
  )
    throw new Error('Invalid default thinking level');
  if (state.defaultPresetId !== undefined) stringField(state, 'defaultPresetId', 'state', false);
  if (
    state.theme !== undefined &&
    !['light', 'dark', 'system', 'sync-terminal'].includes(String(state.theme))
  )
    throw new Error('Invalid state.theme');
  if (state.language !== undefined && !['en', 'zh'].includes(String(state.language)))
    throw new Error('Invalid state.language');
  for (const key of [
    'terminalTheme',
    'terminalFontFamily',
    'memoryEmbeddingModel',
    'memoryChatModel',
  ]) {
    if (state[key] !== undefined) nonEmptyStringField(state, key, 'state');
  }
  numberField(state, 'terminalFontSize', 'state', Number.MIN_VALUE, Number.MAX_SAFE_INTEGER);
  for (const key of ['terminalFontWeight', 'terminalFontWeightBold']) {
    if (
      state[key] !== undefined &&
      !FONT_WEIGHTS.includes(state[key] as (typeof FONT_WEIGHTS)[number])
    )
      throw new Error(`Invalid state.${key}`);
  }
  if (state.favoriteTerminalThemes !== undefined)
    optionalStringArray(state.favoriteTerminalThemes, 'state.favoriteTerminalThemes');
  if (state.statusLineSegments !== undefined)
    uniqueStringArray(
      state.statusLineSegments,
      STATUS_LINE_SEGMENT_IDS,
      'state.statusLineSegments'
    );
  for (const key of [
    'loadLocalSkills',
    'loadHarnessAssets',
    'exploreFoldEnabled',
    'bashInterceptEnabled',
    'hashlineEditEnabled',
    'openChangesOnFileEdit',
    'compactReadOnlyTools',
    'expandLiveEdits',
    'chatWide',
    'notifyMainAgentOnly',
    'autoArchiveMergedWorktrees',
  ])
    booleanField(state, key, 'state', false);
  numberField(state, 'maxActiveCoworkers', 'state', 1, 20, true);
  numberField(state, 'generationStallTimeoutMin', 'state', 0, 120, true);
  numberField(state, 'autoArchiveIdleDays', 'state', 0, 90, true);
  numberField(state, 'autoDeleteArchivedDays', 'state', 0, 90, true);
  numberField(state, 'backgroundRandomInterval', 'state', 5, 86400, true);
  for (const [key, min, max] of [
    ['backgroundOpacity', 0, 1],
    ['backgroundBlur', 0, 20],
    ['backgroundBrightness', 0, 2],
    ['backgroundSaturation', 0, 2],
    ['backgroundComposerOpacity', 0, 1],
    ['backgroundCodeOpacity', 0, 1],
  ] as const)
    numberField(state, key, 'state', min, max);
  if (
    state.backgroundSizeMode !== undefined &&
    !['cover', 'contain', 'repeat', 'center'].includes(String(state.backgroundSizeMode))
  )
    throw new Error('Invalid state.backgroundSizeMode');
  if (state.disabledBuiltinTools !== undefined)
    uniqueStringArray(
      state.disabledBuiltinTools,
      BUILTIN_TOOLS.map((tool) => tool.id),
      'state.disabledBuiltinTools'
    );
  if (state.keybindings !== undefined)
    validateStringMap(state.keybindings, KEYBINDING_ACTIONS, 'state.keybindings');
  if (state.usageModelPricing !== undefined) validatePricingTable(state.usageModelPricing);
  const disabledBuiltinAgentTypes = optionalStringArray(
    state.disabledBuiltinAgentTypes,
    'state.disabledBuiltinAgentTypes'
  );
  if (
    disabledBuiltinAgentTypes &&
    (new Set(disabledBuiltinAgentTypes).size !== disabledBuiltinAgentTypes.length ||
      disabledBuiltinAgentTypes.some(
        (name) => !BUILTIN_AGENT_TYPES.some((entry) => entry.name === name)
      ))
  ) {
    throw new Error('Invalid disabled built-in agent type');
  }
  validateReferences(
    state,
    providers,
    skills,
    mcpServers,
    instructions,
    presets,
    agentTypes,
    subagentModels
  );
  const resources = validateResources(
    bundle.resources,
    new Set(skills.map((entry) => String(entry.id))),
    new Map(instructions.map((entry) => [String(entry.id), Number(entry.bytes)]))
  );
  return {
    format: ENVELOPE_FORMAT,
    version: VERSION,
    createdAt,
    state: {
      ...state,
      providers,
      skills,
      mcpServers,
      instructions,
      presets,
      agentTypes,
      subagentModels,
    } as unknown as ConfigSyncBundle['state'],
    resources: resources as ConfigSyncBundle['resources'],
    secretsIncluded: bundle.secretsIncluded,
  };
}

function strippedUrl(value: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    const withoutQuery = value.replace(/[?#].*$/u, '');
    if (/^[^:/?#]+:/u.test(withoutQuery) && !/^[a-z][a-z\d+.-]*:\/\//iu.test(withoutQuery)) {
      return withoutQuery.slice(0, withoutQuery.indexOf(':'));
    }
    return withoutQuery.replace(/^(https?:\/\/)([^/@]+@)/iu, '$1');
  }
}

/** 克隆配置包并移除显式敏感字段，同时记录省略信息；不会扫描或改写正文内容。 */
export function redactBundle(bundle: ConfigSyncBundle): ConfigSyncBundle {
  const redacted = clone(bundle);
  redacted.secretsIncluded = false;
  redacted.state.providers = redacted.state.providers.map((provider) => {
    const next = { ...provider } as ConfigSyncProvider;
    const omitted = new Set(next.omittedFields ?? []);
    if (next.apiKey !== undefined) {
      delete next.apiKey;
      omitted.add(CONFIG_SYNC_PROVIDER_OMISSIONS[0]);
    }
    if (next.oauthAccountKey !== undefined) {
      delete next.oauthAccountKey;
      omitted.add(CONFIG_SYNC_PROVIDER_OMISSIONS[1]);
    }
    const originalBaseUrl = next.baseUrl;
    const redactedBaseUrl = redactEndpoint(originalBaseUrl);
    next.baseUrl = redactedBaseUrl.value;
    if (redactedBaseUrl.omissions.includes('credentials')) omitted.add('baseUrlCredentials');
    if (redactedBaseUrl.omissions.includes('query')) omitted.add('baseUrlQuery');
    if (redactedBaseUrl.omissions.includes('fragment')) omitted.add('baseUrlFragment');
    if (omitted.size > 0) next.omittedFields = [...omitted];
    return next;
  });
  redacted.state.mcpServers = redacted.state.mcpServers.map((server) => {
    const next = { ...server } as ConfigSyncMcpServer;
    const omitted = new Set(next.omittedFields ?? []);
    if (next.args !== undefined) {
      delete next.args;
      omitted.add('args');
    }
    if (next.env !== undefined) {
      delete next.env;
      omitted.add('env');
    }
    if (next.url !== undefined) {
      const original = next.url;
      const redactedUrl = redactEndpoint(original);
      next.url = redactedUrl.value;
      if (redactedUrl.omissions.includes('credentials')) omitted.add('urlCredentials');
      if (redactedUrl.omissions.includes('query')) omitted.add('urlQuery');
      if (redactedUrl.omissions.includes('fragment')) omitted.add('urlFragment');
    }
    if (omitted.size > 0) next.omittedFields = [...omitted];
    return next;
  });
  Object.defineProperty(redacted, 'secretsIncluded', {
    value: false,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return redacted;
}

/** 把已校验配置包编码为明文或整包加密的文件内容。 */
export async function encodeBundle(bundle: ConfigSyncBundle, password?: string): Promise<Buffer> {
  const validated = bundle.secretsIncluded
    ? validateBundle(bundle)
    : validateBundle(redactBundle(bundle));
  if (!validated.secretsIncluded) {
    if (validated.resources.skills.length > 0 || validated.resources.instructions.length > 0) {
      throw new Error('Plain config sync export cannot include resource contents; use encryption');
    }
    const bytes = Buffer.from(JSON.stringify(validated), 'utf8');
    if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new Error('Config sync bundle is too large');
    return bytes;
  }
  const passphrase = passwordBytes(password);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AUTH_CONTEXT);
  const plaintext = Buffer.from(JSON.stringify(validated), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    format: ENVELOPE_FORMAT,
    version: VERSION,
    kind: ENCRYPTED_MARKER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new Error('Config sync bundle is too large');
  return bytes;
}

/** 解码并严格校验配置包文件内容。 */
export async function decodeBundle(bytes: Buffer, password?: string): Promise<ConfigSyncBundle> {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_ENVELOPE_BYTES)
    throw new Error('Invalid config sync bundle bytes');
  let value: unknown;
  try {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error();
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid config sync bundle JSON');
  }
  if (isEncryptedBundle(bytes)) {
    const envelope = assertRecord(value, 'encrypted envelope');
    assertExactKeys(envelope, ENCRYPTED_KEYS, 'encrypted envelope');
    if (
      envelope.format !== ENVELOPE_FORMAT ||
      envelope.version !== VERSION ||
      envelope.kind !== ENCRYPTED_MARKER
    )
      throw new Error('Unsupported encrypted config sync bundle');
    const salt = canonicalBase64(envelope.salt, 'envelope salt');
    const iv = canonicalBase64(envelope.iv, 'envelope iv');
    const tag = canonicalBase64(envelope.tag, 'envelope tag');
    const ciphertext = canonicalBase64(
      envelope.ciphertext,
      'envelope ciphertext',
      MAX_ENVELOPE_BYTES
    );
    if (salt.byteLength !== 16 || iv.byteLength !== 12 || tag.byteLength !== 16)
      throw new Error('Invalid encrypted envelope');
    const key = await deriveKey(passwordBytes(password), salt);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(AUTH_CONTEXT);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const decoded = JSON.parse(plaintext.toString('utf8')) as unknown;
      const bundle = validateBundle(decoded);
      if (!bundle.secretsIncluded) throw new Error('Encrypted bundle does not contain secrets');
      return bundle;
    } catch {
      throw new ConfigSyncCodecError(
        CONFIG_SYNC_DECRYPT_ERROR_CODE,
        'Unable to decrypt config sync bundle'
      );
    }
  }
  const bundle = validateBundle(value);
  assertPlainBundle(bundle);
  return bundle;
}

/** 仅检查文件外层是否为受支持的加密信封，不做解密。 */
export function isEncryptedBundle(bytes: Buffer): boolean {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_ENVELOPE_BYTES)
    return false;
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    return (
      isRecord(value) &&
      value.format === ENVELOPE_FORMAT &&
      value.version === VERSION &&
      value.kind === ENCRYPTED_MARKER
    );
  } catch {
    return false;
  }
}
