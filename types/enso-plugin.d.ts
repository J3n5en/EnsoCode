/** 插件作者用的 enso API。从宿主实现再导出；引用本文件，不要复制。 */

import type * as React from 'react';
import type { PluginSlotName } from '../src/renderer/plugins/registry';
import type {
  ContextUsagePayload,
  InputPayload,
  PluginEventName,
  ToolCallPayload,
  ToolResultPayload,
} from '../src/shared/extensionPlugins/events';
import type {
  ExtensionPluginManifest,
  ExtensionPluginPermission,
} from '../src/shared/extensionPlugins/manifest';
import type {
  PluginAgentSource,
  PluginArtifactInfo,
  PluginHostCapabilities,
  PluginInjectImage,
  PluginToolResult,
} from '../src/shared/extensionPlugins/protocol';

export type {
  ExtensionPluginManifest,
  ExtensionPluginPermission,
  PluginAgentSource,
  PluginArtifactInfo,
  PluginEventName,
  PluginHostCapabilities,
  PluginInjectImage,
  PluginSlotName,
  PluginToolResult,
};

/** 作者编写的 enso-plugin.json。解析后的 `engines.enso` 会变成 `ExtensionPluginManifest.ensoRange`。 */
export type EnsoPluginManifest = Omit<
  ExtensionPluginManifest,
  | 'ensoRange'
  | 'description'
  | 'permissions'
  | 'fs'
  | 'net'
  | 'mcp'
  | 'resident'
  | 'env'
  | 'interop'
  | 'contributes'
> & {
  description?: string;
  engines?: { enso?: string };
  permissions?: ExtensionPluginPermission[];
  fs?: { read?: string[]; write?: string[] };
  net?: { domains?: string[] };
  mcp?: { tools?: string[] };
  resident?: boolean;
  env?: string[];
  interop?: { call?: string[] };
  contributes?: Omit<Partial<ExtensionPluginManifest['contributes']>, 'dynamic'> & {
    dynamic?: { tools?: number; commands?: number };
  };
};

export interface EnsoSessionInfo {
  id: string;
  title: string;
  updatedAt: number;
  running?: boolean;
  archived?: boolean;
}

export interface EnsoMcpTool {
  server: string;
  name: string;
  description: string;
}

export interface EnsoFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  responseType?: 'text' | 'base64';
}

export interface EnsoFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface EnsoDraft {
  text: string;
  hasReferences: boolean;
  generation: unknown;
  rev: unknown;
}

export interface EnsoDraftRev {
  rev: unknown;
}

export interface EnsoDraftExpect {
  generation: unknown;
  rev: unknown;
}

export type EnsoArtifactWrite =
  | { name: string; text: string; mime?: string }
  | { name: string; base64: string; mime?: string };

export interface EnsoInjectInput {
  text: string;
  images?: PluginInjectImage[];
  sessionId?: string;
  deliverAs?: 'nextTurn' | 'steer' | 'followUp';
  triggerTurn?: boolean;
}

export type EnsoContribRegister =
  | {
      kind: 'tool';
      name: string;
      description: string;
      parameters: { type: 'object'; [key: string]: unknown };
      timeoutMs?: number;
    }
  | { kind: 'command'; name: string; title: string };

