import type { SettingsState } from '../renderer/stores/settings/types';
import type { CapabilitySpec, JsonSchema } from '../shared/capabilities/types';
import type { ProductSurfaceId, ProductSurfaceInventoryItem } from '../shared/productSurfaces';
import { BUILTIN_AGENT_TYPES, BUILTIN_TOOLS, type IPC_CHANNELS } from '../shared/types';

export type CoverageDisposition =
  | { kind: 'surface'; surfaceIds: readonly [ProductSurfaceId, ...ProductSurfaceId[]] }
  | { kind: 'excluded'; reason: string };

const surfaces = (
  ...surfaceIds: readonly [ProductSurfaceId, ...ProductSurfaceId[]]
): CoverageDisposition => ({ kind: 'surface', surfaceIds });

const excluded = (reason: string): CoverageDisposition => ({ kind: 'excluded', reason });

type SettingsActionKey = {
  [Key in keyof SettingsState]-?: SettingsState[Key] extends (...args: never[]) => unknown
    ? Key
    : never;
}[keyof SettingsState];

type SettingsDataKey = Exclude<keyof SettingsState, SettingsActionKey>;

/** SettingsState 新增持久字段时，此 Record 会在编译期要求说明对应产品面。 */
export const SETTINGS_DATA_COVERAGE = {
  theme: surfaces('appearance.theme'),
  language: surfaces('general.language'),
  terminalTheme: surfaces('appearance.terminal-theme'),
  terminalFontSize: surfaces('appearance.terminal-font-size'),
  terminalFontFamily: surfaces('appearance.terminal-font-family'),
  terminalFontWeight: surfaces('appearance.terminal-font-weight'),
  terminalFontWeightBold: surfaces('appearance.terminal-bold-weight'),
  favoriteTerminalThemes: surfaces('appearance.favorite-terminal-themes'),
  statusLineSegments: surfaces('appearance.status-line-segments'),
  loadLocalSkills: surfaces('general.load-local-skills'),
  autoUpdate: surfaces('general.automatic-updates'),
  openChangesOnFileEdit: excluded('Renderer side-panel preference; not an Enso capability.'),
  providers: surfaces('providers.list'),
  defaultModel: surfaces('providers.default-model'),
  defaultReasoningEnabled: surfaces('providers.default-model'),
  defaultThinkingLevel: surfaces('providers.default-model'),
  skills: surfaces('skills.list'),
  mcpServers: surfaces('mcp.list'),
  instructions: surfaces('instructions.list'),
  presets: surfaces('presets.list'),
  defaultPresetId: surfaces('presets.set-default'),
  agentTypes: surfaces('agent-types.list'),
  subagentModelsEnabled: surfaces('providers.subagent-models.toggle'),
  subagentModels: surfaces('providers.subagent-models'),
  disabledBuiltinAgentTypes: surfaces('agent-types.toggle-builtin'),
  disabledBuiltinTools: surfaces('tools.toggle-builtin'),
  onboarded: surfaces('onboarding.complete'),
  keybindings: surfaces('general.keybindings.list'),
  projects: surfaces('projects.list'),
  // 背景图属纯外观装饰，目前未开放为面向 Enso 的产品能力（需要时再建 catalog 条目）。
  backgroundImageEnabled: excluded('Appearance-only background decoration.'),
  backgroundSourceType: excluded('Appearance-only background decoration.'),
  backgroundImagePath: excluded('Appearance-only background decoration.'),
  backgroundFolderPath: excluded('Appearance-only background decoration.'),
  backgroundUrlPath: excluded('Appearance-only background decoration.'),
  backgroundRandomEnabled: excluded('Appearance-only background decoration.'),
  backgroundRandomInterval: excluded('Appearance-only background decoration.'),
  backgroundOpacity: excluded('Appearance-only background decoration.'),
  backgroundBlur: excluded('Appearance-only background decoration.'),
  backgroundBrightness: excluded('Appearance-only background decoration.'),
  backgroundSaturation: excluded('Appearance-only background decoration.'),
  backgroundComposerOpacity: excluded('Appearance-only background decoration.'),
  backgroundCodeOpacity: excluded('Appearance-only background decoration.'),
  backgroundSizeMode: excluded('Appearance-only background decoration.'),
  backgroundRefreshNonce: excluded('Internal repaint nonce; not user-facing state.'),
} satisfies Record<SettingsDataKey, CoverageDisposition>;

