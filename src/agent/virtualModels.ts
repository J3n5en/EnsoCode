import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type Provider,
} from '@earendil-works/pi-ai';
import type { ModelRoute, ModelRouteRequest, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SpawnModelConfig } from '@shared/types';
import { VIRTUAL_PROVIDER_ID } from '@shared/virtualModels';

export interface VirtualMembers {
  primary: Model<Api>;
  fast?: Model<Api>;
  fallbacks: Model<Api>[];
}

export type VirtualTier = 'simple' | 'complex';

/** 写在会话分支上的路由状态；只在变化时返回新对象，避免每个请求都追加条目。 */
export interface VirtualRouterState {
  /** 本轮已失败的成员（provider/id），新一轮用户输入时清空 */
  failed?: string[];
  /** 分类器生效的档位与连续判为 simple 的轮数（降档滞回用） */
  tier?: VirtualTier;
  simpleStreak?: number;
}

/** 新一轮用户输入时的档位选择（分类器）；返回首选成员与要合并的状态。 */
export type VirtualChooser = (
  request: ModelRouteRequest<VirtualRouterState>,
  members: VirtualMembers
) => Promise<{ preferred?: Model<Api>; state?: VirtualRouterState } | undefined>;

/** 上下文预估超过窗口这个比例就换窗口更大的成员；留余量给输出与系统提示 */
const CONTEXT_HEADROOM = 0.85;

export const memberKey = (model: Pick<Model<Api>, 'provider' | 'id'>): string =>
  `${model.provider}/${model.id}`;

const registry = new Map<string, VirtualMembers>();

const isAbortError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'AbortError' || /\bRequest aborted\b/.test(error.message));

export function isVirtualPiModel(model: { api?: string } | undefined): boolean {
  return model?.api === 'pi-virtual';
}

/** 不走路由的直接调用（压缩摘要、记忆提炼）要的真实模型：快模型优先。 */
export function directModelFor<T extends { api?: string; id?: string }>(model: T): T | Model<Api> {
  if (!isVirtualPiModel(model)) return model;
  const members = model.id ? registry.get(model.id) : undefined;
  return members ? (members.fast ?? members.primary) : model;
}

/** 有序去重的候选：主模型 → 备用 → 快模型（故障转移的最后手段） */
function chain(members: VirtualMembers): Model<Api>[] {
  const ordered: Model<Api>[] = [];
  for (const model of [members.primary, ...members.fallbacks, members.fast]) {
    if (model && !ordered.some((kept) => memberKey(kept) === memberKey(model))) ordered.push(model);
  }
  return ordered;
}

function isImagePart(part: unknown): boolean {
  return Boolean(part) && typeof part === 'object' && (part as { type?: unknown }).type === 'image';
}

/** 最近一次 assistant 之后的输入（本轮用户消息 / 工具结果）是否带图片 */
export function pendingInputHasImage(messages: readonly Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'assistant') return false;
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content) && content.some(isImagePart)) return true;
  }
  return false;
}

/** 单张图片按固定 token 估（base64 字节数与实际计费无关） */
const IMAGE_TOKENS = 1500;

function partChars(part: unknown): number {
  if (typeof part === 'string') return part.length;
  if (!part || typeof part !== 'object') return 0;
  const record = part as Record<string, unknown>;
  if (record.type === 'image') return IMAGE_TOKENS * 4;
  if (typeof record.text === 'string') return record.text.length;
  if (typeof record.thinking === 'string') return record.thinking.length;
  return JSON.stringify(record.arguments ?? record.input ?? '').length;
}

/**
 * 粗估请求体 token：按 4 字符 1 token 数当前上下文（含压缩后的摘要），图片按固定值。
 * 不用最近一次响应的 usage：压缩后保留的旧回复仍带着压缩前的大用量。
 */
export function estimateRequestTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    chars += Array.isArray(content)
      ? content.reduce<number>((sum, part) => sum + partChars(part), 0)
      : partChars(content);
  }
  return Math.ceil(chars / 4);
}

/**
 * pi 把最后一条 assistant 之后出现的 user 消息都算作 `user`，包括运行中插入的 steering。
 * 只有上一条回复已收尾（不是等工具结果）时才是真正的新一轮。
 */
export function isNewTurn(messages: readonly Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'assistant') {
      return (message as { stopReason?: string }).stopReason !== 'toolUse';
    }
    // 工具执行中被中止：pi 补一条 "Operation aborted" 错误结果，上一轮已结束
    if (
      message.role === 'toolResult' &&
      (message as { isError?: boolean }).isError &&
      contentText(message) === 'Operation aborted'
    ) {
      return true;
    }
  }
  return true;
}

function contentText(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''
    )
    .join('')
    .trim();
}

const acceptsImages = (model: Model<Api>): boolean => model.input.includes('image');
const fitsContext = (model: Model<Api>, tokens: number): boolean =>
  !(model.contextWindow > 0) || tokens <= model.contextWindow * CONTEXT_HEADROOM;

interface Needs {
  image: boolean;
  readonly tokens: number;
}

