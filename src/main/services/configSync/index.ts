import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  ConfigSyncCommitResult,
  ConfigSyncExportOptions,
  ConfigSyncExportResult,
  ConfigSyncMode,
  ConfigSyncOpenResult,
  ConfigSyncPreviewResult,
  ConfigSyncSummary,
} from '@shared/types';
import { app } from 'electron';
import {
  commitSettingsTransaction,
  readSettings,
  SETTINGS_STATE_FIELDS,
  type SettingsStateField,
  settingsFingerprint,
} from '../../ipc/settings';
import { isValidId } from '../instructionStore';
import { cleanupStagedResources, collectSkillResource, stageResources } from './assets';
import {
  ConfigSyncCodecError,
  decodeBundle,
  encodeBundle,
  isEncryptedBundle,
  redactBundle,
  validateBundle,
} from './codec';
import { planImport } from './merge';
import type { ConfigSyncBundle } from './types';

type SenderKey = number;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const TOKEN_TTL_MS = 10 * 60 * 1000;
type ConfigSyncFieldPolicy = { mode: 'portable' } | { mode: 'excluded'; reason: string };

/** Every persisted settings field must be deliberately classified before it can drift into sync. */
export const CONFIG_SYNC_FIELD_POLICY = {
  theme: { mode: 'portable' },
  language: { mode: 'portable' },
  terminalTheme: { mode: 'portable' },
  terminalFontSize: { mode: 'portable' },
  terminalFontFamily: { mode: 'portable' },
  terminalFontWeight: { mode: 'portable' },
  terminalFontWeightBold: { mode: 'portable' },
  terminalShell: { mode: 'excluded', reason: 'platform-specific shell selection' },
  worktreeRoot: { mode: 'excluded', reason: 'device-local worktree storage path' },
  favoriteTerminalThemes: { mode: 'portable' },
  statusLineSegments: { mode: 'portable' },
  loadLocalSkills: { mode: 'portable' },
  loadHarnessAssets: { mode: 'portable' },
  windowsLocalShell: { mode: 'excluded', reason: 'platform-specific shell selection' },
  exploreFoldEnabled: { mode: 'portable' },
  bashInterceptEnabled: { mode: 'portable' },
  hashlineEditEnabled: { mode: 'portable' },
  compactStrategy: { mode: 'portable' },
  smartCompactEnabled: { mode: 'portable' },
  smartCompactModel: { mode: 'portable' },
  smartCompactMode: { mode: 'portable' },
  memoryEmbeddingModel: { mode: 'portable' },
  memoryEmbeddingAutoDownload: {
    mode: 'excluded',
    reason: 'device policy for a multi-hundred-MB model download',
  },
  memoryModelIdleMinutes: { mode: 'excluded', reason: 'device-local model residency policy' },
  memoryEmbeddingRemoteProviderId: {
    mode: 'excluded',
    reason: 'references a device-local provider record id',
  },
  memoryDistillEnabled: { mode: 'portable' },
  memoryKgEnabled: { mode: 'portable' },
  autoUpdate: { mode: 'excluded', reason: 'device update policy' },
  proxyMode: { mode: 'excluded', reason: 'device network configuration' },
  customProxyUrl: { mode: 'excluded', reason: 'device network configuration may contain secrets' },
  openChangesOnFileEdit: { mode: 'portable' },
  compactReadOnlyTools: { mode: 'portable' },
  expandLiveEdits: { mode: 'portable' },
  chatWide: { mode: 'portable' },
  notifyMainAgentOnly: { mode: 'portable' },
  maxActiveCoworkers: { mode: 'portable' },
  generationStallTimeoutMin: { mode: 'portable' },
  autoArchiveIdleDays: { mode: 'portable' },
  autoArchiveMergedWorktrees: { mode: 'portable' },
  autoDeleteArchivedDays: { mode: 'portable' },
  backgroundImageEnabled: {
    mode: 'excluded',
    reason: 'background appearance activation could enable unavailable or private resources',
  },
  backgroundSourceType: {
    mode: 'excluded',
    reason: 'background appearance source is device-local or remote',
  },
  backgroundImagePath: { mode: 'excluded', reason: 'device-local background resource path' },
  backgroundFolderPath: { mode: 'excluded', reason: 'device-local background resource path' },
  backgroundUrlPath: { mode: 'excluded', reason: 'remote background resource URL' },
  backgroundRandomEnabled: {
    mode: 'excluded',
    reason: 'background activation depends on an unavailable local or remote resource',
  },
  backgroundRandomInterval: { mode: 'portable' },
  backgroundOpacity: { mode: 'portable' },
  backgroundBlur: { mode: 'portable' },
  backgroundBrightness: { mode: 'portable' },
  backgroundSaturation: { mode: 'portable' },
  backgroundComposerOpacity: { mode: 'portable' },
  backgroundCodeOpacity: { mode: 'portable' },
  backgroundSizeMode: { mode: 'portable' },
  backgroundRefreshNonce: { mode: 'excluded', reason: 'device appearance preference' },
  providers: { mode: 'portable' },
  defaultModel: { mode: 'portable' },
  titleSummaryEnabled: { mode: 'portable' },
  titleSummaryModel: { mode: 'portable' },
  memoryDistillModel: { mode: 'portable' },
  memoryChatModel: { mode: 'portable' },
  memoryLanguage: { mode: 'portable' },
  approvalReviewer: { mode: 'portable' },
  lastApprovalMode: { mode: 'excluded', reason: 'last session choice' },
  defaultReasoningEnabled: { mode: 'portable' },
  defaultThinkingLevel: { mode: 'portable' },
  subagentModelsEnabled: { mode: 'portable' },
  subagentModels: { mode: 'portable' },
  skills: { mode: 'portable' },
  mcpServers: { mode: 'portable' },
  instructions: { mode: 'portable' },
  presets: { mode: 'portable' },
  defaultPresetId: { mode: 'portable' },
  agentTypes: { mode: 'portable' },
  disabledBuiltinAgentTypes: { mode: 'portable' },
  disabledBuiltinTools: { mode: 'portable' },
  onboarded: { mode: 'excluded', reason: 'device onboarding state' },
  keybindings: { mode: 'portable' },
  projects: { mode: 'excluded', reason: 'device-local paths and authority records' },
  projectGroups: { mode: 'excluded', reason: 'device-local project grouping' },
  usageModelPricing: { mode: 'portable' },
} as const satisfies Record<SettingsStateField, ConfigSyncFieldPolicy>;