/** 每个 `PluginHostApi` 在作者侧的对应函数。动态注册走 contrib.*，进度走 `ctx.progress`。 */
export interface EnsoHostApi {
  'fs.readText': (path: string) => Promise<string>;
  'fs.writeText': (path: string, text: string) => Promise<void>;
  'net.fetch': (url: string, init?: EnsoFetchInit) => Promise<EnsoFetchResponse>;
  'ui.notify': (title: string, body?: string) => Promise<void>;
  'composer.readDraft': () => Promise<EnsoDraft>;
  'composer.insertText': (input: { text: string }) => Promise<EnsoDraftRev>;
  'composer.replaceDraft': (input: {
    text: string;
    expect?: EnsoDraftExpect;
  }) => Promise<EnsoDraftRev>;
  'config.get': () => Promise<Record<string, string | number | boolean>>;
  'mcp.tools': () => Promise<EnsoMcpTool[]>;
  'mcp.call': (
    server: string,
    tool: string,
    args?: Record<string, unknown>
  ) => Promise<{ content: string; isError: boolean }>;
  'tool.progress': (text: string) => Promise<unknown>;
  'artifact.write': (input: EnsoArtifactWrite) => Promise<PluginArtifactInfo>;
  'session.inject': (input: EnsoInjectInput) => Promise<void>;
  'session.abort': (sessionId?: string) => Promise<void>;
  'plugin.call': (pluginId: string, name: string, args?: unknown) => Promise<unknown>;
  'ui.clipboard': (text: string) => Promise<void>;
  'ui.openExternal': (url: string) => Promise<void>;
  'contrib.register': (input: EnsoContribRegister) => Promise<void>;
  'contrib.unregister': (input: { kind: 'tool' | 'command'; name: string }) => Promise<void>;
  'host.capabilities': () => Promise<PluginHostCapabilities>;
  'session.list': () => Promise<{ current: string; sessions: EnsoSessionInfo[] }>;
  'session.focus': (sessionId: string) => Promise<void>;
  'session.create': (input?: { text?: string }) => Promise<{ sessionId: string }>;
}

export interface EnsoCallContext {
  sessionId: string | null;
  projectRoot: string | null;
  agent: PluginAgentSource | null;
  invocationId: string;
  signal: AbortSignal;
  progress: EnsoHostApi['tool.progress'];
  /** 仅 `exports.handle` 的处理函数会带上调用方插件 id */
  caller?: string;
}

export interface EnsoEventData {
  session_start: { reason: string };
  session_end: { reason: string };
  agent_start: Record<string, never>;
  agent_end: { text: string };
  before_compact: { reason: string };
  after_compact: { reason: string };
  tool_call: ToolCallPayload;
  tool_result: ToolResultPayload;
  input: InputPayload;
  context_usage: ContextUsagePayload;
}

export type EnsoToolResult = string | Pick<PluginToolResult, 'content' | 'details'>;

export type EnsoToolHandler = (
  args: Record<string, unknown>,
  ctx: EnsoCallContext
) => EnsoToolResult | Promise<EnsoToolResult>;

export interface EnsoToolMeta {
  description: string;
  parameters: { type: 'object'; [key: string]: unknown };
  timeoutMs?: number;
}

export interface EnsoCommandMeta {
  title: string;
}

export type EnsoDisposable = () => void;

