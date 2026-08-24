export const IPC_CHANNELS = {
  // Settings persistence
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
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
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