/** 候选里第一个满足图片与上下文需求的成员；都不满足时退回第一个（交给 pi 压缩/报错）。 */
function pick(candidates: readonly Model<Api>[], needs: Needs): Model<Api> | undefined {
  return (
    candidates.find(
      (model) => (!needs.image || acceptsImages(model)) && fitsContext(model, needs.tokens)
    ) ??
    candidates.find((model) => !needs.image || acceptsImages(model)) ??
    candidates[0]
  );
}

function findMember(
  members: VirtualMembers,
  model: Model<Api> | undefined
): Model<Api> | undefined {
  if (!model) return undefined;
  return chain(members).find((member) => memberKey(member) === memberKey(model));
}

/**
 * 路由（纯函数）：
 * - direct（摘要等）→ 快模型；
 * - retry → 本轮未失败的下一个成员（故障转移）；
 * - continuation → 沿用上一个成员保住 prompt cache，仅在新输入带图而它不收图时换；
 * - user → 首选成员（分类器给出，缺省主模型），按图片/上下文需求补位，清空失败记录。
 */
export function routeVirtualRequest(
  request: ModelRouteRequest<VirtualRouterState>,
  members: VirtualMembers,
  choice?: { preferred?: Model<Api>; state?: VirtualRouterState }
): ModelRoute<VirtualRouterState> {
  // 会话关掉推理时虚拟模型 reasoning=false，但 pi 仍会带着原档位来路由
  const reasoning = request.model.reasoning !== false && request.thinkingLevel !== 'off';
  const finish = (
    model: Model<Api>,
    state?: VirtualRouterState
  ): ModelRoute<VirtualRouterState> => {
    const thinkingLevel: ModelThinkingLevel = reasoning
      ? clampThinkingLevel(model, request.thinkingLevel)
      : 'off';
    return { model, thinkingLevel, ...(state ? { state } : {}) };
  };
  const previousState = request.state ?? {};
  const ordered = chain(members);
  let tokens: number | undefined;
  const needs: Needs = {
    image: pendingInputHasImage(request.messages),
    // 只在真要挑成员时才数整段上下文
    get tokens() {
      tokens ??= estimateRequestTokens(request.messages);
      return tokens;
    },
  };

  if (request.reason === 'direct') return finish(members.fast ?? members.primary);

  if (request.reason === 'retry' && request.failed) {
    const failed = new Set([...(previousState.failed ?? []), memberKey(request.failed.model)]);
    const next = pick(
      ordered.filter((model) => !failed.has(memberKey(model))),
      needs
    );
    const state = { ...previousState, failed: [...failed] };
    return finish(next ?? findMember(members, request.failed.model) ?? members.primary, state);
  }

  // 运行中插入的 steering：按续请求处理，不重置失败记录、不重新分档
  if (
    request.reason === 'continuation' ||
    (request.reason === 'user' && request.previous && !isNewTurn(request.messages))
  ) {
    const previous = findMember(members, request.previous?.model);
    if (previous && (!needs.image || acceptsImages(previous))) return finish(previous);
    const failed = new Set(previousState.failed ?? []);
    const next = pick(
      ordered.filter((model) => !failed.has(memberKey(model))),
      needs
    );
    return finish(next ?? members.primary);
  }

  // user（以及 pi 未给 failed 的 retry）：新一轮重新从首选成员开始
  const start = choice?.preferred ?? members.primary;
  const candidates = [start, ...ordered.filter((model) => memberKey(model) !== memberKey(start))];
  const target = pick(candidates, needs) ?? members.primary;
  const merged: VirtualRouterState = { ...previousState, ...choice?.state };
  if (merged.failed?.length) merged.failed = [];
  const changed = JSON.stringify(merged) !== JSON.stringify(previousState);
  return finish(target, changed ? merged : undefined);
}

const ADAPTIVE_WRAPPED = Symbol('enso.adaptiveThinking');

/**
 * pi 按目录模型（每次取出都是新副本）发出路由后的请求，会话里就地改 compat 的做法对成员无效。
 * 在 provider 出口按同一判定补 forceAdaptiveThinking：开推理且模型支持 adaptive 时补上；
 * 已显式设置（会话直连时 applyReasoningToModel 写入）的保持不动。
 */
export function withAdaptiveThinking(
  provider: Provider,
  supportsAdaptive: (modelId: string) => boolean,
  applies: (model: Model<Api>) => boolean = () => true
): Provider {
  if ((provider as { [ADAPTIVE_WRAPPED]?: true })[ADAPTIVE_WRAPPED]) return provider;
  const patch = <T extends Model<Api>>(model: T): T => {
    if (model.api !== 'anthropic-messages' || !model.reasoning || !applies(model)) return model;
    const compat = model.compat as { forceAdaptiveThinking?: boolean } | undefined;
    if (compat && 'forceAdaptiveThinking' in compat) return model;
    if (!supportsAdaptive(model.id)) return model;
    return { ...model, compat: { ...compat, forceAdaptiveThinking: true } } as T;
  };
  const wrapped: Provider = {
    ...provider,
    stream: (model, context, options) => provider.stream(patch(model), context, options),
    streamSimple: (model, context, options) =>
      provider.streamSimple(patch(model), context, options),
  };
  return Object.assign(wrapped, { [ADAPTIVE_WRAPPED]: true as const });
}