/** SettingsState 新增 action 时，此 Record 会在编译期要求登记或明确排除。 */
export const SETTINGS_ACTION_COVERAGE = {
  setTheme: surfaces('appearance.theme'),
  setLanguage: surfaces('general.language'),
  setTerminalTheme: surfaces('appearance.terminal-theme'),
  setTerminalFontSize: surfaces('appearance.terminal-font-size'),
  setTerminalFontFamily: surfaces('appearance.terminal-font-family'),
  setTerminalFontWeight: surfaces('appearance.terminal-font-weight'),
  setTerminalFontWeightBold: surfaces('appearance.terminal-bold-weight'),
  toggleFavoriteTerminalTheme: surfaces('appearance.favorite-terminal-themes'),
  setLoadLocalSkills: surfaces('general.load-local-skills'),
  setAutoUpdate: surfaces('general.automatic-updates'),
  setOpenChangesOnFileEdit: excluded('Renderer side-panel preference; not an Enso capability.'),
  setStatusLineSegments: surfaces('appearance.status-line-segments'),
  toggleStatusLineSegment: surfaces('appearance.status-line-segments'),
  setDefaultModel: surfaces('providers.default-model'),
  setDefaultReasoningEnabled: surfaces('providers.default-model'),
  setDefaultThinkingLevel: surfaces('providers.default-model'),
  revalidateDefaultModel: surfaces('providers.default-model'),
  addProviders: surfaces('providers.add', 'providers.import-local'),
  updateProvider: surfaces(
    'providers.update',
    'providers.toggle-provider',
    'providers.toggle-model'
  ),
  removeProvider: surfaces('providers.remove'),
  addSkills: surfaces('skills.import-local'),
  updateSkill: surfaces('skills.toggle'),
  setSkillsEnabled: surfaces('skills.toggle'),
  removeSkill: surfaces('skills.remove'),
  addMcpServers: surfaces('mcp.import-local'),
  updateMcpServer: surfaces('mcp.edit', 'mcp.toggle'),
  setMcpServersEnabled: surfaces('mcp.toggle'),
  removeMcpServer: surfaces('mcp.remove'),
  addInstructions: surfaces('instructions.import-local'),
  updateInstruction: surfaces('instructions.toggle', 'instructions.edit-local-copy'),
  removeInstruction: surfaces('instructions.remove'),
  addPreset: surfaces('presets.create'),
  updatePreset: surfaces('presets.edit'),
  removePreset: surfaces('presets.delete'),
  setDefaultPresetId: surfaces('presets.set-default'),
  setSubagentModelsEnabled: surfaces('providers.subagent-models.toggle'),
  addSubagentModel: surfaces('providers.subagent-models.add'),
  updateSubagentModel: surfaces('providers.subagent-models.update'),
  removeSubagentModel: surfaces('providers.subagent-models.remove'),
  addAgentType: surfaces('agent-types.create'),
  updateAgentType: surfaces('agent-types.edit'),
  removeAgentType: surfaces('agent-types.delete'),
  toggleBuiltinAgentType: surfaces('agent-types.toggle-builtin'),
  toggleBuiltinTool: surfaces('tools.toggle-builtin'),
  setOnboarded: surfaces('onboarding.complete'),
  setKeybinding: surfaces('general.keybindings.set'),
  resetKeybinding: surfaces('general.keybindings.reset'),
  addProject: surfaces('projects.add'),
  removeProject: surfaces('projects.remove'),
  setBackgroundImageEnabled: excluded('Appearance-only background decoration.'),
  setBackgroundSourceType: excluded('Appearance-only background decoration.'),
  setBackgroundImagePath: excluded('Appearance-only background decoration.'),
  setBackgroundFolderPath: excluded('Appearance-only background decoration.'),
  setBackgroundUrlPath: excluded('Appearance-only background decoration.'),
  setBackgroundRandomEnabled: excluded('Appearance-only background decoration.'),
  setBackgroundRandomInterval: excluded('Appearance-only background decoration.'),
  setBackgroundOpacity: excluded('Appearance-only background decoration.'),
  setBackgroundBlur: excluded('Appearance-only background decoration.'),
  setBackgroundBrightness: excluded('Appearance-only background decoration.'),
  setBackgroundSaturation: excluded('Appearance-only background decoration.'),
  setBackgroundComposerOpacity: excluded('Appearance-only background decoration.'),
  setBackgroundCodeOpacity: excluded('Appearance-only background decoration.'),
  setBackgroundSizeMode: excluded('Appearance-only background decoration.'),
  bumpBackgroundRefresh: excluded('Internal repaint nonce; not user-facing state.'),
} satisfies Record<SettingsActionKey, CoverageDisposition>;

