import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  getSupportedThinkingLevels,
  type Model,
  type Provider,
  type ProviderRequestOptions,
} from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type InlineExtension,
  type ModelRuntime,
  VIRTUAL_MODEL_STATE_ENTRY,
} from '@earendil-works/pi-coding-agent';
import { isUuid } from '@shared/builtinAgents';
import {
  classifyCodexPoolFailure,
  isCodexAccountKey,
  type OauthPoolFailure,
} from '@shared/oauthAccountPool';
import { ensureAccountProvider } from '@shared/piAccounts';
import type { SpawnModelConfig } from '@shared/types/agent';

/**
 * Main 权威选号接口；排除集合属于当前活动，不受额度冷却窗口到期影响。取消后调用方必须拒绝延迟结果。
 *
 * Main-authoritative selection; exclusions belong to the current activity and survive quota-window expiry. Callers must reject delayed results after cancellation.
 */
export type OauthPoolSelector = (
  providerId: string,
  modelId: string,
  failed?: OauthPoolFailure,
  signal?: AbortSignal,
  excludedAccountKeys?: readonly string[]
) => Promise<string | OauthPoolSelection>;
export interface OauthPoolSelection {
  accountKey: string;
  selectionReceipt?: string;
}
const routing = new AsyncLocalStorage<{ selection?: OauthPoolSelection }>();
const requestSelection = Symbol('oauth-pool-request-selection');
type PoolRequestModel = Model<Api> & { [requestSelection]?: OauthPoolSelection };
const boundRuntimes = new WeakSet<ModelRuntime>();
const selectors = new WeakMap<ModelRuntime, OauthPoolSelector>();
const adapted = new WeakSet<Provider>();
const pooledSessions = new Set<string>();
const selectedAccounts = new Map<
  string,
  {
    accountKey?: string;
    settingsProviderId?: string;
    modelId?: string;
    notify?: (key: string, previous?: string) => void;
  }
>();
const failures = new Map<string, OauthPoolFailure>();
const PREFIX = 'enso-codex-pool:';

export function installOauthPoolSelector(runtime: ModelRuntime, selector: OauthPoolSelector): void {
  selectors.set(runtime, selector);
  if (boundRuntimes.has(runtime)) return;
  boundRuntimes.add(runtime);
  // SDK 的公开 resolveModel 会用目录模型替换路由返回的模型，所以在公开出口按请求克隆。
  // 私有 Symbol 经 prepareRequest 的 baseUrl spread 保留，但不进入 JSON；普通模型原样返回。
  //
  // Public resolveModel replaces the router's model with its catalog model, so clone at its public exit per request.
  // A private Symbol survives prepareRequest's baseUrl spread but never enters JSON; ordinary models pass through.
  const resolveModel = runtime.resolveModel.bind(runtime);
  runtime.resolveModel = (model, messages, options) => {
    if (!model.provider.startsWith(PREFIX)) return resolveModel(model, messages, options);
    return routing.run({}, async () => {
      const route = await resolveModel(model, messages, options);
      const selection = routing.getStore()?.selection;
      return selection && selection.accountKey === route.model.provider
        ? { ...route, model: { ...route.model, [requestSelection]: selection } }
        : route;
    });
  };
  // 路由预检后 SDK 还会在真实请求准备时刷新鉴权；同一请求模型上的票据必须覆盖这次刷新失败。
  //
  // After routing preflight, the SDK resolves auth again while preparing the real request; its request-local model receipt must cover that refresh failure too.
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = (model, options) => {
    if (typeof model === 'string') return getAuth(model, options);
    const selection = (model as PoolRequestModel)[requestSelection];
    if (!selection) return getAuth(model, options);
    return (async () => {
      try {
        const auth = await getAuth(model, options);
        if (!auth && !options?.signal?.aborted)
          throw new Error(
            recordFailure(
              withReceipt(
                { accountKey: model.provider, reason: 'login-invalid' },
                selection.selectionReceipt
              )
            )
          );
        return auth;
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        const failure = classifyCodexRefreshFailure(error, model.provider);
        if (!failure) throw error;
        throw new Error(recordFailure(withReceipt(failure, selection.selectionReceipt)), {
          cause: error,
        });
      }
    })();
  };
}

function withReceipt(failure: OauthPoolFailure, selectionReceipt?: string): OauthPoolFailure {
  return selectionReceipt ? { ...failure, selectionReceipt } : failure;
}

function recordFailure(failure: OauthPoolFailure): string {
  const id = randomUUID();
  if (failures.size >= 256) failures.delete(failures.keys().next().value ?? '');
  failures.set(id, failure);
  return `ChatGPT account ${failure.reason}. [enso-pool-failure:${id}]`;
}
export function releaseOauthPoolSession(sessionId: string): void {
  pooledSessions.delete(sessionId);
  selectedAccounts.delete(sessionId);
}

