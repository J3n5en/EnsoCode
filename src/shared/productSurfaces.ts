export type ProductSurfaceDomain =
  | 'general'
  | 'appearance'
  | 'providers'
  | 'skills'
  | 'mcp'
  | 'instructions'
  | 'presets'
  | 'agent-types'
  | 'tools'
  | 'onboarding'
  | 'projects'
  | 'conversations'
  | 'team'
  | 'updates'
  | 'window'
  | 'coding-tools';

export interface ProductSurfaceInventoryItem {
  domain: ProductSurfaceDomain;
  kind: 'setting' | 'action';
  label: string;
}

/** 当前用户可见产品领域的权威库存；新增键会强制 capability catalog 同步补齐。 */
export const PRODUCT_SURFACE_INVENTORY = {
  'general.language': { domain: 'general', kind: 'setting', label: 'Language' },
  'general.load-local-skills': {
    domain: 'general',
    kind: 'setting',
    label: 'Load local skills',
  },
  'general.automatic-updates': {
    domain: 'general',
    kind: 'setting',
    label: 'Automatic updates',
  },
  'general.keybindings.list': { domain: 'general', kind: 'action', label: 'List keybindings' },
  'general.keybindings.set': { domain: 'general', kind: 'setting', label: 'Set keybinding' },
  'general.keybindings.reset': { domain: 'general', kind: 'setting', label: 'Reset keybinding' },

  'appearance.theme': { domain: 'appearance', kind: 'setting', label: 'Application theme' },
  'appearance.terminal-theme': {
    domain: 'appearance',
    kind: 'setting',
    label: 'Terminal theme',
  },
  'appearance.terminal-font-size': {
    domain: 'appearance',
    kind: 'setting',
    label: 'Terminal font size',
  },
  'appearance.terminal-font-family': {
    domain: 'appearance',
    kind: 'setting',
    label: 'Terminal font family',
  },
  'appearance.terminal-font-weight': {
    domain: 'appearance',
    kind: 'setting',
    label: 'Terminal font weight',
  },
  'appearance.terminal-bold-weight': {
    domain: 'appearance',
    kind: 'setting',
    label: 'Terminal bold font weight',
  },
  'appearance.favorite-terminal-themes': {
    domain: 'appearance',
    kind: 'setting',
    label: 'Favorite terminal themes',
  },
  'appearance.status-line-segments': {
    domain: 'appearance',
    kind: 'setting',
    label: 'Status line segments',
  },

  'providers.list': { domain: 'providers', kind: 'action', label: 'List model providers' },
  'providers.import-local': {
    domain: 'providers',
    kind: 'action',
    label: 'Import providers from local apps',
  },
  'providers.add': { domain: 'providers', kind: 'action', label: 'Add model provider' },
  'providers.update': { domain: 'providers', kind: 'setting', label: 'Edit model provider' },
  'providers.remove': { domain: 'providers', kind: 'action', label: 'Remove model provider' },
  'providers.fetch-models': {
    domain: 'providers',
    kind: 'action',
    label: 'Fetch provider models',
  },
  'providers.test-connection': {
    domain: 'providers',
    kind: 'action',
    label: 'Test provider connection',
  },
  'providers.model-meta': { domain: 'providers', kind: 'action', label: 'Read model metadata' },
  'providers.toggle-provider': {
    domain: 'providers',
    kind: 'setting',
    label: 'Enable or disable provider',
  },
  'providers.toggle-model': {
    domain: 'providers',
    kind: 'setting',
    label: 'Enable or disable model',
  },
  'providers.default-model': {
    domain: 'providers',
    kind: 'setting',
    label: 'Set global default model',
  },
  'providers.subagent-models': {
    domain: 'providers',
    kind: 'setting',
    label: 'Models the agent may pick for subagents',
  },
  'providers.oauth.list': {
    domain: 'providers',
    kind: 'action',
    label: 'List subscription providers and accounts',
  },
  'providers.oauth.login': {
    domain: 'providers',
    kind: 'action',
    label: 'Sign in to subscription',
  },
  'providers.oauth.logout': {
    domain: 'providers',
    kind: 'action',
    label: 'Sign out subscription account',
  },
  'providers.oauth.usage': {
    domain: 'providers',
    kind: 'action',
    label: 'Read subscription usage',
  },
  'providers.oauth.cancel-login': {
    domain: 'providers',
    kind: 'action',
    label: 'Cancel subscription login',
  },
  'providers.oauth.reopen-login': {
    domain: 'providers',
    kind: 'action',
    label: 'Reopen subscription authorization',
  },

  'skills.list': { domain: 'skills', kind: 'action', label: 'List skills' },
  'skills.import-local': { domain: 'skills', kind: 'action', label: 'Import local skills' },
  'skills.toggle': { domain: 'skills', kind: 'setting', label: 'Enable or disable skill' },
  'skills.remove': { domain: 'skills', kind: 'action', label: 'Remove skill registration' },

  'mcp.list': { domain: 'mcp', kind: 'action', label: 'List MCP servers' },
  'mcp.import-local': { domain: 'mcp', kind: 'action', label: 'Import local MCP servers' },
  'mcp.edit': { domain: 'mcp', kind: 'setting', label: 'Edit MCP server' },
  'mcp.toggle': { domain: 'mcp', kind: 'setting', label: 'Enable or disable MCP server' },
  'mcp.remove': { domain: 'mcp', kind: 'action', label: 'Remove MCP server' },

  'instructions.list': { domain: 'instructions', kind: 'action', label: 'List instruction files' },
  'instructions.import-local': {
    domain: 'instructions',
    kind: 'action',
    label: 'Import local instruction files',
  },
  'instructions.toggle': {
    domain: 'instructions',
    kind: 'setting',
    label: 'Enable instruction file',
  },
  'instructions.read': {
    domain: 'instructions',
    kind: 'action',
    label: 'Read instruction content',
  },
  'instructions.edit-local-copy': {
    domain: 'instructions',
    kind: 'setting',
    label: 'Edit local instruction copy',
  },
  'instructions.overwrite-source': {
    domain: 'instructions',
    kind: 'action',
    label: 'Overwrite original instruction file',
  },
  'instructions.remove': {
    domain: 'instructions',
    kind: 'action',
    label: 'Remove instruction registration',
  },

  'presets.list': { domain: 'presets', kind: 'action', label: 'List presets' },
  'presets.create': { domain: 'presets', kind: 'setting', label: 'Create preset' },
  'presets.edit': { domain: 'presets', kind: 'setting', label: 'Edit preset' },
  'presets.delete': { domain: 'presets', kind: 'action', label: 'Delete preset' },
  'presets.select-for-conversation': {
    domain: 'presets',
    kind: 'setting',
    label: 'Select conversation preset',
  },

  'agent-types.list': { domain: 'agent-types', kind: 'action', label: 'List agent types' },
  'agent-types.create': { domain: 'agent-types', kind: 'setting', label: 'Create agent type' },
  'agent-types.edit': { domain: 'agent-types', kind: 'setting', label: 'Edit agent type' },
  'agent-types.toggle-builtin': {
    domain: 'agent-types',
    kind: 'setting',
    label: 'Enable or disable built-in agent type',
  },
  'agent-types.delete': { domain: 'agent-types', kind: 'action', label: 'Delete agent type' },

  'tools.list': { domain: 'tools', kind: 'action', label: 'List built-in tools' },
  'tools.toggle-builtin': {
    domain: 'tools',
    kind: 'setting',
    label: 'Enable or disable built-in tool',
  },

  'onboarding.complete': {
    domain: 'onboarding',
    kind: 'action',
    label: 'Complete first-run onboarding',
  },

  'projects.list': { domain: 'projects', kind: 'action', label: 'List projects' },
  'projects.recent': { domain: 'projects', kind: 'action', label: 'List recent projects' },
  'projects.add': { domain: 'projects', kind: 'action', label: 'Add project' },
  'projects.remove': { domain: 'projects', kind: 'action', label: 'Remove project' },

  'conversations.list': { domain: 'conversations', kind: 'action', label: 'List conversations' },
  'conversations.create': {
    domain: 'conversations',
    kind: 'action',
    label: 'Create conversation',
  },
  'conversations.select': {
    domain: 'conversations',
    kind: 'action',
    label: 'Select conversation',
  },
  'conversations.delete': {
    domain: 'conversations',
    kind: 'action',
    label: 'Delete conversation',
  },
  'conversations.import-external': {
    domain: 'conversations',
    kind: 'action',
    label: 'Import external conversation',
  },
  'conversations.send': { domain: 'conversations', kind: 'action', label: 'Send message' },
  'conversations.abort': { domain: 'conversations', kind: 'action', label: 'Abort current turn' },
  'conversations.set-model': {
    domain: 'conversations',
    kind: 'setting',
    label: 'Select conversation model',
  },
  'conversations.set-reasoning': {
    domain: 'conversations',
    kind: 'setting',
    label: 'Set reasoning mode',
  },
  'conversations.set-thinking': {
    domain: 'conversations',
    kind: 'setting',
    label: 'Set thinking level',
  },
  'conversations.set-approval-mode': {
    domain: 'conversations',
    kind: 'setting',
    label: 'Set approval mode',
  },
  'conversations.approval.respond': {
    domain: 'conversations',
    kind: 'action',
    label: 'Resolve coding tool approval',
  },
  'conversations.ask.respond': {
    domain: 'conversations',
    kind: 'action',
    label: 'Answer coding agent question',
  },
  'conversations.background-task.stop': {
    domain: 'conversations',
    kind: 'action',
    label: 'Stop background task',
  },
  'conversations.file-mention.attach': {
    domain: 'conversations',
    kind: 'action',
    label: 'Attach project file mention',
  },
  'conversations.queue.edit': {
    domain: 'conversations',
    kind: 'action',
    label: 'Edit queued message',
  },
  'conversations.queue.remove': {
    domain: 'conversations',
    kind: 'action',
    label: 'Remove queued message',
  },
  'conversations.queue.send-now': {
    domain: 'conversations',
    kind: 'action',
    label: 'Send queued message now',
  },
  'conversations.goal.set': { domain: 'conversations', kind: 'action', label: 'Set session goal' },
  'conversations.goal.pause': {
    domain: 'conversations',
    kind: 'action',
    label: 'Pause session goal',
  },
  'conversations.goal.resume': {
    domain: 'conversations',
    kind: 'action',
    label: 'Resume session goal',
  },
  'conversations.goal.clear': {
    domain: 'conversations',
    kind: 'action',
    label: 'Clear session goal',
  },
  'conversations.rewind': { domain: 'conversations', kind: 'action', label: 'Rewind conversation' },
  'conversations.rewind-files': {
    domain: 'conversations',
    kind: 'action',
    label: 'Rewind conversation and restore files',
  },

  'team.list-agent-types': { domain: 'team', kind: 'action', label: 'List team agent types' },
  'team.list-coworkers': { domain: 'team', kind: 'action', label: 'List origin coworkers' },
  'team.hire-coworker': { domain: 'team', kind: 'action', label: 'Hire coworker' },
  'team.dismiss-coworker': { domain: 'team', kind: 'action', label: 'Dismiss coworker' },
  'team.message-coworker': { domain: 'team', kind: 'action', label: 'Message coworker' },

  'updates.status': { domain: 'updates', kind: 'action', label: 'Read update status' },
  'updates.check': { domain: 'updates', kind: 'action', label: 'Check for updates' },
  'updates.download': { domain: 'updates', kind: 'action', label: 'Download update' },
  'updates.install': { domain: 'updates', kind: 'action', label: 'Quit and install update' },

  'window.open-settings': { domain: 'window', kind: 'action', label: 'Open settings window' },
  'window.focus-conversation-notification': {
    domain: 'window',
    kind: 'action',
    label: 'Focus conversation from notification',
  },
  'window.minimize': { domain: 'window', kind: 'action', label: 'Minimize window' },
  'window.maximize': { domain: 'window', kind: 'action', label: 'Maximize or restore window' },
  'window.close': { domain: 'window', kind: 'action', label: 'Close window' },
  'window.toggle-sidebar': { domain: 'window', kind: 'action', label: 'Toggle sidebar' },
  'window.fullscreen': { domain: 'window', kind: 'action', label: 'Enter or leave fullscreen' },

  'coding-tools.command': { domain: 'coding-tools', kind: 'action', label: 'Run command' },
  'coding-tools.file-read': { domain: 'coding-tools', kind: 'action', label: 'Read project file' },
  'coding-tools.file-search': {
    domain: 'coding-tools',
    kind: 'action',
    label: 'Search project files',
  },
  'coding-tools.file-edit': { domain: 'coding-tools', kind: 'action', label: 'Edit project file' },
  'coding-tools.file-write': {
    domain: 'coding-tools',
    kind: 'action',
    label: 'Write project file',
  },
  'coding-tools.mcp': { domain: 'coding-tools', kind: 'action', label: 'Call MCP tool' },
  'coding-tools.subagent': { domain: 'coding-tools', kind: 'action', label: 'Run subagent' },
  'coding-tools.coworker': { domain: 'coding-tools', kind: 'action', label: 'Use coworker tool' },
  'coding-tools.todo': { domain: 'coding-tools', kind: 'action', label: 'Manage coding todo list' },
  'coding-tools.ask-user': { domain: 'coding-tools', kind: 'action', label: 'Ask coding question' },
  'coding-tools.background-task': {
    domain: 'coding-tools',
    kind: 'action',
    label: 'Run background shell task',
  },
} as const satisfies Record<string, ProductSurfaceInventoryItem>;

export type ProductSurfaceId = keyof typeof PRODUCT_SURFACE_INVENTORY;

export type ProductSurfaceInventory = Readonly<
  Record<ProductSurfaceId, ProductSurfaceInventoryItem>
>;