/** `main.mjs` 的 `activate(enso)`。 */
export interface EnsoMain {
  pluginId: string;
  dataDir: string;
  tools: {
    register(
      name: string,
      handler: EnsoToolHandler,
      meta?: EnsoToolMeta
    ): EnsoDisposable | Promise<EnsoDisposable>;
  };
  commands: {
    register(
      id: string,
      handler: (ctx: EnsoCallContext) => unknown,
      meta?: EnsoCommandMeta
    ): EnsoDisposable | Promise<EnsoDisposable>;
  };
  triggers: {
    register(
      name: string,
      handlers: {
        candidates: (
          query: string,
          ctx: EnsoCallContext
        ) =>
          | Array<{ id: string; label: string; detail?: string }>
          | Promise<Array<{ id: string; label: string; detail?: string }>>;
        pick: (
          item: unknown,
          ctx: EnsoCallContext
        ) => string | { text: string } | null | Promise<string | { text: string } | null>;
      }
    ): EnsoDisposable;
  };
  renderer: {
    handle(
      method: string,
      handler: (args: unknown, ctx: EnsoCallContext) => unknown
    ): EnsoDisposable;
  };
  events: {
    on<E extends PluginEventName>(
      event: E,
      handler: (data: EnsoEventData[E], ctx: EnsoCallContext) => unknown
    ): EnsoDisposable;
  };
  schedules: {
    register(id: string, handler: (ctx: EnsoCallContext) => unknown): EnsoDisposable;
  };
  exports: {
    handle(name: string, handler: (args: unknown, ctx: EnsoCallContext) => unknown): EnsoDisposable;
  };
  plugins: { call: EnsoHostApi['plugin.call'] };
  artifacts: { write: EnsoHostApi['artifact.write'] };
  session: {
    inject: EnsoHostApi['session.inject'];
    abort: EnsoHostApi['session.abort'];
    list: EnsoHostApi['session.list'];
    focus: EnsoHostApi['session.focus'];
    create: EnsoHostApi['session.create'];
  };
  host: { capabilities: EnsoHostApi['host.capabilities'] };
  fs: { readText: EnsoHostApi['fs.readText']; writeText: EnsoHostApi['fs.writeText'] };
  net: { fetch: EnsoHostApi['net.fetch'] };
  ui: {
    notify: EnsoHostApi['ui.notify'];
    clipboard: { writeText: EnsoHostApi['ui.clipboard'] };
    openExternal: EnsoHostApi['ui.openExternal'];
  };
  composer: {
    readDraft: EnsoHostApi['composer.readDraft'];
    insertText: EnsoHostApi['composer.insertText'];
    replaceDraft: EnsoHostApi['composer.replaceDraft'];
  };
  config: { get: EnsoHostApi['config.get'] };
  mcp: { tools: EnsoHostApi['mcp.tools']; call: EnsoHostApi['mcp.call'] };
}

export type EnsoSlotRegistration =
  | {
      slot: Extract<PluginSlotName, 'message.action'>;
      position: 'left' | 'right';
      component: (props: {
        position: 'left' | 'right';
        text: string;
        messageIndex: number;
        sessionId: string | null;
      }) => unknown;
    }
  | {
      slot: Extract<PluginSlotName, 'tool.card'>;
      toolName: string;
      component: (props: { toolName: string; output: string | null; state: string }) => unknown;
    }
  | {
      slot: Extract<PluginSlotName, 'block'>;
      language: string;
      component: (props: { language: string; source: string }) => unknown;
    }
  | {
      slot: Extract<PluginSlotName, 'composer.left' | 'composer.right'>;
      component: (props: {
        position: 'left' | 'right';
        sessionId: string | null;
        draft: string;
        busy: boolean;
        pluginPresetId: string | null;
      }) => unknown;
    }
  | {
      slot: Extract<PluginSlotName, 'thinking.body'>;
      component: (props: { text: string; streaming: boolean; itemKey: string }) => unknown;
    }
  | {
      slot: Extract<PluginSlotName, 'message.leaf'>;
      component: (props: {
        source: string;
        final: boolean;
        messageIndex: number;
        sessionId: string | null;
        Markdown: (props: { text: string }) => unknown;
      }) => unknown;
    };

/** `ui.js` 的 `onLoad(enso)`。`composer` 只在申请了 `composer.draft` 时存在。 */
export interface EnsoUi {
  React: typeof React;
  slots: { register(registration: EnsoSlotRegistration): EnsoDisposable };
  dispatch(action: 'plugin.call', payload: { method: string; args?: unknown }): Promise<unknown>;
  composer?: {
    readDraft: EnsoHostApi['composer.readDraft'];
    insertText: EnsoHostApi['composer.insertText'];
    replaceDraft: EnsoHostApi['composer.replaceDraft'];
  };
}

/** 侧栏 iframe 里的 `window.enso`。`theme` 随宿主主题更新，`onTheme` 订阅变化并返回取消函数。 */
export interface EnsoView {
  readonly theme: 'light' | 'dark';
  onTheme(listener: (theme: 'light' | 'dark') => void): () => void;
  call(method: string, args?: unknown): Promise<unknown>;
  readonly storage: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
}