/**
 * 显式用户重试开始新活动；自动接替不调用此入口，失败账号仍在同活动内排除。
 *
 * An explicit user retry starts a new activity. Automatic takeover must not call
 * this entry, so failed accounts remain excluded within the same activity.
 */
export function resetOauthPoolActivity(session: AgentSession): void {
  if (!session.model?.provider.startsWith(PREFIX)) return;
  session.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, {
    provider: session.model.provider,
    modelId: session.model.id,
    state: { attempted: [] },
  });
}

export function failureForMessage(message: {
  errorMessage?: string;
}): OauthPoolFailure | undefined {
  const id = /\[enso-pool-failure:([a-f0-9-]+)\]/.exec(message.errorMessage ?? '')?.[1];
  return id ? failures.get(id) : undefined;
}

/**
 * getAuth 的公开错误保留 cause，但 Codex 仅在来源专属错误信封中保留 HTTP JSON。严格解析该信封，不按刷新失败或限速文案猜测登录失效。
 *
 * Public getAuth errors retain cause, while Codex keeps HTTP JSON only in its source-specific envelope. Parse that envelope strictly; generic refresh/rate-limit prose is not invalid-login evidence.
 */
export function classifyCodexRefreshFailure(
  error: unknown,
  accountKey: string
): OauthPoolFailure | null {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const match = /^OpenAI Codex token refresh failed \((400|401|403)\): (.{1,8000})$/s.exec(
      current.message
    );
    if (match) {
      let body: unknown;
      try {
        body = JSON.parse(match[2]);
      } catch {
        body = undefined;
      }
      const record =
        body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
      const nested = typeof record?.error === 'string' ? { code: record.error } : record?.error;
      return classifyCodexPoolFailure(Number(match[1]), { error: nested }, accountKey);
    }
    current = current.cause;
  }
  return null;
}

function attemptedAccounts(state: unknown): string[] {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return [];
  const attempted = (state as Record<string, unknown>).attempted;
  return Array.isArray(attempted)
    ? [...new Set(attempted.filter(isCodexAccountKey))].slice(0, 100)
    : [];
}

function ensurePoolProvider(runtime: ModelRuntime, key: string): void {
  ensureAccountProvider(runtime, key);
  const provider = runtime.getProvider(key);
  const native = runtime.getRegisteredNativeProvider(key);
  if (provider && !adapted.has(native ?? provider))
    runtime.registerNativeProvider(withCodexPoolEvidence(provider));
}

/**
 * 只为池会话强制 SSE 并读取真实错误 JSON；固定账号请求原样透传。证据仅保留原因和重置时间，不保留响应或凭证。
 *
 * Only pool sessions use controlled SSE and real error JSON; fixed requests pass through. Keep only reason/reset evidence, never bodies or credentials.
 */
export function withCodexPoolEvidence(provider: Provider): Provider {
  const wrap =
    (stream: Provider['streamSimple']): Provider['streamSimple'] =>
    (model, context, options) => {
      const selection = (model as PoolRequestModel)[requestSelection];
      if (!selection && (!options?.sessionId || !pooledSessions.has(options.sessionId)))
        return stream(model, context, options);
      const selectionReceipt = selection?.selectionReceipt;
      options ??= {};
      if (!options.signal?.aborted) {
        const selected = options.sessionId ? selectedAccounts.get(options.sessionId) : undefined;
        if (selected && selected.accountKey !== model.provider) {
          selected.notify?.(model.provider, selected.accountKey);
          selected.accountKey = model.provider;
        }
      }
      const captured: { evidence: OauthPoolFailure | null } = { evidence: null };
      const originalFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
      const controlledFetch: typeof fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (!response.ok) {
          let body: unknown;
          try {
            body = await response.clone().json();
          } catch {
            body = undefined;
          }
          captured.evidence = classifyCodexPoolFailure(response.status, body, model.provider);
        }
        return response;
      };
      const output = createAssistantMessageEventStream();
      const input = stream(model, context, {
        ...options,
        transport: 'sse',
        fetch: controlledFetch,
        onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            const event = data as Record<string, unknown>;
            const response =
              event.response && typeof event.response === 'object'
                ? (event.response as Record<string, unknown>)
                : undefined;
            const body = event.type === 'response.failed' ? response : event;
            if (event.type === 'error' || event.type === 'response.failed') {
              const nested = body?.error ?? body;
              const code =
                nested && typeof nested === 'object'
                  ? (nested as Record<string, unknown>).code
                  : undefined;
              const status =
                code === 'usage_limit_reached'
                  ? 429
                  : code === 'invalid_token' || code === 'token_expired'
                    ? 401
                    : 0;
              captured.evidence = classifyCodexPoolFailure(
                status,
                { error: nested },
                model.provider
              );
            }
          }
          await options.onProviderStreamEvent?.(data, eventModel);
        },
      } as ProviderRequestOptions);
      void (async () => {
        try {
          for await (const event of input) {
            const evidence = captured.evidence;
            if (
              event.type === 'error' &&
              evidence &&
              event.error.stopReason !== 'aborted' &&
              !options.signal?.aborted
            ) {
              event.error.errorMessage = recordFailure(withReceipt(evidence, selectionReceipt));
            }
            output.push(event);
          }
          output.end(await input.result());
        } catch (error) {
          const message: AssistantMessage = {
            role: 'assistant',
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [],
            timestamp: Date.now(),
            stopReason: options.signal?.aborted ? 'aborted' : 'error',
            errorMessage:
              captured.evidence && !options.signal?.aborted
                ? recordFailure(withReceipt(captured.evidence, selectionReceipt))
                : error instanceof Error
                  ? error.message
                  : 'ChatGPT provider stream failed.',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          output.push({
            type: 'error',
            reason: message.stopReason === 'aborted' ? 'aborted' : 'error',
            error: message,
          });
          output.end(message);
        }
      })();
      return output;
    };
  const clone = {
    ...provider,
    streamSimple: wrap(provider.streamSimple.bind(provider)),
    stream: wrap(provider.stream.bind(provider) as Provider['streamSimple']) as Provider['stream'],
  };
  adapted.add(clone);
  return clone;
}

