/** Main ↔ 插件进程的帧协议；一帧一条 JSON 消息 */

export const PLUGIN_CALL_METHODS = [
  'tool.execute',
  'command.run',
  'trigger.candidates',
  'trigger.pick',
  'renderer.call',
] as const;
export type PluginCallMethod = (typeof PLUGIN_CALL_METHODS)[number];

export const PLUGIN_HOST_APIS = [
  'fs.readText',
  'fs.writeText',
  'net.fetch',
  'ui.notify',
  'composer.readDraft',
  'composer.insertText',
  'composer.replaceDraft',
  'config.get',
  'mcp.tools',
  'mcp.call',
] as const;
export type PluginHostApi = (typeof PLUGIN_HOST_APIS)[number];

export interface PluginErrorShape {
  code: string;
  message: string;
}

export interface PluginRegistrations {
  tools: string[];
  commands: string[];
  triggers: string[];
  rendererMethods: string[];
}

export type PluginResponse =
  | { t: 'res'; id: string; ok: true; value: unknown }
  | { t: 'res'; id: string; ok: false; error: PluginErrorShape };

export type MainToPluginHost =
  | { t: 'init'; pluginId: string; pluginRoot: string; main: string; dataDir: string }
  | {
      t: 'call';
      id: string;
      method: PluginCallMethod;
      payload: unknown;
      invocationId: string;
      sessionId: string | null;
      /** Main 推导的项目根；无本机项目为 null */
      projectRoot: string | null;
    }
  | { t: 'cancel'; invocationId: string }
  | PluginResponse;

export type PluginHostToMain =
  | { t: 'ready'; registered: PluginRegistrations }
  | { t: 'init-error'; message: string }
  | { t: 'call'; id: string; api: PluginHostApi; args: unknown; invocationId?: string }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | PluginResponse;

/** 工具结果：插件可返回字符串或 { content, details } */
export interface PluginToolResult {
  content: string;
  details?: unknown;
}
