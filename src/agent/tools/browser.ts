import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { assertAllowedUrl, isLoopbackHost } from '@shared/browser/urlPolicy';
import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type { BrowserOp, SessionIdentity } from '@shared/types/agent';
import type { ApprovalGate } from '../approval';

export interface BrowserInvokeRequest {
  identity: SessionIdentity | ChildSessionIdentity;
  requestId: string;
  op: BrowserOp;
  params: unknown;
}

export interface BrowserInvokeResult {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * worker ↔ Main 的内嵌浏览器挂起调用表。请求经 `browser-invoke` 事件上抛，
 * 结果经 `browser-result` 命令回落；abort / 超时 / shutdown 全部 fail-closed。
 */
export class BrowserInvoker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly identity: SessionIdentity | ChildSessionIdentity,
    private readonly emit: (request: BrowserInvokeRequest) => void,
    private readonly options: { timeoutMs?: number } = {}
  ) {}

  invoke(op: BrowserOp, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('Browser action aborted'));
    const requestId = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(
      () => settle(new Error(`Browser action ${op} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    const onAbort = () => settle(new Error('Browser action aborted'));
    const settle = (outcome: unknown) => {
      if (!this.pending.delete(requestId)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    this.pending.set(requestId, { resolve: settle, reject: settle });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.emit({ identity: this.identity, requestId, op, params });
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  /** Main 回落；未知 requestId 返回 false（已超时 / 已取消）。 */
  resolve(result: BrowserInvokeResult): boolean {
    const entry = this.pending.get(result.requestId);
    if (!entry) return false;
    if (result.ok) entry.resolve(result.result);
    else entry.reject(new Error(result.error || 'Browser action failed'));
    return true;
  }

  cancelAll(reason = 'Browser action cancelled'): void {
    for (const entry of [...this.pending.values()]) entry.reject(new Error(reason));
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

type Params = Record<string, unknown>;

const str = (params: Params, key: string): string | undefined => {
  const value = params[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

const requireStr = (params: Params, key: string): string => {
  const value = str(params, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
};

const textResult = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
  details: undefined,
});

const schema = (
  properties: Record<string, unknown>,
  required: string[] = []
): ToolDefinition['parameters'] =>
  ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }) as unknown as ToolDefinition['parameters'];

/** 内嵌浏览器工具（第一刀五个）。页面活在 Main，这里只发命令、收结果。 */
export function createBrowserTools(invoker: BrowserInvoker): ToolDefinition[] {
  const define = (
    name: string,
    label: string,
    description: string,
    parameters: ToolDefinition['parameters'],
    run: (params: Params, signal: AbortSignal | undefined) => Promise<unknown>
  ): ToolDefinition => ({
    name,
    label,
    description,
    parameters,
    // 同一 tab 上的操作有先后依赖（navigate 会清掉 snapshot 的 ref），并行必乱
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      const value = await run((params ?? {}) as Params, signal);
      if (name === 'browser_screenshot' && isImage(value)) {
        return {
          content: [{ type: 'image' as const, data: value.data, mimeType: value.mimeType }],
          details: undefined,
        };
      }
      return textResult(value);
    },
  });

  return [
    define(
      'browser_navigate',
      'Browser navigate',
      "Open a URL in Enso's built-in browser (http/https only; localhost is allowed without approval). " +
        'Opens the Browser side panel so the user can see the page. Returns the title and final URL. Call browser_snapshot next to read the page.',
      schema(
        {
          url: { type: 'string', description: 'Absolute http(s) URL' },
          newTab: { type: 'boolean', description: 'Open in a new tab (default false)' },
        },
        ['url']
      ),
      (params, signal) =>
        invoker.invoke(
          'navigate',
          { url: requireStr(params, 'url'), newTab: params.newTab === true },
          signal
        )
    ),
    define(
      'browser_snapshot',
      'Browser snapshot',
      'Return an accessibility-style text tree of the current page. Interactive elements carry [ref=eN]; ' +
        'use those refs with browser_click / browser_type. Refs expire after navigation or the next snapshot.',
      schema({}),
      (_params, signal) => invoker.invoke('snapshot', {}, signal)
    ),
    define(
      'browser_click',
      'Browser click',
      'Click an element by its ref from the latest browser_snapshot.',
      schema({ ref: { type: 'string', description: 'Element ref such as e3' } }, ['ref']),
      (params, signal) => invoker.invoke('click', { ref: requireStr(params, 'ref') }, signal)
    ),
    define(
      'browser_type',
      'Browser type',
      'Replace the text of an input / textarea / contenteditable identified by ref, then optionally press Enter.',
      schema(
        {
          ref: { type: 'string', description: 'Element ref such as e3' },
          text: { type: 'string', description: 'Text to set (existing value is replaced)' },
          submit: { type: 'boolean', description: 'Press Enter after typing (default false)' },
        },
        ['ref', 'text']
      ),
      (params, signal) =>
        invoker.invoke(
          'type',
          {
            ref: requireStr(params, 'ref'),
            text: typeof params.text === 'string' ? params.text : '',
            submit: params.submit === true,
          },
          signal
        )
    ),
    define(
      'browser_tabs',
      'Browser tabs',
      'List, create, close, or select a browser tab in this conversation. Use action=list to see index/url/title; new to open a blank tab; select/close with index (0-based). Navigate after new/select.',
      schema({
        action: {
          type: 'string',
          enum: ['list', 'new', 'close', 'select'],
          description: 'Operation to perform (default list)',
        },
        index: {
          type: 'number',
          description: 'Tab index. Required for select. Optional for close (defaults to current).',
        },
      }),
      (params, signal) => {
        const action =
          params.action === 'new' || params.action === 'close' || params.action === 'select'
            ? params.action
            : 'list';
        const index = typeof params.index === 'number' ? params.index : undefined;
        return invoker.invoke(
          'tabs',
          { action, ...(index !== undefined ? { index } : {}) },
          signal
        );
      }
    ),
    define(
      'browser_lock',
      'Browser lock',
      'Lock the current tab: it stays open after the turn ends, and a page overlay blocks the user from clicking until they press Take control. Pass release=true when done.',
      schema({ release: { type: 'boolean', description: 'Release the lock (default false)' } }),
      (params, signal) => invoker.invoke('lock', { release: params.release === true }, signal)
    ),
    define(
      'browser_fill',
      'Browser fill',
      'Set the value of an input / textarea / contenteditable by ref (replaces existing text). Prefer this over type for forms.',
      schema(
        {
          ref: { type: 'string', description: 'Element ref such as e3' },
          value: { type: 'string', description: 'Value to set' },
        },
        ['ref', 'value']
      ),
      (params, signal) =>
        invoker.invoke(
          'fill',
          {
            ref: requireStr(params, 'ref'),
            value: typeof params.value === 'string' ? params.value : '',
          },
          signal
        )
    ),
    define(
      'browser_press_key',
      'Browser press key',
      'Press a key on the focused element (Enter, Tab, Escape, ArrowDown, ...).',
      schema({ key: { type: 'string', description: 'Key name such as Enter' } }, ['key']),
      (params, signal) => invoker.invoke('press_key', { key: requireStr(params, 'key') }, signal)
    ),
    define(
      'browser_scroll',
      'Browser scroll',
      'Scroll the page or an element. direction is up or down; optional ref scrolls that element.',
      schema({
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number', description: 'Pixels (default 400)' },
        ref: { type: 'string', description: 'Optional element ref to scroll' },
      }),
      (params, signal) =>
        invoker.invoke(
          'scroll',
          {
            direction: params.direction === 'up' ? 'up' : 'down',
            ...(typeof params.amount === 'number' ? { amount: params.amount } : {}),
            ...(typeof params.ref === 'string' ? { ref: params.ref } : {}),
          },
          signal
        )
    ),
    define(
      'browser_select_option',
      'Browser select option',
      'Select one or more options in a <select> by ref.',
      schema(
        {
          ref: { type: 'string' },
          values: { type: 'array', items: { type: 'string' } },
          value: { type: 'string' },
        },
        ['ref']
      ),
      (params, signal) =>
        invoker.invoke(
          'select_option',
          {
            ref: requireStr(params, 'ref'),
            ...(Array.isArray(params.values) ? { values: params.values } : {}),
            ...(typeof params.value === 'string' ? { value: params.value } : {}),
          },
          signal
        )
    ),
    define(
      'browser_mouse_click_xy',
      'Browser click xy',
      'Click at viewport coordinates. Prefer browser_click with a snapshot ref when possible.',
      schema(
        {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        ['x', 'y']
      ),
      (params, signal) =>
        invoker.invoke('click_xy', { x: Number(params.x), y: Number(params.y) }, signal)
    ),
    define(
      'browser_drag',
      'Browser drag',
      'Drag from one ref or x,y to another ref or x,y.',
      schema({
        fromRef: { type: 'string' },
        toRef: { type: 'string' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
      }),
      (params, signal) => invoker.invoke('drag', params, signal)
    ),
    define(
      'browser_highlight',
      'Browser highlight',
      'Outline an element by ref for two seconds (visual debug).',
      schema({ ref: { type: 'string' } }, ['ref']),
      (params, signal) => invoker.invoke('highlight', { ref: requireStr(params, 'ref') }, signal)
    ),
    define(
      'browser_get_bounding_box',
      'Browser bounding box',
      'Return the viewport bounding box of a snapshot ref.',
      schema({ ref: { type: 'string' } }, ['ref']),
      (params, signal) => invoker.invoke('bounding_box', { ref: requireStr(params, 'ref') }, signal)
    ),
    define(
      'browser_screenshot',
      'Browser screenshot',
      'Capture the visible viewport, or a single element when ref is set.',
      schema({ ref: { type: 'string', description: 'Optional element ref to crop' } }),
      (params, signal) =>
        invoker.invoke(
          'screenshot',
          typeof params.ref === 'string' ? { ref: params.ref } : {},
          signal
        )
    ),
    define(
      'browser_cdp',
      'Browser CDP',
      'Send a Chrome DevTools Protocol command for debugging (Runtime.evaluate, DOM, CSS, Profiler, Performance, Network.enable). ' +
        'Do not use Input.*, cookies, Page.navigate, downloads, or Target.* — use dedicated browser tools instead.',
      schema(
        {
          method: { type: 'string', description: 'CDP method such as Runtime.evaluate' },
          params: { type: 'object', description: 'CDP params object' },
        },
        ['method']
      ),
      (params, signal) =>
        invoker.invoke(
          'cdp',
          {
            method: requireStr(params, 'method'),
            ...(params.params && typeof params.params === 'object'
              ? { params: params.params }
              : {}),
          },
          signal
        )
    ),
  ];
}

/**
 * 只有 navigate 到非环回 origin 才走审批（localhost 是开发者自己的服务）。
 * 快照 / 点击 / 截图在已放行的页面里不再打扰。
 */
export function withNavigateApproval(gate: ApprovalGate, tool: ToolDefinition): ToolDefinition {
  if (tool.name !== 'browser_navigate') return tool;
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const raw = (params as Params | undefined)?.url;
      let host = '';
      try {
        host = typeof raw === 'string' ? assertAllowedUrl(raw).hostname : '';
      } catch {
        // 非法 URL 交给 tool 本体报错
      }
      if (host && !isLoopbackHost(host) && gate.needsApproval('mcp', tool.name)) {
        const result = await gate.ask(
          tool.name,
          'mcp',
          `Open ${host} in the built-in browser`,
          signal
        );
        if (result === 'block') throw new Error('Assistant approval blocked this operation');
        if (result === 'deny') throw new Error('User denied this operation');
        if (result === 'cancel') throw new Error('Approval cancelled');
      }
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

const isImage = (value: unknown): value is { data: string; mimeType: string } =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as { data?: unknown }).data === 'string' &&
  typeof (value as { mimeType?: unknown }).mimeType === 'string';