/**
 * 用公开虚拟模型路由保留模型和推理选择。每次请求实时向 Main 选号并先验证 OAuth 刷新；只有确证失效才推进，瞬态刷新错误原样失败。
 *
 * Public virtual routing preserves model/thinking selection. Each request selects live through Main and validates OAuth refresh first; only confirmed invalid credentials advance, while transient refresh failures remain errors.
 */
export function resolveOauthPoolModel(runtime: ModelRuntime, config: SpawnModelConfig) {
  const select = selectors.get(runtime);
  if (!select) throw new Error('ChatGPT pool coordinator is unavailable.');
  const keys = config.oauthAccountPool?.accountKeys ?? [];
  for (const key of keys) ensurePoolProvider(runtime, key);
  const base = keys.map((key) => runtime.getModel(key, config.modelId)).find(Boolean);
  if (!base) throw new Error('ChatGPT pool model is unavailable.');
  const provider = `${PREFIX}${config.settingsProviderId}`;
  runtime.registerVirtualModel({
    provider,
    id: config.modelId,
    name: base.name,
    contextWindow: base.contextWindow,
    maxTokens: base.maxTokens,
    input: base.input,
    thinkingLevels: getSupportedThinkingLevels(base),
    route: async (request) => {
      // 每活动失败集合保存在公开 router state 中，冷却窗口到期也不能让同一任务循环重试旧账号。
      //
      // The public router state stores per-activity failures, so cooldown expiry cannot loop the same task through failed accounts.
      let failed = request.failed ? failureForMessage(request.failed.message) : undefined;
      const attempted = attemptedAccounts(request.state);
      if (failed && !attempted.includes(failed.accountKey)) attempted.push(failed.accountKey);
      for (let budget = 0; budget < 100; budget++) {
        const selected = await select(
          config.settingsProviderId,
          config.modelId,
          failed,
          request.signal,
          attempted
        );
        request.signal?.throwIfAborted();
        const selection = typeof selected === 'string' ? { accountKey: selected } : selected;
        const { accountKey: key, selectionReceipt } = selection;
        if (
          !isCodexAccountKey(key) ||
          (selectionReceipt !== undefined && !isUuid(selectionReceipt))
        )
          throw new Error('Invalid ChatGPT pool selection.');
        if (attempted.includes(key))
          throw new Error('No available ChatGPT OAuth accounts in this activity.');
        ensurePoolProvider(runtime, key);
        const model = runtime.getModel(key, config.modelId);
        if (!model) throw new Error('ChatGPT pool model is unavailable.');
        try {
          const auth = await runtime.getAuth(model, { signal: request.signal });
          request.signal?.throwIfAborted();
          if (!auth)
            failed = withReceipt({ accountKey: key, reason: 'login-invalid' }, selectionReceipt);
          else {
            if (!runtime.hasConfiguredAuth(key))
              await runtime.refresh({
                providers: [key],
                allowNetwork: false,
                signal: request.signal,
              });
            request.signal?.throwIfAborted();
            const scope = routing.getStore();
            if (scope) scope.selection = { accountKey: key, selectionReceipt };
            return { model, thinkingLevel: request.thinkingLevel, state: { attempted } };
          }
        } catch (error) {
          request.signal?.throwIfAborted();
          failed = classifyCodexRefreshFailure(error, key) ?? undefined;
          if (!failed) throw error;
          failed = withReceipt(failed, selectionReceipt);
        }
        attempted.push(key);
      }
      throw new Error('No available ChatGPT OAuth accounts in this activity.');
    },
  });
  const model = runtime.getModel(provider, config.modelId);
  if (!model) throw new Error('ChatGPT virtual model registration failed.');
  return model;
}