export const SYNC_FIELDS = SETTINGS_STATE_FIELDS.filter(
  (field) => CONFIG_SYNC_FIELD_POLICY[field].mode === 'portable'
);

type TokenEntry = {
  senderId: SenderKey;
  expiresAt: number;
  fileName: string;
  bytes: Buffer;
  encrypted: boolean;
  bundle?: ConfigSyncBundle;
  mode?: ConfigSyncMode;
  fingerprint?: string;
  plan?: ReturnType<typeof planImport>;
};

const tokens = new Map<string, TokenEntry>();

function resultError(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function stateOf(settings: Record<string, unknown> | null): Record<string, unknown> {
  const store = settings?.['enso-settings'];
  if (!store || typeof store !== 'object') return {};
  const state = (store as Record<string, unknown>).state;
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
}

function portableState(state: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of SYNC_FIELDS) {
    if (field in state) result[field] = structuredClone(state[field]);
  }
  for (const field of [
    'providers',
    'skills',
    'mcpServers',
    'instructions',
    'presets',
    'agentTypes',
    'subagentModels',
  ]) {
    if (!(field in result)) result[field] = [];
  }
  for (const skill of Array.isArray(result.skills) ? result.skills : []) {
    if (skill && typeof skill === 'object') (skill as Record<string, unknown>).path = '';
  }
  for (const instruction of Array.isArray(result.instructions) ? result.instructions : []) {
    if (instruction && typeof instruction === 'object') {
      delete (instruction as Record<string, unknown>).sourcePath;
      (instruction as Record<string, unknown>).local = false;
    }
  }
  // OAuth login state is never portable, even in encrypted packages. Keep an omission marker so
  // preview can surface the otherwise unreachable re-authentication warning.
  for (const provider of Array.isArray(result.providers) ? result.providers : []) {
    if (provider && typeof provider === 'object') {
      const entry = provider as Record<string, unknown>;
      if (entry.oauthAccountKey !== undefined) {
        delete entry.oauthAccountKey;
        const omitted = Array.isArray(entry.omittedFields)
          ? entry.omittedFields.filter((field): field is string => typeof field === 'string')
          : [];
        entry.omittedFields = [...new Set([...omitted, 'oauthAccountKey'])];
      }
    }
  }
  return result;
}