export const BUILTIN_TOOL_COVERAGE: Readonly<Record<string, CoverageDisposition>> = {
  subagent: surfaces('coding-tools.subagent'),
  coworker: surfaces('coding-tools.coworker', 'team.list-coworkers'),
  todo: surfaces('coding-tools.todo'),
  ask_user: surfaces('coding-tools.ask-user'),
  background_tasks: surfaces('coding-tools.background-task'),
};

export const BUILTIN_AGENT_TYPE_COVERAGE: Readonly<Record<string, CoverageDisposition>> = {
  scout: surfaces('agent-types.list', 'team.list-agent-types'),
  worker: surfaces('agent-types.list', 'team.list-agent-types'),
  reviewer: surfaces('agent-types.list', 'team.list-agent-types'),
};

/** 每条 IPC 单独登记；传输/lifecycle 必须逐项给出排除理由，不按目录 blanket 排除。 */
export const IPC_PRODUCT_COVERAGE = {
  SETTINGS_READ: excluded('Internal persistence read; Enso uses typed domain handlers.'),
  SETTINGS_WRITE: excluded('Raw whole-settings write is forbidden to Enso.'),
  SETTINGS_WRITE_KEY: excluded('Raw store-key write is replaced by controlled field patches.'),
  SETTINGS_CHANGED: excluded('Cross-window persistence notification transport.'),
  WINDOW_MINIMIZE: surfaces('window.minimize'),
  WINDOW_MAXIMIZE: surfaces('window.maximize'),
  WINDOW_CLOSE: surfaces('window.close'),
  WINDOW_IS_MAXIMIZED: excluded('Renderer window-state query, not a user product action.'),
  WINDOW_IS_FULLSCREEN: excluded('Renderer window-state query, not a user product action.'),
  WINDOW_MAXIMIZED_CHANGED: excluded('Renderer window-state event transport.'),
  WINDOW_FULLSCREEN_CHANGED: excluded('Renderer fullscreen-state event transport.'),
  WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE: excluded('macOS title-bar implementation detail.'),
  WINDOW_OPEN_SETTINGS: surfaces('window.open-settings'),
  PROVIDERS_SCAN_LOCAL: surfaces('providers.import-local'),
  PROVIDERS_COLLECT_IMPORT: excluded('Second phase of the reviewed provider import flow.'),
  PROVIDERS_LIST_MODELS: surfaces('providers.fetch-models'),
  PROVIDERS_TEST: surfaces('providers.test-connection'),
  PROVIDERS_MODEL_META: surfaces('providers.model-meta'),
  OAUTH_PROVIDERS_LIST: surfaces('providers.oauth.list'),
  OAUTH_LOGIN: surfaces('providers.oauth.login'),
  OAUTH_LOGIN_RESPOND: excluded(
    'Protected OAuth flow prompt transport, not a standalone capability.'
  ),
  OAUTH_LOGIN_CANCEL: surfaces('providers.oauth.cancel-login'),
  OAUTH_LOGIN_REOPEN: surfaces('providers.oauth.reopen-login'),
  OAUTH_LOGOUT: surfaces('providers.oauth.logout'),
  OAUTH_LOGIN_EVENT: excluded('Protected OAuth flow progress transport.'),
  OAUTH_ACCOUNT_INFO: surfaces('providers.oauth.usage'),
  OAUTH_CREDENTIAL_KEYS_LIST: excluded(
    'Renderer bootstrap for public OAuth account keys; no credential values are exposed.'
  ),
  OAUTH_CREDENTIALS_CHANGED: excluded(
    'Cross-window OAuth credential invalidation transport; refresh resolves the product state.'
  ),
  ASSETS_SCAN_LOCAL: surfaces(
    'skills.import-local',
    'mcp.import-local',
    'instructions.import-local'
  ),
  ASSETS_COLLECT_IMPORT: excluded('Second phase of the reviewed asset import flow.'),
  ASSETS_LIST_PROJECT_SKILLS: surfaces('skills.list'),
  INSTRUCTIONS_READ: surfaces('instructions.read'),
  INSTRUCTIONS_WRITE: surfaces('instructions.edit-local-copy'),
  INSTRUCTIONS_WRITE_SOURCE: surfaces('instructions.overwrite-source'),
  INSTRUCTIONS_DELETE: surfaces('instructions.remove'),
  AGENT_SPAWN: excluded('Lazy worker lifecycle command behind conversation send.'),
  AGENT_PROMPT: surfaces('conversations.send'),
  AGENT_STEER: surfaces('conversations.queue.send-now'),
  AGENT_ABORT: surfaces('conversations.abort'),
  AGENT_ABORT_RETRY: surfaces('conversations.abort'),
  AGENT_RETRY: surfaces('conversations.retry-turn'),
  AGENT_EVENT: excluded('Worker-to-renderer event stream transport.'),
  AGENT_SNAPSHOT: excluded('Worker recovery/debug snapshot transport.'),
  AGENT_CHILD_HISTORY_READ: excluded(
    'Read-only replay of an ended child safe journal; no product capability, no execution rights.'
  ),
  AGENT_SET_MODEL: surfaces('conversations.set-model'),
  AGENT_SET_THINKING: surfaces('conversations.set-thinking'),
  AGENT_SET_REASONING: surfaces('conversations.set-reasoning'),
  AGENT_APPROVAL_RESPOND: surfaces('conversations.approval.respond'),
  AGENT_SET_APPROVAL_MODE: surfaces('conversations.set-approval-mode'),
  NOTIFICATION_FOCUS_SESSION: surfaces('window.focus-conversation-notification'),
  NOTIFICATION_ACTIVE_SESSION: excluded(
    'Renderer reports the currently viewed conversation id so Main can suppress redundant system notifications; no execution rights.'
  ),
  AGENT_TASK_STOP: surfaces('conversations.background-task.stop'),
  AGENT_REWIND: surfaces('conversations.rewind', 'conversations.rewind-files'),
  AGENT_DISMISS_COWORKER: surfaces('team.dismiss-coworker'),
  AGENT_HIRE_COWORKER: surfaces('team.hire-coworker'),
  AGENT_ASK_RESPOND: surfaces('conversations.ask.respond'),
  AGENT_RELEASE: surfaces('conversations.worktree.release'),
  WORKTREE_CREATE: surfaces('conversations.worktree.create'),
  WORKTREE_GET: surfaces('conversations.worktree.status'),
  WORKTREE_LIST: surfaces('conversations.worktree.status'),
  WORKTREE_STATUS: surfaces('conversations.worktree.status'),
  WORKTREE_REMOVE: surfaces('conversations.worktree.remove'),
  WORKTREE_REBUILD: surfaces('conversations.worktree.rebuild'),
  WORKTREE_REPO_CLEAN: surfaces('conversations.worktree.status'),
  AGENT_TYPES_REGISTRY_LIST: surfaces('agent-types.list'),
  AGENT_MODEL_SELECTION_REGISTER: excluded(
    'Renderer submits only model selector ids; Main validates and signs selection binding.'
  ),
  AGENT_DISPATCH_BIND_SOURCE: excluded('One-time sender-bound dispatch authorization transport.'),
  AGENT_DISPATCH: surfaces('team.hire-coworker'),
  AGENT_DISPATCH_EVENT: excluded('Main-owned dispatch phase and terminal event transport.'),
  AGENT_SUMMON: excluded('Cross-window summon only focuses MainWindow and prefills a type chip.'),
  AGENT_COMPOSER_PREFILL: excluded('Main-to-renderer typed Agent composer prefill event.'),
  SOURCE_AUTHORITY_READ: excluded('Main-owned source authority projection read transport.'),
  SOURCE_AUTHORITY_CHANGED: excluded('Main-owned source authority projection broadcast.'),
  SOURCE_PROJECT_CREATE: surfaces('projects.add'),
  SOURCE_PROJECT_SELECT: excluded('Main-owned active project selection transport.'),
  SOURCE_PROJECT_REMOVE: surfaces('projects.remove'),
  SOURCE_CONVERSATION_CREATE: surfaces('conversations.create'),
  SOURCE_CONVERSATION_SELECT: surfaces('conversations.select'),
  SOURCE_CONVERSATION_END: surfaces('conversations.delete'),
  SOURCE_CONVERSATION_REMOVE: surfaces('conversations.delete'),
  SOURCE_CONVERSATION_UPDATE_SELECTION: surfaces('conversations.set-model'),
  CAPABILITIES_ASK: excluded('Enso child approval request transport owned by CapabilityGateway.'),
  CAPABILITIES_RESPOND: excluded(
    'Enso child approval response transport owned by CapabilityGateway.'
  ),
  DIALOG_SELECT_DIRECTORY: surfaces('projects.add'),
  PROJECTS_GET_RECENT: surfaces('projects.recent'),
  FILES_SEARCH: surfaces('conversations.file-mention.attach'),
  FILES_READ: excluded('Internal bounded file reader used by reviewed UI flows.'),
  GIT_DIFF_HEAD: excluded('Internal git working-tree reader for the Changes panel.'),
  SESSIONS_SCAN_EXTERNAL: surfaces('conversations.import-external'),
  SESSIONS_READ_EXTERNAL: excluded('Preview phase of the external conversation import flow.'),
  SESSIONS_IMPORT_EXTERNAL: surfaces('conversations.import-external'),
  UPDATER_CHECK: surfaces('updates.check'),
  UPDATER_DOWNLOAD_UPDATE: surfaces('updates.download'),
  UPDATER_QUIT_AND_INSTALL: surfaces('updates.install'),
  UPDATER_SET_AUTO_UPDATE_ENABLED: surfaces('general.automatic-updates'),
  UPDATER_STATUS: surfaces('updates.status'),
  DIALOG_SELECT_FILE: excluded('Native file picker; user-driven OS dialog.'),
  FILES_LIST_MEDIA: excluded('Renderer media listing for background picker.'),
  PAIR_CANCEL: excluded('Phone second-screen pairing transport; not an Enso capability.'),
  PAIR_CATALOG: excluded('Phone second-screen pairing transport; not an Enso capability.'),
  PAIR_RESUME_SESSION: excluded('Phone second-screen pairing transport; not an Enso capability.'),
  PAIR_REVOKE: excluded('Phone second-screen pairing transport; not an Enso capability.'),
  PAIR_SESSION_CREATED: excluded('Phone second-screen pairing transport; not an Enso capability.'),
  PAIR_SET_RELAY: excluded('Phone second-screen pairing transport; not an Enso capability.'),
  PAIR_START: excluded('Phone second-screen pairing transport; not an Enso capability.'),
  PAIR_STATUS: excluded('Phone second-screen pairing transport; not an Enso capability.'),
  PAIR_STATUS_CHANGED: excluded('Phone second-screen pairing transport; not an Enso capability.'),
  PAIR_SESSION_CONFIG: excluded('Phone second-screen pairing transport; not an Enso capability.'),
  TERMINAL_CREATE: excluded('Side panel terminal pty transport; renderer UI only.'),
  TERMINAL_WRITE: excluded('Side panel terminal pty transport; renderer UI only.'),
  TERMINAL_RESIZE: excluded('Side panel terminal pty transport; renderer UI only.'),
  TERMINAL_DISPOSE: excluded('Side panel terminal pty transport; renderer UI only.'),
  TERMINAL_DATA: excluded('Side panel terminal pty transport; renderer UI only.'),
  TERMINAL_EXIT: excluded('Side panel terminal pty transport; renderer UI only.'),
  SSH_CONNECTIONS_LIST: surfaces('projects.ssh-connections'),
  SSH_CONNECTIONS_UPSERT: surfaces(
    'projects.ssh-connections.add',
    'projects.ssh-connections.update'
  ),
  SSH_CONNECTIONS_DELETE: surfaces('projects.ssh-connections.remove'),
  SSH_CONNECTIONS_TEST: surfaces('projects.ssh-connections.test'),
  SSH_CONNECTIONS_LIST_DIRS: excluded(
    'Remote directory browsing helper for the add-project picker.'
  ),
} satisfies Record<keyof typeof IPC_CHANNELS, CoverageDisposition>;