/** 走虚拟路由的 anthropic 成员；包装只对它们生效，不改变同 provider 其他调用 */
const adaptiveMembers = new Set<string>();

/**
 * 确保成员所在 provider 套了 adaptive 出口。provider 被重新注册（如 resolveBaseModel 累积模型）
 * 会换掉包装，所以路由时也调用一次自愈。
 */
function ensureAdaptiveProvider(
  runtime: ModelRuntime,
  model: Model<Api>,
  supportsAdaptive: ((modelId: string) => boolean) | undefined
): void {
  if (!supportsAdaptive || model.api !== 'anthropic-messages') return;
  adaptiveMembers.add(memberKey(model));
  const provider = runtime.getProvider(model.provider);
  if (!provider || (provider as { [ADAPTIVE_WRAPPED]?: true })[ADAPTIVE_WRAPPED]) return;
  runtime.registerNativeProvider(
    withAdaptiveThinking(provider, supportsAdaptive, (candidate) =>
      adaptiveMembers.has(memberKey(candidate))
    )
  );
}

export interface VirtualModelRegistration {
  model: Model<Api>;
  members: VirtualMembers;
}

/**
 * 解析成员并注册 pi 虚拟模型。重复注册替换定义；已持有旧模型对象的会话下个请求即用新路由。
 * 必须早于 createAgentSession 恢复分支，否则 pi 会静默回退到分支里最后一个真实模型。
 */
export async function registerVirtualModel(
  runtime: ModelRuntime,
  config: SpawnModelConfig,
  resolveMember: (member: SpawnModelConfig) => Promise<Model<Api>>,
  choose?: VirtualChooser,
  supportsAdaptive?: (modelId: string) => boolean
): Promise<VirtualModelRegistration> {
  const virtual = config.virtual;
  if (!virtual) throw new Error('not a virtual model config');
  // pi 路由时按目录重新取模型并校验凭证：只在 Enso 侧合成、不在目录里的模型不能做成员
  const routable = async (member: SpawnModelConfig) => {
    const model = await resolveMember(member);
    if (!runtime.getPhysicalModel(model.provider, model.id)) {
      throw new Error(`${model.id} cannot be routed by a virtual model`);
    }
    ensureAdaptiveProvider(runtime, model, supportsAdaptive);
    return model;
  };
  const primary = await routable(virtual.primary);
  const optional = async (member: SpawnModelConfig) => {
    try {
      return await routable(member);
    } catch (error) {
      console.warn(`[virtual-model] member ${member.modelId} unavailable:`, error);
      return undefined;
    }
  };
  const fast = virtual.fast ? await optional(virtual.fast) : undefined;
  const fallbacks = (await Promise.all(virtual.fallbacks.map(optional))).filter(
    (model): model is Model<Api> => model !== undefined
  );
  const members: VirtualMembers = { primary, ...(fast ? { fast } : {}), fallbacks };
  const all = chain(members);
  const windows = all.map((model) => model.contextWindow).filter((value) => value > 0);
  const outputs = all.map((model) => model.maxTokens).filter((value) => value > 0);
  const levels = new Set<ModelThinkingLevel>(['off']);
  for (const model of all) {
    for (const level of getSupportedThinkingLevels({ ...model, reasoning: true })) {
      levels.add(level);
    }
  }
  registry.set(config.modelId, members);
  runtime.registerVirtualModel({
    provider: VIRTUAL_PROVIDER_ID,
    id: config.modelId,
    name: virtual.name,
    thinkingLevels: [...levels],
    // 首个响应前的上限按最小成员估，避免占用显示过于乐观
    ...(windows.length > 0 ? { contextWindow: Math.min(...windows) } : {}),
    ...(outputs.length > 0 ? { maxTokens: Math.min(...outputs) } : {}),
    input: all.some(acceptsImages) ? ['text', 'image'] : ['text'],
    route: async (request: ModelRouteRequest) => {
      const typed = request as ModelRouteRequest<VirtualRouterState>;
      const choice =
        typed.reason === 'user' && choose && isNewTurn(typed.messages)
          ? await choose(typed, members).catch((error) => {
              // 用户中止或新请求取代本轮：分类器被取消是预期的，不算失败
              if (isAbortError(error)) console.debug('[virtual-model] classifier aborted');
              else console.warn('[virtual-model] classifier failed:', error);
              return undefined;
            })
          : undefined;
      const route = routeVirtualRequest(typed, members, choice);
      ensureAdaptiveProvider(runtime, route.model, supportsAdaptive);
      return route;
    },
  });
  const model = runtime.getModel(VIRTUAL_PROVIDER_ID, config.modelId);
  if (!model) throw new Error(`virtual model not found after register: ${config.modelId}`);
  return { model, members };
}