function collectBundle(secretsIncluded: boolean): ConfigSyncBundle {
  const sourceState = stateOf(readSettings());
  const state = portableState(sourceState);
  const skills = [] as ConfigSyncBundle['resources']['skills'];
  const instructions = [] as ConfigSyncBundle['resources']['instructions'];
  const rawSkills = Array.isArray(sourceState.skills) ? sourceState.skills : [];
  const portableSkills = Array.isArray(state.skills) ? state.skills : [];
  const keptSkillIds = new Set<string>();
  for (const value of rawSkills) {
    if (!value || typeof value !== 'object') continue;
    const skill = value as Record<string, unknown>;
    if (typeof skill.id !== 'string' || typeof skill.path !== 'string' || !skill.path) continue;
    try {
      skills.push(collectSkillResource(skill.id, skill.path));
      keptSkillIds.add(skill.id);
    } catch {
      // Skip unreadable, missing, or symlink skills so the rest of the package still exports.
    }
  }
  state.skills = portableSkills.filter(
    (item) =>
      item && typeof item === 'object' && keptSkillIds.has(String((item as { id?: unknown }).id))
  );
  const pruneSkillIds = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.filter((id) => typeof id === 'string' && keptSkillIds.has(id));
  };
  if (Array.isArray(state.presets)) {
    state.presets = state.presets.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const preset = item as Record<string, unknown>;
      if (!('skillIds' in preset)) return preset;
      return { ...preset, skillIds: pruneSkillIds(preset.skillIds) };
    });
  }
  if (Array.isArray(state.agentTypes)) {
    state.agentTypes = state.agentTypes.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const agent = item as Record<string, unknown>;
      if (!('skillIds' in agent)) return agent;
      return { ...agent, skillIds: pruneSkillIds(agent.skillIds) };
    });
  }
  const portableInstructions = Array.isArray(state.instructions) ? state.instructions : [];
  const rawInstructions = Array.isArray(sourceState.instructions) ? sourceState.instructions : [];
  for (const value of rawInstructions) {
    if (!value || typeof value !== 'object') throw new Error('Instruction source is unavailable');
    const instruction = value as Record<string, unknown>;
    if (typeof instruction.id !== 'string') throw new Error('Instruction source is unavailable');
    const local = instruction.local === true;
    if (local && !isValidId(instruction.id)) {
      throw new Error('Instruction source is unavailable');
    }
    const sourcePath = typeof instruction.sourcePath === 'string' ? instruction.sourcePath : '';
    const path = local
      ? join(app.getPath('userData'), 'instructions', `${instruction.id}.md`)
      : sourcePath;
    if (!path || !existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error('Instruction source is unavailable');
    }
    const content = readFileSync(path, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    const portable = portableInstructions.find(
      (item) =>
        item && typeof item === 'object' && (item as Record<string, unknown>).id === instruction.id
    ) as Record<string, unknown> | undefined;
    if (portable) portable.bytes = bytes;
    instructions.push({ id: instruction.id, content });
  }
  return {
    format: 'enso-config',
    version: 1,
    createdAt: new Date().toISOString(),
    state,
    resources: { skills, instructions },
    secretsIncluded,
  } as unknown as ConfigSyncBundle;
}

