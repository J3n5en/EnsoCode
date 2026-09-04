import { PRODUCT_SURFACE_INVENTORY, type ProductSurfaceId } from '../productSurfaces';
import { STATUS_LINE_SEGMENT_IDS } from '../statusLine';
import { BUILTIN_AGENT_TYPES, BUILTIN_TOOLS } from '../types';
import type {
  AvailabilityRequirement,
  CapabilityRisk,
  CapabilitySpec,
  JsonSchema,
  TargetContext,
} from './types';

const NO_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const satisfies JsonSchema;

const ID_INPUT_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 1 } },
  required: ['id'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const ID_ENABLED_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
  },
  required: ['id', 'enabled'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const BOOLEAN_VALUE_INPUT_SCHEMA = {
  type: 'object',
  properties: { value: { type: 'boolean' } },
  required: ['value'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const STRING_VALUE_INPUT_SCHEMA = {
  type: 'object',
  properties: { value: { type: 'string', minLength: 1 } },
  required: ['value'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const THEME_VALUE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    value: { type: 'string', enum: ['light', 'dark', 'system', 'sync-terminal'] },
  },
  required: ['value'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const LANGUAGE_VALUE_INPUT_SCHEMA = {
  type: 'object',
  properties: { value: { type: 'string', enum: ['en', 'zh'] } },
  required: ['value'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const FONT_WEIGHT_VALUES = [
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

const FONT_WEIGHT_VALUE_INPUT_SCHEMA = {
  type: 'object',
  properties: { value: { type: 'string', enum: FONT_WEIGHT_VALUES } },
  required: ['value'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const FONT_SIZE_VALUE_INPUT_SCHEMA = {
  type: 'object',
  properties: { value: { type: 'number', minimum: 8 } },
  required: ['value'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const STRING_ARRAY_VALUE_INPUT_SCHEMA = {
  type: 'object',
  properties: { value: { type: 'array', items: { type: 'string', minLength: 1 } } },
  required: ['value'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const STATUS_LINE_VALUE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    value: {
      type: 'array',
      items: { type: 'string', enum: STATUS_LINE_SEGMENT_IDS },
      uniqueItems: true,
    },
  },
  required: ['value'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const KEYBINDING_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', minLength: 1 },
    binding: { type: 'string', minLength: 1 },
  },
  required: ['action', 'binding'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const KEYBINDING_ACTION_INPUT_SCHEMA = {
  type: 'object',
  properties: { action: { type: 'string', minLength: 1 } },
  required: ['action'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const MODEL_REF_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    providerId: { type: 'string', minLength: 1 },
    modelId: { type: 'string', minLength: 1 },
  },
  required: ['providerId', 'modelId'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const PROVIDER_MODEL_TOGGLE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    providerId: { type: 'string', minLength: 1 },
    modelId: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
  },
  required: ['providerId', 'modelId', 'enabled'],
  additionalProperties: false,
} as const satisfies JsonSchema;

/** 条目级推理覆盖：'follow' 表示清除覆盖回到跟随父会话（存储层不落 'follow'） */
const SUBAGENT_MODEL_FIELDS = {
  providerId: { type: 'string', minLength: 1 },
  modelId: { type: 'string', minLength: 1 },
  description: { type: 'string' },
  reasoning: { type: 'string', enum: ['on', 'off', 'follow'] },
  thinkingLevel: {
    type: 'string',
    enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'follow'],
  },
} as const satisfies Readonly<Record<string, JsonSchema>>;

const SUBAGENT_MODEL_ADD_INPUT_SCHEMA = {
  type: 'object',
  properties: SUBAGENT_MODEL_FIELDS,
  required: ['providerId', 'modelId'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const SUBAGENT_MODEL_UPDATE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ...SUBAGENT_MODEL_FIELDS,
  },
  required: ['id'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const ACCOUNT_INPUT_SCHEMA = {
  type: 'object',
  properties: { accountKey: { type: 'string', minLength: 1 } },
  required: ['accountKey'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const PROVIDER_ID_INPUT_SCHEMA = {
  type: 'object',
  properties: { providerId: { type: 'string', minLength: 1 } },
  required: ['providerId'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const CONTENT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    content: { type: 'string' },
  },
  required: ['id', 'content'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const HIRE_COWORKER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    agentType: { type: 'string', minLength: 1 },
  },
  required: ['name'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const STRING_ID_ARRAY_SCHEMA = {
  type: 'array',
  items: { type: 'string', minLength: 1 },
} as const satisfies JsonSchema;

const PRESET_FIELDS = {
  name: { type: 'string', minLength: 1 },
  skillIds: STRING_ID_ARRAY_SCHEMA,
  mcpServerIds: STRING_ID_ARRAY_SCHEMA,
  instructionId: { type: 'string', minLength: 1 },
} as const satisfies Readonly<Record<string, JsonSchema>>;

const PRESET_CREATE_INPUT_SCHEMA = {
  type: 'object',
  properties: PRESET_FIELDS,
  required: ['name'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const PRESET_EDIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ...PRESET_FIELDS,
  },
  required: ['id'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const AGENT_TYPE_FIELDS = {
  name: { type: 'string', minLength: 1 },
  description: { type: 'string' },
  systemPrompt: { type: 'string' },
  tools: { type: 'string', enum: ['readonly', 'all'] },
  modelMode: { type: 'string', enum: ['agent_pick', 'follow', 'fixed'] },
  providerId: { type: 'string', minLength: 1 },
  modelId: { type: 'string', minLength: 1 },
  skillIds: STRING_ID_ARRAY_SCHEMA,
  mcpServerIds: STRING_ID_ARRAY_SCHEMA,
} as const satisfies Readonly<Record<string, JsonSchema>>;

const AGENT_TYPE_MODEL_PAIR = {
  providerId: ['modelId'],
  modelId: ['providerId'],
} as const;

const AGENT_TYPE_CREATE_INPUT_SCHEMA = {
  type: 'object',
  properties: AGENT_TYPE_FIELDS,
  required: ['name'],
  dependentRequired: AGENT_TYPE_MODEL_PAIR,
  additionalProperties: false,
} as const satisfies JsonSchema;

const AGENT_TYPE_EDIT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ...AGENT_TYPE_FIELDS,
  },
  required: ['id'],
  dependentRequired: AGENT_TYPE_MODEL_PAIR,
  additionalProperties: false,
} as const satisfies JsonSchema;

const DISMISS_COWORKER_INPUT_SCHEMA = {
  type: 'object',
  properties: { coworkerId: { type: 'string', minLength: 1 } },
  required: ['coworkerId'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const BUILTIN_TOOL_TOGGLE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', enum: BUILTIN_TOOLS.map((tool) => tool.id) },
    enabled: { type: 'boolean' },
  },
  required: ['id', 'enabled'],
  additionalProperties: false,
} as const satisfies JsonSchema;

const BUILTIN_AGENT_TYPE_TOGGLE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', enum: BUILTIN_AGENT_TYPES.map((type) => type.name) },
    enabled: { type: 'boolean' },
  },
  required: ['id', 'enabled'],
  additionalProperties: false,
} as const satisfies JsonSchema;

interface ExecutableOptions {
  description: string;
  risk: CapabilityRisk;
  targetContext: TargetContext;
  inputSchema?: JsonSchema;
  availability?: readonly AvailabilityRequirement[];
}

function executable<Id extends ProductSurfaceId>(
  id: Id,
  options: ExecutableOptions
): CapabilitySpec<Id, Id> & { execution: { kind: 'executable'; handlerId: Id } } {
  return {
    id,
    domain: PRODUCT_SURFACE_INVENTORY[id].domain,
    description: options.description,
    inputSchema: options.inputSchema ?? NO_INPUT_SCHEMA,
    risk: options.risk,
    targetContext: options.targetContext,
    availability: options.availability ?? [],
    execution: { kind: 'executable', handlerId: id },
  };
}

interface UnavailableOptions extends ExecutableOptions {
  reason: string;
  suggestedAction: string;
}

function unavailable<Id extends ProductSurfaceId>(
  id: Id,
  options: UnavailableOptions
): CapabilitySpec<Id, never> & {
  execution: { kind: 'known-unavailable'; reason: string; suggestedAction: string };
} {
  return {
    id,
    domain: PRODUCT_SURFACE_INVENTORY[id].domain,
    description: options.description,
    inputSchema: options.inputSchema ?? NO_INPUT_SCHEMA,
    risk: options.risk,
    targetContext: options.targetContext,
    availability: options.availability ?? [],
    execution: {
      kind: 'known-unavailable',
      reason: options.reason,
      suggestedAction: options.suggestedAction,
    },
  };
}

const reversibleGlobal = (description: string, inputSchema: JsonSchema = NO_INPUT_SCHEMA) => ({
  description,
  risk: 'reversible' as const,
  targetContext: 'global' as const,
  inputSchema,
});

const readGlobal = (description: string, inputSchema: JsonSchema = NO_INPUT_SCHEMA) => ({
  description,
  risk: 'read' as const,
  targetContext: 'global' as const,
  inputSchema,
});

export const CAPABILITY_CATALOG = {
  'general.language': executable(
    'general.language',
    reversibleGlobal('Read or change the UI language.', LANGUAGE_VALUE_INPUT_SCHEMA)
  ),
  'general.load-local-skills': executable(
    'general.load-local-skills',
    reversibleGlobal(
      'Read or change whether coding sessions discover local skills.',
      BOOLEAN_VALUE_INPUT_SCHEMA
    )
  ),
  'general.load-harness-assets': executable(
    'general.load-harness-assets',
    reversibleGlobal(
      'Read or change whether coding sessions also load skills and rule files from project-level .claude/.codex/.cursor directories.',
      BOOLEAN_VALUE_INPUT_SCHEMA
    )
  ),
  'general.automatic-updates': executable(
    'general.automatic-updates',
    reversibleGlobal('Read or change automatic update downloads.', BOOLEAN_VALUE_INPUT_SCHEMA)
  ),
  'general.proxy-mode': executable(
    'general.proxy-mode',
    reversibleGlobal('Read or change the application network proxy mode.', {
      type: 'object',
      properties: { value: { type: 'string', enum: ['system', 'none', 'custom'] } },
      required: ['value'],
      additionalProperties: false,
    })
  ),
  'general.custom-proxy-url': executable(
    'general.custom-proxy-url',
    reversibleGlobal('Read or change the custom HTTP(S) proxy URL.', STRING_VALUE_INPUT_SCHEMA)
  ),
  'general.keybindings.list': executable(
    'general.keybindings.list',
    readGlobal('List effective application keybindings.')
  ),
  'general.keybindings.set': executable('general.keybindings.set', {
    ...reversibleGlobal('Override one application keybinding.', KEYBINDING_INPUT_SCHEMA),
  }),
  'general.keybindings.reset': executable('general.keybindings.reset', {
    ...reversibleGlobal('Reset one application keybinding.', KEYBINDING_ACTION_INPUT_SCHEMA),
  }),

  'appearance.theme': executable(
    'appearance.theme',
    reversibleGlobal('Read or change the application theme.', THEME_VALUE_INPUT_SCHEMA)
  ),
  'appearance.terminal-theme': executable(
    'appearance.terminal-theme',
    reversibleGlobal('Read or change the terminal color theme.', STRING_VALUE_INPUT_SCHEMA)
  ),
  'appearance.terminal-font-size': executable(
    'appearance.terminal-font-size',
    reversibleGlobal('Read or change the terminal font size.', FONT_SIZE_VALUE_INPUT_SCHEMA)
  ),
  'appearance.terminal-font-family': executable(
    'appearance.terminal-font-family',
    reversibleGlobal('Read or change the terminal font family.', STRING_VALUE_INPUT_SCHEMA)
  ),
  'appearance.terminal-font-weight': executable(
    'appearance.terminal-font-weight',
    reversibleGlobal('Read or change the terminal font weight.', FONT_WEIGHT_VALUE_INPUT_SCHEMA)
  ),
  'appearance.terminal-bold-weight': executable(
    'appearance.terminal-bold-weight',
    reversibleGlobal(
      'Read or change the terminal bold font weight.',
      FONT_WEIGHT_VALUE_INPUT_SCHEMA
    )
  ),
  'appearance.favorite-terminal-themes': executable(
    'appearance.favorite-terminal-themes',
    reversibleGlobal('Read or change favorite terminal themes.', STRING_ARRAY_VALUE_INPUT_SCHEMA)
  ),
  'appearance.status-line-segments': executable(
    'appearance.status-line-segments',
    reversibleGlobal(
      'Read, reorder, enable, or disable status line segments.',
      STATUS_LINE_VALUE_INPUT_SCHEMA
    )
  ),

  'providers.list': executable(
    'providers.list',
    readGlobal('List configured providers and enabled models without secrets.')
  ),
  'providers.import-local': unavailable('providers.import-local', {
    ...readGlobal('Scan local AI applications and import selected providers.'),
    risk: 'dangerous',
    reason:
      'The import flow may discover credentials and requires an explicit candidate review UI.',
    suggestedAction: 'Open Model Providers and use Import from local apps.',
  }),
  'providers.add': unavailable('providers.add', {
    ...reversibleGlobal('Add a subscription or API-key provider.'),
    risk: 'dangerous',
    reason: 'API keys must never enter Enso context; provider setup uses the protected setup flow.',
    suggestedAction: 'Open Model Providers and choose Add model or provider.',
  }),
  'providers.update': unavailable('providers.update', {
    ...reversibleGlobal('Edit provider API settings.'),
    reason: 'Editing provider credentials could expose a plaintext key to Enso.',
    suggestedAction: 'Edit the provider in Model Providers.',
  }),
  'providers.remove': executable('providers.remove', {
    description: 'Remove one provider entry; subscription entries are signed out first.',
    risk: 'dangerous',
    targetContext: 'global',
    inputSchema: ID_INPUT_SCHEMA,
  }),
  'providers.fetch-models': executable('providers.fetch-models', {
    ...readGlobal(
      'Fetch available model ids using an already configured provider.',
      PROVIDER_ID_INPUT_SCHEMA
    ),
    availability: [{ kind: 'configured-provider' }],
  }),
  'providers.test-connection': executable('providers.test-connection', {
    ...readGlobal(
      'Test an already configured provider; this may make a minimal billable request.',
      MODEL_REF_INPUT_SCHEMA
    ),
    risk: 'dangerous',
    availability: [{ kind: 'configured-provider' }],
  }),
  'providers.model-meta': executable(
    'providers.model-meta',
    readGlobal('Read cached or discoverable model capability metadata.', MODEL_REF_INPUT_SCHEMA)
  ),
  'providers.toggle-provider': executable(
    'providers.toggle-provider',
    reversibleGlobal('Enable or disable one provider entry.', ID_ENABLED_INPUT_SCHEMA)
  ),
  'providers.toggle-model': executable(
    'providers.toggle-model',
    reversibleGlobal('Enable or disable one model entry.', PROVIDER_MODEL_TOGGLE_INPUT_SCHEMA)
  ),
  'providers.default-model': executable('providers.default-model', {
    ...reversibleGlobal('Set or clear the global default model.', MODEL_REF_INPUT_SCHEMA),
    availability: [{ kind: 'configured-provider' }],
  }),
  'providers.subagent-models': executable(
    'providers.subagent-models',
    readGlobal('List subagent model entries and whether the feature is enabled.')
  ),
  'providers.subagent-models.toggle': executable(
    'providers.subagent-models.toggle',
    reversibleGlobal(
      'Enable or disable letting the agent pick subagent models.',
      BOOLEAN_VALUE_INPUT_SCHEMA
    )
  ),
  'providers.subagent-models.add': executable(
    'providers.subagent-models.add',
    reversibleGlobal(
      'Add one subagent model entry with optional guidance text and reasoning override.',
      SUBAGENT_MODEL_ADD_INPUT_SCHEMA
    )
  ),
  'providers.subagent-models.update': executable(
    'providers.subagent-models.update',
    reversibleGlobal(
      'Edit one subagent model entry; "follow" clears a reasoning override.',
      SUBAGENT_MODEL_UPDATE_INPUT_SCHEMA
    )
  ),
  'providers.subagent-models.remove': executable('providers.subagent-models.remove', {
    ...reversibleGlobal('Remove one subagent model entry.', ID_INPUT_SCHEMA),
  }),
  'providers.oauth.list': executable(
    'providers.oauth.list',
    readGlobal('List subscription providers and signed-in account metadata without tokens.')
  ),
  'providers.oauth.login': executable('providers.oauth.login', {
    description: 'Start the protected subscription authorization flow.',
    risk: 'dangerous',
    targetContext: 'origin-window',
    inputSchema: PROVIDER_ID_INPUT_SCHEMA,
    availability: [{ kind: 'origin-window' }, { kind: 'oauth-provider' }],
  }),
  'providers.oauth.logout': executable('providers.oauth.logout', {
    description: 'Sign out one subscription account.',
    risk: 'dangerous',
    targetContext: 'global',
    inputSchema: ACCOUNT_INPUT_SCHEMA,
  }),
  'providers.oauth.usage': executable(
    'providers.oauth.usage',
    readGlobal('Read subscription quota windows for one account.', ACCOUNT_INPUT_SCHEMA)
  ),
  'providers.oauth.cancel-login': executable('providers.oauth.cancel-login', {
    description: 'Cancel the active subscription authorization flow.',
    risk: 'reversible',
    targetContext: 'origin-window',
    availability: [{ kind: 'origin-window' }],
  }),
  'providers.oauth.reopen-login': executable('providers.oauth.reopen-login', {
    description: 'Reopen the authorization page for the active subscription login.',
    risk: 'dangerous',
    targetContext: 'origin-window',
    availability: [{ kind: 'origin-window' }],
  }),

  'skills.list': executable('skills.list', readGlobal('List registered skills and enabled state.')),
  'skills.import-local': unavailable('skills.import-local', {
    ...readGlobal('Scan local applications and import selected skills.'),
    reason: 'Import requires reviewing filesystem-derived candidates before registration.',
    suggestedAction: 'Open Skills and use Import.',
  }),
  'skills.toggle': executable(
    'skills.toggle',
    reversibleGlobal('Enable or disable a registered skill.', ID_ENABLED_INPUT_SCHEMA)
  ),
  'skills.remove': executable('skills.remove', {
    description: 'Remove a skill registration without deleting its source directory.',
    risk: 'dangerous',
    targetContext: 'global',
    inputSchema: ID_INPUT_SCHEMA,
  }),

  'mcp.list': executable(
    'mcp.list',
    readGlobal('List MCP registrations without environment values.')
  ),
  'mcp.import-local': unavailable('mcp.import-local', {
    ...readGlobal('Scan local applications and import selected MCP registrations.'),
    reason: 'MCP imports may contain environment secrets and require a protected review flow.',
    suggestedAction: 'Open MCP Servers and use Import.',
  }),
  'mcp.edit': unavailable('mcp.edit', {
    ...reversibleGlobal('Edit an MCP server registration.'),
    reason: 'MCP environment values must not enter Enso context.',
    suggestedAction: 'Edit the server in MCP Servers.',
  }),
  'mcp.toggle': executable(
    'mcp.toggle',
    reversibleGlobal('Enable or disable an MCP registration.', ID_ENABLED_INPUT_SCHEMA)
  ),
  'mcp.remove': executable('mcp.remove', {
    description: 'Remove an MCP server registration.',
    risk: 'dangerous',
    targetContext: 'global',
    inputSchema: ID_INPUT_SCHEMA,
  }),

  'instructions.list': executable(
    'instructions.list',
    readGlobal('List registered instruction files and active state.')
  ),
  'instructions.import-local': unavailable('instructions.import-local', {
    ...readGlobal('Scan local applications and import instruction registrations.'),
    reason: 'Import requires reviewing filesystem-derived candidates before registration.',
    suggestedAction: 'Open Instruction Files and use Import.',
  }),
  'instructions.toggle': executable(
    'instructions.toggle',
    reversibleGlobal('Select the active instruction registration.', ID_ENABLED_INPUT_SCHEMA)
  ),
  'instructions.read': executable(
    'instructions.read',
    readGlobal(
      'Read one registered instruction through its controlled registration id.',
      ID_INPUT_SCHEMA
    )
  ),
  'instructions.edit-local-copy': executable(
    'instructions.edit-local-copy',
    reversibleGlobal(
      'Save content to the application-managed local instruction copy.',
      CONTENT_INPUT_SCHEMA
    )
  ),
  'instructions.overwrite-source': unavailable('instructions.overwrite-source', {
    description: 'Overwrite the original instruction source file.',
    risk: 'dangerous',
    targetContext: 'global',
    inputSchema: CONTENT_INPUT_SCHEMA,
    reason: 'Enso is not allowed to write arbitrary source files.',
    suggestedAction: 'Use Overwrite original in Instruction Files after reviewing the target path.',
  }),
  'instructions.remove': executable('instructions.remove', {
    description: 'Remove an instruction registration and its application-managed local copy.',
    risk: 'dangerous',
    targetContext: 'global',
    inputSchema: ID_INPUT_SCHEMA,
  }),

  'presets.list': executable('presets.list', readGlobal('List injection presets.')),
  'presets.create': executable(
    'presets.create',
    reversibleGlobal(
      'Create an injection preset from registered asset ids.',
      PRESET_CREATE_INPUT_SCHEMA
    )
  ),
  'presets.edit': executable(
    'presets.edit',
    reversibleGlobal('Edit an injection preset.', PRESET_EDIT_INPUT_SCHEMA)
  ),
  'presets.delete': executable('presets.delete', {
    description: 'Delete an injection preset.',
    risk: 'dangerous',
    targetContext: 'global',
    inputSchema: ID_INPUT_SCHEMA,
  }),
  'presets.set-default': executable(
    'presets.set-default',
    reversibleGlobal(
      "Set the default preset applied to new conversations ('default' = built-in global preset).",
      ID_INPUT_SCHEMA
    )
  ),
  'presets.select-for-conversation': unavailable('presets.select-for-conversation', {
    description: 'Select the preset for the origin conversation.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    inputSchema: ID_INPUT_SCHEMA,
    availability: [{ kind: 'origin-conversation' }],
    reason:
      'Source conversation configuration is not exposed through the Enso gateway in this release.',
    suggestedAction: 'Choose the preset from the source conversation model controls.',
  }),

  'agent-types.list': executable(
    'agent-types.list',
    readGlobal('List built-in and custom agent types.')
  ),
  'agent-types.create': executable(
    'agent-types.create',
    reversibleGlobal('Create a custom agent type.', AGENT_TYPE_CREATE_INPUT_SCHEMA)
  ),
  'agent-types.edit': executable(
    'agent-types.edit',
    reversibleGlobal('Edit a custom agent type.', AGENT_TYPE_EDIT_INPUT_SCHEMA)
  ),
  'agent-types.toggle-builtin': executable(
    'agent-types.toggle-builtin',
    reversibleGlobal(
      'Enable or disable a built-in agent type.',
      BUILTIN_AGENT_TYPE_TOGGLE_INPUT_SCHEMA
    )
  ),
  'agent-types.delete': executable('agent-types.delete', {
    description: 'Delete a custom agent type.',
    risk: 'dangerous',
    targetContext: 'global',
    inputSchema: ID_INPUT_SCHEMA,
  }),

  'tools.list': executable(
    'tools.list',
    readGlobal('List built-in coding tools and enabled state.')
  ),
  'tools.toggle-builtin': executable(
    'tools.toggle-builtin',
    reversibleGlobal('Enable or disable a built-in coding tool.', BUILTIN_TOOL_TOGGLE_INPUT_SCHEMA)
  ),

  'onboarding.complete': unavailable('onboarding.complete', {
    description: 'Complete the first-run onboarding flow.',
    risk: 'reversible',
    targetContext: 'origin-window',
    reason: 'Onboarding completion must follow the visible provider and project setup steps.',
    suggestedAction: 'Finish the onboarding flow in its window.',
  }),

  'projects.list': executable('projects.list', readGlobal('List registered projects and paths.')),
  'projects.recent': executable(
    'projects.recent',
    readGlobal('List recent projects discovered from local apps.')
  ),
  'projects.add': unavailable('projects.add', {
    description: 'Add a local directory as a project.',
    risk: 'dangerous',
    targetContext: 'origin-window',
    reason: 'Project registration requires an explicit native directory selection.',
    suggestedAction: 'Use Add project and choose the directory in the native picker.',
  }),
  'projects.remove': executable('projects.remove', {
    description: 'Remove a project and its conversations from the application list.',
    risk: 'dangerous',
    targetContext: 'global',
    inputSchema: ID_INPUT_SCHEMA,
  }),
  'projects.ssh-connections': executable(
    'projects.ssh-connections',
    readGlobal('List SSH connection profiles without credentials.')
  ),
  'projects.ssh-connections.add': unavailable('projects.ssh-connections.add', {
    ...reversibleGlobal('Add an SSH connection profile.'),
    risk: 'dangerous',
    reason: 'SSH passwords must never enter Enso context; profile setup uses the settings form.',
    suggestedAction: 'Open Settings and add the SSH connection there.',
  }),
  'projects.ssh-connections.update': unavailable('projects.ssh-connections.update', {
    ...reversibleGlobal('Edit an SSH connection profile.'),
    reason:
      'Editing host or credentials could redirect a stored password to an attacker-chosen host.',
    suggestedAction: 'Edit the SSH connection in Settings.',
  }),
  'projects.ssh-connections.remove': executable('projects.ssh-connections.remove', {
    description: 'Remove one SSH connection profile; connections used by projects are protected.',
    risk: 'dangerous',
    targetContext: 'global',
    inputSchema: ID_INPUT_SCHEMA,
  }),
  'projects.ssh-connections.test': executable('projects.ssh-connections.test', {
    ...readGlobal('Test an SSH connection; this performs a real login attempt.', ID_INPUT_SCHEMA),
    risk: 'dangerous',
  }),

  'conversations.list': executable(
    'conversations.list',
    readGlobal('List conversation metadata without injecting message history into Enso.')
  ),
  'conversations.create': unavailable('conversations.create', {
    description: 'Create a coding conversation in a project.',
    risk: 'reversible',
    targetContext: 'origin-project',
    reason:
      'Creating source coding sessions is not exposed through the Enso gateway in this release.',
    suggestedAction: 'Use New conversation in the project sidebar.',
  }),
  'conversations.select': unavailable('conversations.select', {
    description: 'Select a coding conversation in the source window.',
    risk: 'reversible',
    targetContext: 'origin-window',
    reason: 'Enso cannot take over source window navigation.',
    suggestedAction: 'Select the conversation from the sidebar.',
  }),
  'conversations.delete': unavailable('conversations.delete', {
    description: 'Delete a coding conversation from the list.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Conversation deletion is not exposed through the Enso gateway in this release.',
    suggestedAction: 'Use Delete conversation in the sidebar and confirm it.',
  }),
  'conversations.import-external': unavailable('conversations.import-external', {
    description: 'Import a conversation from another local AI application.',
    risk: 'dangerous',
    targetContext: 'origin-project',
    reason: 'Import requires reviewing external session history in a dedicated UI.',
    suggestedAction: 'Use Import session from the project menu.',
  }),
  'conversations.send': unavailable('conversations.send', {
    description: 'Send a message to the origin coding agent.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Messages addressed to Enso must not be forwarded into the coding agent conversation.',
    suggestedAction: 'Send the message directly in the coding conversation.',
  }),
  'conversations.abort': unavailable('conversations.abort', {
    description: 'Abort the origin coding agent turn.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Coding-agent lifecycle controls are not exposed through the Enso gateway.',
    suggestedAction: 'Use Stop in the source conversation.',
  }),
  'conversations.set-model': unavailable('conversations.set-model', {
    description: 'Change the origin coding conversation model.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Per-conversation model controls remain owned by the source conversation.',
    suggestedAction: 'Use the model picker in the source conversation.',
  }),
  'conversations.set-reasoning': unavailable('conversations.set-reasoning', {
    description: 'Change reasoning mode for the origin conversation.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Per-conversation reasoning controls remain owned by the source conversation.',
    suggestedAction: 'Use the reasoning control in the source conversation.',
  }),
  'conversations.set-thinking': unavailable('conversations.set-thinking', {
    description: 'Change thinking level for the origin conversation.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Per-conversation thinking controls remain owned by the source conversation.',
    suggestedAction: 'Use the thinking control in the source conversation.',
  }),
  'conversations.set-approval-mode': unavailable('conversations.set-approval-mode', {
    description: 'Change coding-agent approval mode.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Enso must not weaken or inherit coding-agent approval policy.',
    suggestedAction: 'Change approval mode directly in the source conversation.',
  }),
  'conversations.approval.respond': unavailable('conversations.approval.respond', {
    description: 'Allow or deny a pending coding-agent tool request.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Enso cannot impersonate the user when resolving coding-agent approvals.',
    suggestedAction: 'Resolve the approval directly in the source conversation.',
  }),
  'conversations.ask.respond': unavailable('conversations.ask.respond', {
    description: 'Answer a pending question from the coding agent.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Enso cannot answer a coding-agent question on behalf of the user.',
    suggestedAction: 'Answer the question directly in the source conversation.',
  }),
  'conversations.background-task.stop': unavailable('conversations.background-task.stop', {
    description: 'Stop a coding-agent background task.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Coding-agent process lifecycle controls are outside the Enso gateway.',
    suggestedAction: 'Stop the task from the source conversation task panel.',
  }),
  'conversations.file-mention.attach': unavailable('conversations.file-mention.attach', {
    description: 'Search for and attach a project file mention.',
    risk: 'read',
    targetContext: 'origin-project',
    reason: 'Enso only receives files explicitly selected by the user in the mention picker.',
    suggestedAction: 'Attach the file with @ in the source composer.',
  }),
  'conversations.queue.edit': unavailable('conversations.queue.edit', {
    description: 'Edit a queued coding-agent message.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Source message queues are not exposed through the Enso gateway.',
    suggestedAction: 'Edit the queued message in the source conversation.',
  }),
  'conversations.queue.remove': unavailable('conversations.queue.remove', {
    description: 'Remove a queued coding-agent message.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Source message queues are not exposed through the Enso gateway.',
    suggestedAction: 'Remove the queued message in the source conversation.',
  }),
  'conversations.queue.send-now': unavailable('conversations.queue.send-now', {
    description: 'Send a queued coding-agent message immediately.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Source message queues are not exposed through the Enso gateway.',
    suggestedAction: 'Use Send now in the source conversation.',
  }),
  'conversations.goal.set': unavailable('conversations.goal.set', {
    description: 'Set a goal for the origin coding conversation.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Coding session goal control is not exposed through the Enso gateway.',
    suggestedAction: 'Use /goal in the source conversation.',
  }),
  'conversations.goal.pause': unavailable('conversations.goal.pause', {
    description: 'Pause the origin coding conversation goal.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Coding session goal control is not exposed through the Enso gateway.',
    suggestedAction: 'Pause the goal in the source conversation.',
  }),
  'conversations.goal.resume': unavailable('conversations.goal.resume', {
    description: 'Resume the origin coding conversation goal.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Coding session goal control is not exposed through the Enso gateway.',
    suggestedAction: 'Resume the goal in the source conversation.',
  }),
  'conversations.goal.clear': unavailable('conversations.goal.clear', {
    description: 'Clear the origin coding conversation goal.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Coding session goal control is not exposed through the Enso gateway.',
    suggestedAction: 'Clear the goal in the source conversation.',
  }),
  'conversations.worktree.create': unavailable('conversations.worktree.create', {
    description: 'Create an isolated git worktree for a conversation.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Workspace isolation is a desktop-side decision, not an Enso capability.',
    suggestedAction: 'Create the isolated session from the sidebar.',
  }),
  'conversations.worktree.status': unavailable('conversations.worktree.status', {
    description: 'Inspect worktree status (dirty / unmerged) of a conversation.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Worktree status is surfaced in the sidebar, not through the gateway.',
    suggestedAction: 'Check the session badges in the sidebar.',
  }),
  'conversations.worktree.remove': unavailable('conversations.worktree.remove', {
    description: 'Clean up the isolated worktree of a conversation.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Worktree cleanup may drop uncommitted work and requires user confirmation.',
    suggestedAction: 'Use the session context menu to clean up the worktree.',
  }),
  'conversations.worktree.rebuild': unavailable('conversations.worktree.rebuild', {
    description: 'Rebuild a missing conversation worktree.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Rebuild choices (branch vs fallback) belong to the user on resume.',
    suggestedAction: 'Resume the conversation and choose rebuild or fallback.',
  }),
  'conversations.worktree.release': unavailable('conversations.worktree.release', {
    description: 'Release a live session for workspace migration.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Session release interrupts the running agent and is user-initiated only.',
    suggestedAction: 'Use Move to worktree from the session context menu.',
  }),
  'conversations.retry-turn': unavailable('conversations.retry-turn', {
    description: 'Retry a failed origin coding-agent turn without sending a new user message.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Coding-agent lifecycle controls are not exposed through the Enso gateway.',
    suggestedAction: 'Use Retry on the failed turn in the source conversation.',
  }),
  'conversations.rewind': unavailable('conversations.rewind', {
    description: 'Rewind origin conversation history without restoring files.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Conversation history rewrites require review in the source timeline.',
    suggestedAction: 'Use Rewind in the source conversation and confirm it.',
  }),
  'conversations.rewind-files': unavailable('conversations.rewind-files', {
    description: 'Rewind origin conversation history and restore project files.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Enso is not allowed to rewrite project files or checkpoints.',
    suggestedAction: 'Use Conversation + files in the source timeline and confirm it.',
  }),

  'team.list-agent-types': executable(
    'team.list-agent-types',
    readGlobal('List agent types available for team hiring.')
  ),
  'team.list-coworkers': executable('team.list-coworkers', {
    description: 'List coworkers belonging to the origin coding conversation.',
    risk: 'read',
    targetContext: 'origin-conversation',
    availability: [{ kind: 'origin-conversation' }],
  }),
  'team.hire-coworker': executable('team.hire-coworker', {
    description: 'Hire a coworker into the origin coding conversation.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    inputSchema: HIRE_COWORKER_INPUT_SCHEMA,
    availability: [{ kind: 'started-origin-conversation' }],
  }),
  'team.dismiss-coworker': executable('team.dismiss-coworker', {
    description: 'Dismiss a coworker from the origin coding conversation.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    inputSchema: DISMISS_COWORKER_INPUT_SCHEMA,
    availability: [{ kind: 'started-origin-conversation' }],
  }),
  'team.message-coworker': unavailable('team.message-coworker', {
    description: 'Send a direct message to an origin coworker.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Direct coworker messaging is not a controlled Enso domain handler in this release.',
    suggestedAction: 'Open the coworker tab and send the message there.',
  }),

  'updates.status': unavailable('updates.status', {
    ...readGlobal('Read current update availability and download status.'),
    availability: [{ kind: 'desktop-updater' }],
    reason: 'Current status is only a renderer event projection; Main has no snapshot getter.',
    suggestedAction: 'Open the Updates UI to view the current update status.',
  }),
  'updates.check': executable('updates.check', {
    ...readGlobal('Check the release feed for application updates.'),
    availability: [{ kind: 'desktop-updater' }],
  }),
  'updates.download': executable('updates.download', {
    description: 'Download an available application update.',
    risk: 'reversible',
    targetContext: 'global',
    availability: [{ kind: 'desktop-updater' }],
  }),
  'updates.install': unavailable('updates.install', {
    description: 'Quit the application and install a downloaded update.',
    risk: 'dangerous',
    targetContext: 'global',
    availability: [{ kind: 'desktop-updater' }],
    reason: 'Enso cannot terminate or restart the application process in this release.',
    suggestedAction: 'Use Restart and install from the update UI.',
  }),

  'window.open-settings': unavailable('window.open-settings', {
    description: 'Open the settings window.',
    risk: 'reversible',
    targetContext: 'origin-window',
    reason: 'Window navigation is intentionally outside the Enso execution gateway.',
    suggestedAction: 'Open Settings from the sidebar or keyboard shortcut.',
  }),
  'window.focus-conversation-notification': unavailable('window.focus-conversation-notification', {
    description: 'Focus a conversation after clicking its system notification.',
    risk: 'reversible',
    targetContext: 'origin-window',
    reason: 'Notification focus is a direct window navigation action.',
    suggestedAction: 'Click the system notification or select the conversation in the sidebar.',
  }),
  'window.minimize': unavailable('window.minimize', {
    description: 'Minimize the origin window.',
    risk: 'reversible',
    targetContext: 'origin-window',
    reason: 'Window controls are intentionally outside the Enso execution gateway.',
    suggestedAction: 'Use the window title bar controls.',
  }),
  'window.maximize': unavailable('window.maximize', {
    description: 'Maximize or restore the origin window.',
    risk: 'reversible',
    targetContext: 'origin-window',
    reason: 'Window controls are intentionally outside the Enso execution gateway.',
    suggestedAction: 'Use the window title bar controls.',
  }),
  'window.close': unavailable('window.close', {
    description: 'Close the origin window.',
    risk: 'dangerous',
    targetContext: 'origin-window',
    reason: 'Enso cannot close application windows.',
    suggestedAction: 'Use the window title bar close control.',
  }),
  'window.toggle-sidebar': unavailable('window.toggle-sidebar', {
    description: 'Expand or collapse the project sidebar.',
    risk: 'reversible',
    targetContext: 'origin-window',
    reason: 'Per-window layout controls remain direct UI actions.',
    suggestedAction: 'Use the sidebar toggle button or shortcut.',
  }),
  'window.fullscreen': unavailable('window.fullscreen', {
    description: 'Enter or leave fullscreen.',
    risk: 'reversible',
    targetContext: 'origin-window',
    reason: 'Window controls are intentionally outside the Enso execution gateway.',
    suggestedAction: 'Use the operating-system fullscreen control.',
  }),

  'coding-tools.command': unavailable('coding-tools.command', {
    description: 'Run an arbitrary shell command.',
    risk: 'dangerous',
    targetContext: 'origin-project',
    reason: 'Enso never receives a shell command tool.',
    suggestedAction: 'Ask the coding agent in the project conversation.',
  }),
  'coding-tools.file-read': unavailable('coding-tools.file-read', {
    description: 'Read an arbitrary project file.',
    risk: 'read',
    targetContext: 'origin-project',
    reason: 'Enso only receives immutable snapshots from explicit file mentions.',
    suggestedAction: 'Mention the file explicitly with @file or ask the coding agent.',
  }),
  'coding-tools.file-search': unavailable('coding-tools.file-search', {
    description: 'Search arbitrary project files.',
    risk: 'read',
    targetContext: 'origin-project',
    reason: 'Enso has no general filesystem search tool.',
    suggestedAction: 'Ask the coding agent to search the project.',
  }),
  'coding-tools.file-edit': unavailable('coding-tools.file-edit', {
    description: 'Edit a project file.',
    risk: 'dangerous',
    targetContext: 'origin-project',
    reason: 'Enso is not allowed to modify project files.',
    suggestedAction: 'Ask the coding agent to make the change.',
  }),
  'coding-tools.file-write': unavailable('coding-tools.file-write', {
    description: 'Create or overwrite a project file.',
    risk: 'dangerous',
    targetContext: 'origin-project',
    reason: 'Enso is not allowed to modify project files.',
    suggestedAction: 'Ask the coding agent to create or write the file.',
  }),
  'coding-tools.mcp': unavailable('coding-tools.mcp', {
    description: 'Call an arbitrary MCP tool.',
    risk: 'dangerous',
    targetContext: 'origin-project',
    reason: 'Enso does not receive arbitrary MCP tools.',
    suggestedAction: 'Use the coding agent session with the required MCP server enabled.',
  }),
  'coding-tools.subagent': unavailable('coding-tools.subagent', {
    description: 'Delegate an arbitrary coding subtask to a subagent.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Enso does not receive the general subagent tool.',
    suggestedAction: 'Ask the coding agent to delegate the coding task.',
  }),
  'coding-tools.coworker': unavailable('coding-tools.coworker', {
    description: 'Use the unrestricted coworker tool.',
    risk: 'dangerous',
    targetContext: 'origin-conversation',
    reason: 'Enso only uses origin-bound team handlers, never the raw coworker tool.',
    suggestedAction: 'Use team.list-coworkers, team.hire-coworker, or team.dismiss-coworker.',
  }),
  'coding-tools.todo': unavailable('coding-tools.todo', {
    description: 'Manage a coding agent todo list.',
    risk: 'reversible',
    targetContext: 'origin-conversation',
    reason: 'Coding todo state belongs to the coding agent session.',
    suggestedAction: 'Ask the coding agent to update its todo list.',
  }),
  'coding-tools.ask-user': unavailable('coding-tools.ask-user', {
    description: 'Use the coding agent ask_user tool.',
    risk: 'read',
    targetContext: 'origin-conversation',
    reason: 'Enso has its own clarification channel and does not invoke the coding agent tool.',
    suggestedAction: 'Answer Enso directly or continue in the coding conversation.',
  }),
  'coding-tools.background-task': unavailable('coding-tools.background-task', {
    description: 'Run a background shell task.',
    risk: 'dangerous',
    targetContext: 'origin-project',
    reason: 'Enso never receives command or background process tools.',
    suggestedAction: 'Ask the coding agent to run the background task.',
  }),
  'coding-tools.browser': unavailable('coding-tools.browser', {
    description: "Browse pages in Enso's built-in browser.",
    risk: 'dangerous',
    targetContext: 'origin-project',
    reason: 'Enso never receives browsing or page-interaction tools.',
    suggestedAction: 'Ask the coding agent to use the built-in browser.',
  }),
} as const satisfies Record<ProductSurfaceId, CapabilitySpec<ProductSurfaceId, ProductSurfaceId>>;

export type CapabilityCatalog = typeof CAPABILITY_CATALOG;
export type ExecutableCapabilityId = {
  [Id in ProductSurfaceId]: CapabilityCatalog[Id]['execution'] extends { kind: 'executable' }
    ? Id
    : never;
}[ProductSurfaceId];
export type CapabilityHandlerId = ExecutableCapabilityId;

/**
 * Gateway handler 的稳定 id 合同。这里只声明 handler 必须存在，不在 shared 注入实现。
 * executable 状态变化会要求本 Record 同步更新，否则 TypeScript 直接失败。
 */
export const CAPABILITY_HANDLER_CONTRACT: Readonly<Record<ExecutableCapabilityId, true>> = {
  'general.language': true,
  'general.load-local-skills': true,
  'general.load-harness-assets': true,
  'general.automatic-updates': true,
  'general.proxy-mode': true,
  'general.custom-proxy-url': true,
  'general.keybindings.list': true,
  'general.keybindings.set': true,
  'general.keybindings.reset': true,
  'appearance.theme': true,
  'appearance.terminal-theme': true,
  'appearance.terminal-font-size': true,
  'appearance.terminal-font-family': true,
  'appearance.terminal-font-weight': true,
  'appearance.terminal-bold-weight': true,
  'appearance.favorite-terminal-themes': true,
  'appearance.status-line-segments': true,
  'providers.list': true,
  'providers.remove': true,
  'providers.fetch-models': true,
  'providers.test-connection': true,
  'providers.model-meta': true,
  'providers.toggle-provider': true,
  'providers.toggle-model': true,
  'providers.default-model': true,
  'providers.subagent-models': true,
  'providers.subagent-models.toggle': true,
  'providers.subagent-models.add': true,
  'providers.subagent-models.update': true,
  'providers.subagent-models.remove': true,
  'providers.oauth.list': true,
  'providers.oauth.login': true,
  'providers.oauth.logout': true,
  'providers.oauth.usage': true,
  'providers.oauth.cancel-login': true,
  'providers.oauth.reopen-login': true,
  'skills.list': true,
  'skills.toggle': true,
  'skills.remove': true,
  'mcp.list': true,
  'mcp.toggle': true,
  'mcp.remove': true,
  'instructions.list': true,
  'instructions.toggle': true,
  'instructions.read': true,
  'instructions.edit-local-copy': true,
  'instructions.remove': true,
  'presets.list': true,
  'presets.create': true,
  'presets.edit': true,
  'presets.delete': true,
  'presets.set-default': true,
  'agent-types.list': true,
  'agent-types.create': true,
  'agent-types.edit': true,
  'agent-types.toggle-builtin': true,
  'agent-types.delete': true,
  'tools.list': true,
  'tools.toggle-builtin': true,
  'projects.list': true,
  'projects.recent': true,
  'projects.remove': true,
  'projects.ssh-connections': true,
  'projects.ssh-connections.remove': true,
  'projects.ssh-connections.test': true,
  'conversations.list': true,
  'team.list-agent-types': true,
  'team.list-coworkers': true,
  'team.hire-coworker': true,
  'team.dismiss-coworker': true,
  'updates.check': true,
  'updates.download': true,
};
