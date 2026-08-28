export const IPC_CHANNELS = {
  // Settings persistence
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  SETTINGS_WRITE_KEY: 'settings:write-key',
  SETTINGS_CHANGED: 'settings:changed',

  // Window controls
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  WINDOW_IS_FULLSCREEN: 'window:is-fullscreen',
  WINDOW_MAXIMIZED_CHANGED: 'window:maximized-changed',
  WINDOW_FULLSCREEN_CHANGED: 'window:fullscreen-changed',
  WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE: 'window:set-traffic-lights-visible',
  WINDOW_OPEN_SETTINGS: 'window:open-settings',

  // Local provider scan/import
  PROVIDERS_SCAN_LOCAL: 'providers:scan-local',
  PROVIDERS_COLLECT_IMPORT: 'providers:collect-import',
  PROVIDERS_LIST_MODELS: 'providers:list-models',
  PROVIDERS_TEST: 'providers:test',
  PROVIDERS_MODEL_META: 'providers:model-meta',

  // OAuth subscription providers (pi builtin)
  OAUTH_PROVIDERS_LIST: 'oauth-providers:list',
  OAUTH_LOGIN: 'oauth-providers:login',
  OAUTH_LOGIN_RESPOND: 'oauth-providers:login-respond',
  OAUTH_LOGIN_CANCEL: 'oauth-providers:login-cancel',
  OAUTH_LOGIN_REOPEN: 'oauth-providers:login-reopen',
  OAUTH_LOGOUT: 'oauth-providers:logout',
  OAUTH_LOGIN_EVENT: 'oauth-providers:login-event',
  OAUTH_ACCOUNT_INFO: 'oauth-providers:account-info',

  // Local skill / MCP scan/import
  ASSETS_SCAN_LOCAL: 'assets:scan-local',
  ASSETS_COLLECT_IMPORT: 'assets:collect-import',
  ASSETS_LIST_PROJECT_SKILLS: 'assets:list-project-skills',

  // Instruction content (copy-on-write)
  INSTRUCTIONS_READ: 'instructions:read',
  INSTRUCTIONS_WRITE: 'instructions:write',
  INSTRUCTIONS_WRITE_SOURCE: 'instructions:write-source',
  INSTRUCTIONS_DELETE: 'instructions:delete',

  // Agent sessions (Renderer → Main → utilityProcess)
  AGENT_SPAWN: 'agent:spawn',
  AGENT_PROMPT: 'agent:prompt',
  AGENT_STEER: 'agent:steer',
  AGENT_ABORT: 'agent:abort',
  AGENT_EVENT: 'agent:event',
  AGENT_SNAPSHOT: 'agent:snapshot',
  AGENT_SET_THINKING: 'agent:set-thinking',
  AGENT_SET_REASONING: 'agent:set-reasoning',
  AGENT_APPROVAL_RESPOND: 'agent:approval-respond',
  AGENT_SET_APPROVAL_MODE: 'agent:set-approval-mode',
  NOTIFICATION_FOCUS_SESSION: 'notification:focus-session',
  AGENT_TASK_STOP: 'agent:task-stop',
  AGENT_REWIND: 'agent:rewind',
  AGENT_SPAWN_COWORKER: 'agent:spawn-coworker',
  AGENT_DISMISS_COWORKER: 'agent:dismiss-coworker',
  AGENT_ASK_RESPOND: 'agent:ask-respond',

  // Native dialogs
  DIALOG_SELECT_DIRECTORY: 'dialog:select-directory',

  // Recent projects from local apps
  PROJECTS_GET_RECENT: 'projects:get-recent',

  // File search (@ mention)
  FILES_SEARCH: 'files:search',
  FILES_READ: 'files:read',

  // External session import
  SESSIONS_SCAN_EXTERNAL: 'sessions:scan-external',
  SESSIONS_READ_EXTERNAL: 'sessions:read-external',
  SESSIONS_IMPORT_EXTERNAL: 'sessions:import-external',

  // Auto updater
  UPDATER_CHECK: 'updater:check',
  UPDATER_DOWNLOAD_UPDATE: 'updater:downloadUpdate',
  UPDATER_QUIT_AND_INSTALL: 'updater:quitAndInstall',
  UPDATER_SET_AUTO_UPDATE_ENABLED: 'updater:setAutoUpdateEnabled',
  UPDATER_STATUS: 'updater:status',

  // Phone second screen (pairing + relay)
  PAIR_START: 'pair:start',
  PAIR_CANCEL: 'pair:cancel',
  PAIR_REVOKE: 'pair:revoke',
  PAIR_STATUS: 'pair:status',
  PAIR_SET_RELAY: 'pair:set-relay',
  PAIR_CATALOG: 'pair:catalog',
  PAIR_STATUS_CHANGED: 'pair:status-changed',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
