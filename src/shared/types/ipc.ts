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
  OAUTH_CREDENTIAL_KEYS_LIST: 'oauth:credential-keys-list',
  OAUTH_CREDENTIALS_CHANGED: 'oauth:credentials-changed',

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
  /** 已结束 child 的 safe journal 只读回放（路径由 Main 推导，请求只带 conversationId） */
  AGENT_CHILD_HISTORY_READ: 'agent:child-history-read',
  /** 已启动会话就地换模型；worker 换完回报，Main 据此更新已启动模型记录 */
  AGENT_SET_MODEL: 'agent:set-model',
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

  // Agent type registry + sender-bound deterministic child dispatch
  AGENT_TYPES_REGISTRY_LIST: 'agent-types:registry-list',
  AGENT_MODEL_SELECTION_REGISTER: 'agent-dispatch:model-selection-register',
  AGENT_DISPATCH_BIND_SOURCE: 'agent-dispatch:bind-source',
  AGENT_DISPATCH: 'agent-dispatch:dispatch',
  AGENT_DISPATCH_EVENT: 'agent-dispatch:event',
  AGENT_SUMMON: 'agent-dispatch:summon',
  AGENT_COMPOSER_PREFILL: 'agent-dispatch:composer-prefill',

  // Main-owned project/conversation authority (generic settings are projection only)
  SOURCE_AUTHORITY_READ: 'source-authority:read',
  SOURCE_AUTHORITY_CHANGED: 'source-authority:changed',
  SOURCE_PROJECT_CREATE: 'source-authority:project-create',
  SOURCE_PROJECT_SELECT: 'source-authority:project-select',
  SOURCE_PROJECT_REMOVE: 'source-authority:project-remove',
  SOURCE_CONVERSATION_CREATE: 'source-authority:conversation-create',
  SOURCE_CONVERSATION_SELECT: 'source-authority:conversation-select',
  SOURCE_CONVERSATION_END: 'source-authority:conversation-end',
  SOURCE_CONVERSATION_REMOVE: 'source-authority:conversation-remove',
  SOURCE_CONVERSATION_UPDATE_SELECTION: 'source-authority:conversation-update-selection',

  // Enso child capability approval (result returns Main → worker command)
  CAPABILITIES_ASK: 'capabilities:ask',
  CAPABILITIES_RESPOND: 'capabilities:respond',

  // Native dialogs
  DIALOG_SELECT_DIRECTORY: 'dialog:select-directory',
  DIALOG_SELECT_FILE: 'dialog:select-file',

  // Recent projects from local apps
  PROJECTS_GET_RECENT: 'projects:get-recent',

  // File search (@ mention)
  FILES_SEARCH: 'files:search',
  FILES_READ: 'files:read',
  // 目录媒体文件枚举（背景图文件夹随机模式）
  FILES_LIST_MEDIA: 'files:list-media',

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
  /** main → renderer：手机订阅了某会话，请求恢复（历史会话在 worker 里没有投影） */
  PAIR_RESUME_SESSION: 'pair:resume-session',
  /** main → renderer：手机新建了会话，请求登记（否则桌面列表里没有它，其事件也会被丢弃） */
  PAIR_SESSION_CREATED: 'pair:session-created',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
