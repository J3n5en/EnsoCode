import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PluginArtifactInfo } from '@shared/extensionPlugins/protocol';
import type { PluginToolDescriptor } from '@shared/extensionPlugins/types';
import type { SessionIdentity } from '@shared/types/agent';

export interface PluginToolInvokeRequest {
  identity: SessionIdentity;
  requestId: string;
  toolName: string;
  args: unknown;
}

export interface PluginToolInvokeResult {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface Pending {
  settle(outcome: unknown, cancelRemote?: boolean): void;
  onUpdate?: (partial: { content: [{ type: 'text'; text: string }]; details: undefined }) => void;
}

/** Main 侧 60 秒超时之外的余量 */
const DEFAULT_TIMEOUT_MS = 70_000;
const TOOL_TIMEOUT_SLACK_MS = 10_000;

export function pluginToolLocalTimeoutMs(timeoutMs?: number): number {
  return (timeoutMs ?? 60_000) + TOOL_TIMEOUT_SLACK_MS;
}

const isArtifact = (value: unknown): value is PluginArtifactInfo => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const artifact = value as Partial<PluginArtifactInfo>;
  return (
    typeof artifact.id === 'string' &&
    typeof artifact.name === 'string' &&
    typeof artifact.mime === 'string' &&
    typeof artifact.size === 'number' &&
    Number.isFinite(artifact.size)
  );
};

/** 给模型的一行产出清单；没有可描述的产出时为空 */
export function formatPluginArtifactLine(artifacts: readonly unknown[]): string {
  const listed = artifacts.filter(isArtifact);
  if (listed.length === 0) return '';
  const items = listed
    .map((artifact) => `${artifact.name}（${artifact.mime}，${artifact.size}）`)
    .join('、');
  return `[产出文件] ${items}`;
}

/**
 * worker ↔ Main 的插件工具挂起表：`plugin-tool-invoke` 上抛，`plugin-tool-result` 回落；
 * abort / 超时 / shutdown 本地 fail-closed，并经 `plugin-tool-cancel` 让 Main 取消插件调用。
 */
export class PluginToolInvoker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly identity: SessionIdentity,
    private readonly emit: (request: PluginToolInvokeRequest) => void,
    private readonly options: { timeoutMs?: number; emitCancel?: (requestId: string) => void } = {}
  ) {}

  invoke(
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
    hooks?: {
      timeoutMs?: number;
      onUpdate?: Pending['onUpdate'];
    }
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('Plugin tool aborted'));
    const requestId = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timeoutMs = hooks?.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(
      () => settle(new Error(`Plugin tool ${toolName} timed out after ${timeoutMs}ms`), true),
      timeoutMs
    );
    const onAbort = () => settle(new Error('Plugin tool aborted'), true);
    const settle = (outcome: unknown, cancelRemote = false) => {
      if (!this.pending.delete(requestId)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (cancelRemote) {
        try {
          this.options.emitCancel?.(requestId);
        } catch {
          // 会话已释放：Main 侧由 worker 退出兜底取消
        }
      }
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    this.pending.set(requestId, { settle, onUpdate: hooks?.onUpdate });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.emit({ identity: this.identity, requestId, toolName, args });
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  resolve(result: PluginToolInvokeResult): boolean {
    const entry = this.pending.get(result.requestId);
    if (!entry) return false;
    entry.settle(result.ok ? result.result : new Error(result.error || 'Plugin tool failed'));
    return true;
  }

  progress(requestId: string, text: string): void {
    const entry = this.pending.get(requestId);
    if (!entry?.onUpdate) return;
    try {
      entry.onUpdate({ content: [{ type: 'text', text }], details: undefined });
    } catch {
      // 进度展示失败不影响工具结果
    }
  }

  cancelAll(reason = 'Plugin tool cancelled'): void {
    for (const entry of [...this.pending.values()]) entry.settle(new Error(reason), true);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

export function createPluginTools(
  descriptors: PluginToolDescriptor[],
  invoker: Pick<PluginToolInvoker, 'invoke'>
): ToolDefinition[] {
  return descriptors.map((descriptor) => ({
    name: descriptor.name,
    label: descriptor.name,
    description: descriptor.description,
    parameters: descriptor.parameters as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params, signal, onUpdate) {
      const result = (await invoker.invoke(descriptor.name, params ?? {}, signal, {
        timeoutMs: pluginToolLocalTimeoutMs(descriptor.timeoutMs),
        onUpdate,
      })) as { content?: unknown; details?: unknown; artifacts?: unknown };
      const artifacts = Array.isArray(result?.artifacts) ? result.artifacts.filter(isArtifact) : [];
      const text = typeof result?.content === 'string' ? result.content : '';
      const artifactsLine = formatPluginArtifactLine(artifacts);
      return {
        content: [
          {
            type: 'text' as const,
            text: artifactsLine ? (text ? `${text}\n${artifactsLine}` : artifactsLine) : text,
          },
        ],
        details: { details: result?.details, artifacts },
      };
    },
  }));
}