/**
 * 在最终结算前用公开 boundary 移除失败的上下文消息并继续；任务和工具结果保持原位，不再次 prompt。
 *
 * Before settlement, the public boundary removes only the failed context message and continues; task/tool results remain intact and prompt is never repeated.
 */
export function oauthPoolRecoveryExtension(
  select: OauthPoolSelector,
  onSelected?: (
    sessionId: string,
    key: string,
    previous: string | undefined,
    scope: { settingsProviderId: string; modelId: string }
  ) => void
): InlineExtension {
  return {
    name: 'chatgpt-oauth-pool',
    hidden: true,
    factory: (pi) => {
      pi.on('agent_start', (_event, ctx) => {
        const id = ctx.sessionManager.getSessionId();
        if (ctx.model?.provider.startsWith(PREFIX)) {
          pooledSessions.add(id);
          const scope = {
            settingsProviderId: ctx.model.provider.slice(PREFIX.length),
            modelId: ctx.model.id,
          };
          const existing = selectedAccounts.get(id);
          // 换池或换模型后同一个账号也必须重新通知；只有真实 stream 开始才产生账号证据。
          //
          // A pool/model change must notify even for the same account; evidence is emitted only when the real stream starts.
          const selected =
            existing?.settingsProviderId === scope.settingsProviderId &&
            existing.modelId === scope.modelId
              ? existing
              : { ...scope };
          selected.notify = (key, previous) => onSelected?.(id, key, previous, scope);
          selectedAccounts.set(id, selected);
        } else releaseOauthPoolSession(id);
      });
      pi.on('before_agent_start', (_event, ctx) => {
        if (!ctx.model?.provider.startsWith(PREFIX)) return;
        pi.appendEntry(VIRTUAL_MODEL_STATE_ENTRY, {
          provider: ctx.model.provider,
          modelId: ctx.model.id,
          state: { attempted: [] },
        });
      });
      pi.on('session_shutdown', (_event, ctx) =>
        releaseOauthPoolSession(ctx.sessionManager.getSessionId())
      );
      pi.on('agent_before_settle', async (event, ctx) => {
        if (
          event.outcome !== 'error' ||
          ctx.signal?.aborted ||
          !ctx.model?.provider.startsWith(PREFIX)
        )
          return;
        const latest = [...event.context.contextEntries]
          .reverse()
          .find((entry) => entry.sourceEntry.type === 'message');
        if (
          latest?.sourceEntry.type !== 'message' ||
          latest.sourceEntry.message.role !== 'assistant'
        )
          return;
        const message = latest.sourceEntry.message as AssistantMessage;
        const failed = failureForMessage(message);
        if (!failed || message.stopReason !== 'error') return;
        const stateEntry = [...ctx.sessionManager.getBranch()]
          .reverse()
          .find(
            (entry) =>
              entry.type === 'custom' &&
              entry.customType === VIRTUAL_MODEL_STATE_ENTRY &&
              entry.data &&
              typeof entry.data === 'object' &&
              (entry.data as Record<string, unknown>).provider === ctx.model?.provider &&
              (entry.data as Record<string, unknown>).modelId === ctx.model?.id
          );
        const attempted = attemptedAccounts(
          stateEntry?.type === 'custom'
            ? (stateEntry.data as Record<string, unknown>).state
            : undefined
        );
        if (!attempted.includes(failed.accountKey)) attempted.push(failed.accountKey);
        try {
          await select(
            ctx.model.provider.slice(PREFIX.length),
            ctx.model.id,
            failed,
            ctx.signal,
            attempted
          );
          if (ctx.signal?.aborted) return;
          return {
            entries: [
              ...event.entries,
              { type: 'context_edit' as const, targetId: latest.sourceEntry.id, replacement: null },
              {
                type: 'custom' as const,
                customType: VIRTUAL_MODEL_STATE_ENTRY,
                data: { provider: ctx.model.provider, modelId: ctx.model.id, state: { attempted } },
              },
            ],
            continue: true,
          };
        } catch (error) {
          if (!ctx.signal?.aborted)
            message.errorMessage =
              error instanceof Error ? error.message : 'No available ChatGPT OAuth accounts.';
          return;
        }
      });
    },
  };
}