export const AUTHORITATIVE_COVERAGE_SOURCES = {
  settingsData: SETTINGS_DATA_COVERAGE,
  settingsActions: SETTINGS_ACTION_COVERAGE,
  builtinTools: BUILTIN_TOOL_COVERAGE,
  builtinAgentTypes: BUILTIN_AGENT_TYPE_COVERAGE,
  ipc: IPC_PRODUCT_COVERAGE,
} as const;

export const BUILTIN_TOOL_IDS = BUILTIN_TOOLS.map((tool) => tool.id);
export const BUILTIN_AGENT_TYPE_IDS = BUILTIN_AGENT_TYPES.map((agentType) => agentType.name);

export function matchesJsonSchema(schema: JsonSchema, value: unknown): boolean {
  if (schema.enum && !schema.enum.some((entry) => entry === value)) return false;
  switch (schema.type) {
    case undefined:
      return true;
    case 'string':
      return (
        typeof value === 'string' &&
        (schema.minLength === undefined || value.length >= schema.minLength)
      );
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema.minimum === undefined || value >= schema.minimum)
      );
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        (schema.minimum === undefined || value >= schema.minimum)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array': {
      if (!Array.isArray(value)) return false;
      if (
        schema.uniqueItems &&
        new Set(value.map((item) => JSON.stringify(item))).size !== value.length
      ) {
        return false;
      }
      if (!schema.items) return true;
      const itemSchema = schema.items;
      return value.every((item) => matchesJsonSchema(itemSchema, item));
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const candidate = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      if (schema.required?.some((key) => !Object.hasOwn(candidate, key))) return false;
      if (
        schema.additionalProperties === false &&
        Object.keys(candidate).some((key) => !Object.hasOwn(properties, key))
      ) {
        return false;
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (Object.hasOwn(candidate, key) && !matchesJsonSchema(propertySchema, candidate[key])) {
          return false;
        }
      }
      for (const [key, dependents] of Object.entries(schema.dependentRequired ?? {})) {
        if (
          Object.hasOwn(candidate, key) &&
          dependents.some((dependent) => !Object.hasOwn(candidate, dependent))
        ) {
          return false;
        }
      }
      return true;
    }
  }
}