function assertToken(token: string, senderId: SenderKey): TokenEntry | null {
  const entry = tokens.get(token);
  if (!entry || entry.senderId !== senderId || entry.expiresAt <= Date.now()) {
    if (entry?.expiresAt && entry.expiresAt <= Date.now()) tokens.delete(token);
    return null;
  }
  return entry;
}

export async function exportConfigToPath(
  options: ConfigSyncExportOptions,
  filePath: string
): Promise<ConfigSyncExportResult> {
  try {
    if (!options || typeof options.includeSecrets !== 'boolean')
      return resultError('Invalid export options');
    if (
      options.includeSecrets &&
      (!options.password || options.password.length < 8 || options.password.length > 1024)
    ) {
      return resultError('Export password must be between 8 and 1024 characters.');
    }
    let bundle = collectBundle(options.includeSecrets);
    if (
      !options.includeSecrets &&
      (bundle.resources.skills.length > 0 || bundle.resources.instructions.length > 0)
    ) {
      return resultError('Skill and instruction contents require an encrypted export.');
    }
    if (!options.includeSecrets) bundle = redactBundle(bundle);
    const bytes = await encodeBundle(bundle, options.includeSecrets ? options.password : undefined);
    if (bytes.byteLength > MAX_PACKAGE_BYTES)
      return resultError('Configuration package is too large.');
    const existing = (() => {
      try {
        return lstatSync(filePath);
      } catch {
        return null;
      }
    })();
    if (existing?.isSymbolicLink()) return resultError('Unable to export configuration.');
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
    let fd: number | null = null;
    try {
      fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, bytes);
      closeSync(fd);
      fd = null;
      renameSync(tempPath, filePath);
    } finally {
      if (fd !== null) closeSync(fd);
      rmSync(tempPath, { force: true });
    }
    return { ok: true, filePath };
  } catch (error) {
    console.error('[configSync] export failed', error);
    return resultError('Unable to export configuration.');
  }
}

