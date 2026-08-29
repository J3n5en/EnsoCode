import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ChildSessionIdentity } from '@shared/builtinAgents';
import { CAPABILITY_CATALOG } from '@shared/capabilities/catalog';
import type {
  CapabilityExecutionEnvelope,
  CapabilityInvokeRequest,
  CapabilityResult,
} from '@shared/capabilities/types';
import type { ProductSurfaceId } from '@shared/productSurfaces';

interface PendingInvocation {
  turnId: string;
  resolve(result: CapabilityResult): void;
  reject(error: Error): void;
}

export type EnsoCapabilityResultDisposition =
  | { ok: true }
  | { ok: false; error: 'unknown request' | 'turn mismatch' };

const isCapabilityId = (value: string): value is ProductSurfaceId =>
  Object.hasOwn(CAPABILITY_CATALOG, value);

/**
 * Enso child 与 Main Gateway 之间的挂起调用表。child 在构造时锁定，
 * 每笔结果再按 turnId/requestId 双验；abort、错配与 shutdown 全部 fail-closed。
 */
export class EnsoAppInvoker {
  private readonly pending = new Map<string, PendingInvocation>();

  constructor(
    private readonly child: ChildSessionIdentity,
    private readonly getTurnId: () => string | undefined,
    private readonly emit: (request: CapabilityInvokeRequest) => void
  ) {}

  invoke(capabilityId: string, params: unknown, signal?: AbortSignal): Promise<CapabilityResult> {
    if (!isCapabilityId(capabilityId)) {
      return Promise.reject(new Error(`unknown capability: ${capabilityId}`));
    }
    const spec = CAPABILITY_CATALOG[capabilityId];
    if (spec.execution.kind !== 'executable') {
      return Promise.reject(
        new Error(
          `capability unavailable: ${spec.execution.reason} Suggested action: ${spec.execution.suggestedAction}`
        )
      );
    }
    const turnId = this.getTurnId()?.trim();
    if (!turnId) return Promise.reject(new Error('enso_app requires an active child turn'));
    if (signal?.aborted) {
      return Promise.reject(new Error('Enso capability invocation aborted'));
    }

    const requestId = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<CapabilityResult>();
    const settle = (result: CapabilityResult | Error) => {
      if (!this.pending.delete(requestId)) return;
      signal?.removeEventListener('abort', onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onAbort = () => settle(new Error('Enso capability invocation aborted'));
    this.pending.set(requestId, {
      turnId,
      resolve: (result) => settle(result),
      reject: (error) => settle(error),
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.emit({ child: this.child, turnId, requestId, capabilityId, params });
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  resolve(
    turnId: string,
    requestId: string,
    envelope: CapabilityExecutionEnvelope
  ): EnsoCapabilityResultDisposition {
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, error: 'unknown request' };
    if (entry.turnId !== turnId) {
      entry.reject(new Error('Enso capability result turn mismatch'));
      return { ok: false, error: 'turn mismatch' };
    }
    entry.resolve(envelope.modelResult);
    return { ok: true };
  }

  cancelAll(reason = 'Enso capability invocation cancelled'): void {
    for (const entry of [...this.pending.values()]) entry.reject(new Error(reason));
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

/** Enso 领域能力执行入口；这里只发请求并等待 Main，不执行任何领域 handler。 */
/**
 * 工具参数形态归一：部分模型把对象参数序列化成 JSON 字符串下发。只在能解析出
 * 对象时才替换；其它一律原样透传，让 Main gateway 的 inputSchema 校验照常报错。
 */
function normalizeCapabilityParams(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

export function createEnsoAppTool(invoker: EnsoAppInvoker): ToolDefinition {
  return {
    name: 'enso_app',
    label: 'Enso app',
    // 注：normalizeCapabilityParams 只做形态归一（字符串化 JSON → 对象），
    // 不放宽任何校验：真正的参数合法性仍由 Main gateway 按 inputSchema 判定。
    description:
      'Invoke one executable product capability through the protected Main gateway. Parameters are ' +
      'validated and target context is bound outside this worker.',
    promptSnippet:
      'enso_app: invoke only catalog capabilities marked executable; never invent capability ids or parameters',
    parameters: {
      type: 'object',
      properties: {
        capability_id: { type: 'string', description: 'Public executable capability id' },
        // 必须声明 type：不声明时不同模型会自行猜测（实测 Claude 传 JSON 字符串、
        // Grok 传对象），字符串会被能力 inputSchema 判 "$ must be an object" 而全部失败。
        params: {
          type: 'object',
          description: 'Capability parameters matching its public input schema',
        },
      },
      required: ['capability_id', 'params'],
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    // schema 校验之前先归一：声明 params 为 object 后，字符串化载荷会在校验阶段就被拦，
    // execute 里再处理就晚了。
    prepareArguments: ((args: unknown) => {
      if (!args || typeof args !== 'object') return args;
      const record = args as Record<string, unknown>;
      const normalized = normalizeCapabilityParams(record.params);
      return normalized === record.params ? record : { ...record, params: normalized };
    }) as unknown as ToolDefinition['prepareArguments'],
    async execute(_toolCallId, params, signal) {
      const { capability_id: capabilityId, params: capabilityParams } = params as {
        capability_id?: string;
        params?: unknown;
      };
      if (!capabilityId?.trim()) throw new Error('capability_id is required');
      const result = await invoker.invoke(
        capabilityId.trim(),
        normalizeCapabilityParams(capabilityParams),
        signal
      );
      // execute 保留一道归一：不经 prepareArguments 的直接调用路径同样安全。
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        details: undefined,
      };
    },
  };
}