export function auditAuthorityCoverage(
  authorityIds: readonly string[],
  coverage: Readonly<Record<string, CoverageDisposition>>
): string[] {
  const issues: string[] = [];
  for (const id of authorityIds) {
    if (!coverage[id]) issues.push(`missing authority coverage: ${id}`);
  }
  for (const id of Object.keys(coverage)) {
    if (!authorityIds.includes(id)) issues.push(`coverage outside authority: ${id}`);
  }
  return issues;
}

export interface CapabilityAuditInput {
  inventory: Readonly<Record<string, ProductSurfaceInventoryItem>>;
  catalog: Readonly<Record<string, CapabilitySpec>>;
  handlerIds: ReadonlySet<string>;
}

export function auditCapabilityContract(input: CapabilityAuditInput): string[] {
  const issues: string[] = [];
  for (const id of Object.keys(input.inventory)) {
    const spec = input.catalog[id];
    if (!spec) {
      issues.push(`missing catalog: ${id}`);
      continue;
    }
    if (spec.id !== id) issues.push(`catalog id mismatch: ${id}`);
    if (spec.execution.kind === 'executable') {
      if (!input.handlerIds.has(spec.execution.handlerId)) {
        issues.push(`missing handler: ${spec.execution.handlerId}`);
      }
    } else {
      if (!spec.execution.reason.trim()) issues.push(`empty unavailable reason: ${id}`);
      if (!spec.execution.suggestedAction.trim()) {
        issues.push(`empty unavailable action: ${id}`);
      }
    }
  }
  for (const id of Object.keys(input.catalog)) {
    if (!input.inventory[id]) issues.push(`catalog outside inventory: ${id}`);
    if (id.includes(':') || id === 'worker-exited' || id === 'snapshot') {
      issues.push(`internal transport in catalog: ${id}`);
    }
  }
  return issues;
}