export async function openImportForSender(
  senderId: SenderKey,
  filePath: string | null
): Promise<ConfigSyncOpenResult> {
  if (!filePath) return { ok: false, error: 'Import cancelled.', cancelled: true };
  let fd: number | null = null;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) {
      return resultError('Invalid configuration package.');
    }
    const bytes = readFileSync(fd);
    if (bytes.byteLength > MAX_PACKAGE_BYTES)
      return resultError('Configuration package is too large.');
    const token = randomUUID();
    const entry: TokenEntry = {
      senderId,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      fileName: basename(filePath),
      bytes,
      encrypted: isEncryptedBundle(bytes),
    };
    tokens.set(token, entry);
    const expiryTimer = setTimeout(() => {
      if (tokens.get(token) === entry) tokens.delete(token);
    }, TOKEN_TTL_MS);
    expiryTimer.unref();
    return { ok: true, token, encrypted: entry.encrypted, fileName: entry.fileName };
  } catch {
    return resultError('Unable to read configuration package.');
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export async function previewImportForSender(
  senderId: SenderKey,
  token: string,
  password: string | undefined,
  mode: ConfigSyncMode
): Promise<ConfigSyncPreviewResult> {
  const entry = assertToken(token, senderId);
  if (!entry || (mode !== 'merge' && mode !== 'replace'))
    return resultError('Import session expired.');
  try {
    if (entry.encrypted && entry.bundle) {
      // A successful decrypt/validation is cached against this sender-bound token.
      // Mode changes must not force the renderer to retain or resend a password.
      const current = stateOf(readSettings());
      const plan = planImport(current, entry.bundle, mode);
      entry.mode = mode;
      entry.fingerprint = settingsFingerprint(readSettings());
      entry.plan = plan;
      return {
        ok: true,
        summary: plan.summary as ConfigSyncSummary[],
        warnings: plan.warnings,
        mode,
      };
    }
    if (entry.encrypted && (!password || password.length < 8 || password.length > 1024))
      return resultError('Import password must be between 8 and 1024 characters.');
    const bundle = validateBundle(await decodeBundle(entry.bytes, password));
    const current = stateOf(readSettings());
    const plan = planImport(current, bundle, mode);
    entry.bundle = bundle;
    entry.mode = mode;
    entry.fingerprint = settingsFingerprint(readSettings());
    entry.plan = plan;
    return {
      ok: true,
      summary: plan.summary as ConfigSyncSummary[],
      warnings: plan.warnings,
      mode,
    };
  } catch (error) {
    if (error instanceof ConfigSyncCodecError) {
      return resultError('Incorrect password or damaged configuration package.');
    }
    return resultError(
      error instanceof Error && error.message
        ? error.message
        : 'Unable to apply this configuration package.'
    );
  }
}

export async function commitImportForSender(
  senderId: SenderKey,
  token: string,
  mode: ConfigSyncMode
): Promise<ConfigSyncCommitResult> {
  const entry = assertToken(token, senderId);
  if (!entry?.plan || !entry.bundle || entry.mode !== mode || !entry.fingerprint) {
    return resultError('Import must be previewed before commit.');
  }
  let staged: {
    batchRoot: string;
    skillPaths: Map<string, string>;
    instructionPaths: Map<string, string>;
  } | null = null;
  try {
    staged = stageResources(
      app.getPath('userData'),
      entry.bundle.resources.skills,
      entry.bundle.resources.instructions
    );
    const patch: Record<string, unknown> = {};
    for (const field of SYNC_FIELDS) {
      if (field in entry.plan.state) patch[field] = entry.plan.state[field];
    }
    const skillPathByDestination = new Map<string, string>();
    for (const [sourceId, destinationId] of Object.entries(entry.plan.skillIdMap)) {
      const path = staged.skillPaths.get(sourceId);
      if (path) skillPathByDestination.set(destinationId, path);
    }
    const instructionPathByDestination = new Map<string, string>();
    for (const [sourceId, destinationId] of Object.entries(entry.plan.instructionIdMap)) {
      const path = staged.instructionPaths.get(sourceId);
      if (path) instructionPathByDestination.set(destinationId, path);
    }
    const skills = Array.isArray(patch.skills) ? patch.skills : [];
    patch.skills = skills.map((value) => {
      if (!value || typeof value !== 'object') return value;
      const item = { ...(value as Record<string, unknown>) };
      const path = skillPathByDestination.get(String(item.id));
      if (path) item.path = path;
      return item;
    });
    const instructions = Array.isArray(patch.instructions) ? patch.instructions : [];
    patch.instructions = instructions.map((value) => {
      if (!value || typeof value !== 'object') return value;
      const item = { ...(value as Record<string, unknown>) };
      const path = instructionPathByDestination.get(String(item.id));
      if (path) {
        item.local = false;
        item.sourcePath = path;
        item.bytes = Buffer.byteLength(
          entry.bundle?.resources.instructions.find(
            (resource: { id: string }) =>
              entry.plan?.instructionIdMap[resource.id] === String(item.id)
          )?.content ?? '',
          'utf8'
        );
      }
      return item;
    });
    const committed = commitSettingsTransaction(entry.fingerprint, patch);
    if (!committed.ok) {
      cleanupStagedResources([staged.batchRoot]);
      return resultError(committed.error ?? 'Unable to commit configuration.');
    }
    tokens.delete(token);
    return { ok: true, backupPath: committed.backupPath ?? '', warnings: entry.plan.warnings };
  } catch {
    if (staged) cleanupStagedResources([staged.batchRoot]);
    return resultError('Unable to commit configuration.');
  }
}

export function cancelImportForSender(senderId: SenderKey, token: string): void {
  const entry = tokens.get(token);
  if (entry?.senderId === senderId) tokens.delete(token);
}

export function clearConfigSyncTokens(): void {
  tokens.clear();
}
