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

  // Local skill / MCP scan/import
  ASSETS_SCAN_LOCAL: 'assets:scan-local',
  ASSETS_COLLECT_IMPORT: 'assets:collect-import',

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
  AGENT_SPAWN_COWORKER: 'agent:spawn-coworker',
  AGENT_DISMISS_COWORKER: 'agent:dismiss-coworker',

  // Native dialogs
  DIALOG_SELECT_DIRECTORY: 'dialog:select-directory',

  // File search (@ mention)
  FILES_SEARCH: 'files:search',
  FILES_READ: 'files:read',

  // External session import
  SESSIONS_SCAN_EXTERNAL: 'sessions:scan-external',
  SESSIONS_READ_EXTERNAL: 'sessions:read-external',
  SESSIONS_IMPORT_EXTERNAL: 'sessions:import-external',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
