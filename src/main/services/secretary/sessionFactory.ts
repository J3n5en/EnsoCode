import {
  type DefaultModelRef,
  defaultApprovalMode,
  type ModelCredentialContext,
  resolveChatModel,
  resolveChatReasoning,
  scopedDefaultModels,
} from '@shared/defaultModel';
import { isPluginPresetId } from '@shared/extensionPlugins/preset';
import { goalKickoffText } from '@shared/pair/headlessQueue';
import {
  forwardedMessage,
  type LoadedImage,
  type UnavailableImage,
} from '@shared/secretary/attachments';
import type { QueuedStart } from '@shared/secretary/queuedSession';
import { extractRepresentativeTitle } from '@shared/titleSource';
import type {
  AgentSpawnRequest,
  ApprovalMode,
  AttachedImage,
  ConversationAuthority,
  ModelRef,
  ProjectAuthority,
  ThinkingLevel,
} from '@shared/types/agent';
import { THINKING_LEVELS } from '@shared/types/agentConstants';
import type { ModelProvider } from '@shared/types/llm';
import type { SessionWorktree } from '@shared/types/worktree';
import type { VirtualModelEntry } from '@shared/virtualModels';

export interface MainSessionRequest {
  projectId: string;
  prompt: string;
  title?: string;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  worktree: boolean;
  /** 基线：从项目的哪个现有检出、哪个 ref 起新分支。只在 worktree 为真时生效 */
  checkout?: string;
  baseRef?: string;
  branch?: string;
  secretaryOrigin?: { secretaryConversationId: string };
  /** 会话目标：首条消息追加 kickoff，行里的 goal 供 Main 续跑 */
  goal?: string;
  /** 秘书派出的会话默认静音：只落行，静音判定由 sessionMuteGate 读同一份 settings */
  muted?: boolean;
  /** 秘书派出的会话默认无人值守：落行并随 spawn 带给 worker */
  unattended?: boolean;
  /** 秘书派出的会话：ask_user 先转给秘书，而不是按无人值守直接拒绝 */
  askRelay?: { name: string };
  /** 随首条消息转发的图片：模型能看图就作为图片块，否则退回路径加 image_view */
  attachments?: { images: LoadedImage[]; unavailable?: UnavailableImage[] };
  /**
   * 超过派发上限：照常建会话（行、worktree、分支），首条消息与目标存进行上的 queuedStart，
   * 不 spawn、不 prompt，等 Main 有空位时启动
   */
  queued?: boolean;
  /** 排队会话的图片：已校验过的真实路径，启动时再读 */
  attachmentPaths?: string[];
}

export type MainSessionResult = { ok: true; conversationId: string } | { ok: false; error: string };

export interface MainSessionDefaults {
  providerId: string;
  modelId: string;
  reasoningEnabled: boolean;
  thinkingLevel: ThinkingLevel;
  presetId?: string;
  approvalMode: ApprovalMode;
}

export interface SessionFactoryPorts {
  project(id: string): ProjectAuthority | undefined;
  createConversation(projectId: string, projectVersion: number): ConversationAuthority | undefined;
  removeConversation(id: string): void;
  /** null 表示当前没有可用模型 */
  defaults(projectId: string): MainSessionDefaults | null;
  createWorktree(
    conversationId: string,
    projectId: string,
    base?: { checkout?: string; baseRef?: string; branch?: string }
  ): Promise<SessionWorktree>;
  removeWorktree(record: SessionWorktree): Promise<void>;
  writeRow(row: Record<string, unknown>): void;
  removeRow(id: string): void;
  spawn(request: AgentSpawnRequest): Promise<{ ok: boolean; error?: string }>;
  /** 释放已 spawn 的根会话 */
  release(id: string): Promise<unknown>;
  prompt(
    id: string,
    text: string,
    deliveryId: string,
    images?: AttachedImage[]
  ): { ok: boolean; error?: string };
  /** 会话就绪后报的模型能否看图；不知道时 undefined */
  imageInput(id: string): Promise<boolean | undefined>;
  newId(): string;
  now(): number;
}

export type LaunchPorts = Pick<
  SessionFactoryPorts,
  'project' | 'spawn' | 'prompt' | 'release' | 'imageInput' | 'newId'
>;

export interface LaunchInput {
  text: string;
  goal?: string;
  attachments?: { images: LoadedImage[]; unavailable?: UnavailableImage[] };
  askRelay?: { name: string };
}

/** spawn 参数全部取自会话行：新建与排队后启动共用，行就是建会话时选定的配置 */
function spawnRequestOf(
  row: Readonly<Record<string, unknown>>,
  cwd: string,
  askRelay: { name: string } | undefined
): AgentSpawnRequest | null {
  const { id, lastProviderId, lastModelId, thinkingLevel, presetId, approvalMode } = row;
  if (typeof id !== 'string' || typeof lastProviderId !== 'string') return null;
  if (typeof lastModelId !== 'string') return null;
  return {
    sessionId: id,
    providerId: lastProviderId,
    modelId: lastModelId,
    cwd,
    reasoningEnabled: row.reasoningEnabled === true,
    ...((THINKING_LEVELS as readonly unknown[]).includes(thinkingLevel)
      ? { thinkingLevel: thinkingLevel as ThinkingLevel }
      : {}),
    ...(typeof presetId === 'string' && presetId ? { presetId } : {}),
    ...(typeof approvalMode === 'string' ? { approvalMode: approvalMode as ApprovalMode } : {}),
    ...(row.autoRejectApprovals === true ? { autoRejectApprovals: true } : {}),
    ...(askRelay ? { askRelay } : {}),
  };
}

/**
 * 按会话行 spawn 并投首条消息。spawn 失败什么都没起；prompt 失败先 release。
 * 行、worktree 的去留由调用方决定：新建时回滚，排队会话保留并标失败。
 */
export async function launchSession(
  ports: LaunchPorts,
  row: Readonly<Record<string, unknown>>,
  input: LaunchInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const project = typeof row.projectId === 'string' ? ports.project(row.projectId) : undefined;
  if (project?.state !== 'active' || (project.kind ?? 'local') !== 'local') {
    return { ok: false, error: 'project is not an active local project' };
  }
  const worktree = row.worktree as Partial<SessionWorktree> | undefined;
  const cwd = typeof worktree?.path === 'string' ? worktree.path : project.canonicalPath;
  const request = spawnRequestOf(row, cwd, input.askRelay);
  if (!request) return { ok: false, error: 'invalid conversation row' };
  const spawned = await ports.spawn(request);
  if (!spawned.ok) return { ok: false, error: spawned.error ?? 'spawn failed' };

  const id = request.sessionId;
  const goal = input.goal?.trim();
  const text = goal ? `${input.text}\n\n${goalKickoffText(goal)}` : input.text;
  const forwarded = input.attachments;
  const message = forwarded
    ? forwardedMessage(text, forwarded.images, {
        // 只有带图时才等 worker 报模型能力
        inline: forwarded.images.length > 0 && (await ports.imageInput(id)) === true,
        canView: true,
        ...(forwarded.unavailable ? { unavailable: forwarded.unavailable } : {}),
      })
    : { text };
  const prompted = ports.prompt(id, message.text, ports.newId(), message.images);
  if (!prompted.ok) {
    await ports.release(id).catch(() => undefined);
    return { ok: false, error: prompted.error ?? 'prompt failed' };
  }
  return { ok: true };
}

/**
 * Main 原生建会话：不依赖任何 renderer 在线，行先落盘再 spawn，
 * 之后 renderer 打开它走现有 attach / 快照路径，不再二次 spawn。
 * queued 时照常建行与 worktree，但只把首条消息存进 queuedStart，不 spawn。
 */
export async function createSessionFromMain(
  ports: SessionFactoryPorts,
  request: MainSessionRequest
): Promise<MainSessionResult> {
  const prompt = request.prompt.trim();
  if (!prompt) return { ok: false, error: 'empty prompt' };
  const project = ports.project(request.projectId);
  if (project?.state !== 'active' || (project.kind ?? 'local') !== 'local') {
    return { ok: false, error: 'project is not an active local project' };
  }
  const defaults = ports.defaults(request.projectId);
  if (!defaults) return { ok: false, error: 'no usable model' };
  const title = (request.title?.trim() || extractRepresentativeTitle(prompt)).slice(0, 80);
  if (!title) return { ok: false, error: 'empty title' };
  const goal = request.goal?.trim();

  const conversation = ports.createConversation(request.projectId, project.version);
  if (!conversation) return { ok: false, error: 'conversation authority unavailable' };
  const id = conversation.conversationId;

  let worktree: SessionWorktree | undefined;
  if (request.worktree) {
    try {
      worktree = await ports.createWorktree(id, request.projectId, {
        ...(request.checkout ? { checkout: request.checkout } : {}),
        ...(request.baseRef ? { baseRef: request.baseRef } : {}),
        ...(request.branch ? { branch: request.branch } : {}),
      });
    } catch (error) {
      ports.removeConversation(id);
      return { ok: false, error: error instanceof Error ? error.message : 'worktree failed' };
    }
  }

  const providerId = request.model?.providerId ?? defaults.providerId;
  const modelId = request.model?.modelId ?? defaults.modelId;
  const thinkingLevel = request.thinkingLevel ?? defaults.thinkingLevel;
  const createdAt = ports.now();
  const queuedStart: QueuedStart | undefined = request.queued
    ? {
        queuedAt: createdAt,
        text: prompt,
        ...(goal ? { goal } : {}),
        ...(request.attachmentPaths?.length ? { attachments: [...request.attachmentPaths] } : {}),
        ...(request.askRelay ? { askRelay: request.askRelay } : {}),
      }
    : undefined;
  const row: Record<string, unknown> = {
    id,
    projectId: request.projectId,
    title,
    createdAt,
    lastActiveAt: createdAt,
    messages: [],
    commands: [],
    customEntries: [],
    dispatchMainEvents: {},
    lastSeq: 0,
    spawning: false,
    status: 'idle',
    started: false,
    reasoningEnabled: defaults.reasoningEnabled,
    thinkingLevel,
    lastProviderId: providerId,
    lastModelId: modelId,
    ...(defaults.presetId ? { presetId: defaults.presetId } : {}),
    approvalMode: defaults.approvalMode,
    ...(request.muted ? { muted: true } : {}),
    ...(request.unattended ? { autoRejectApprovals: true } : {}),
    ...(worktree ? { worktree } : {}),
    driver: 'main',
    // 排队时目标只放在 queuedStart 里：行上有 goal 会让 Main 续跑一个还没开始的会话
    ...(goal && !queuedStart
      ? { goal: { text: goal, status: 'active', autoTurns: 0, noProgressRuns: 0 } }
      : {}),
    ...(request.secretaryOrigin ? { secretaryOrigin: request.secretaryOrigin } : {}),
    ...(queuedStart ? { queuedStart } : {}),
  };
  ports.writeRow(row);
  if (queuedStart) return { ok: true, conversationId: id };

  const rollback = async (): Promise<void> => {
    if (worktree) await ports.removeWorktree(worktree).catch(() => undefined);
    ports.removeRow(id);
    ports.removeConversation(id);
  };

  const launched = await launchSession(ports, row, {
    text: prompt,
    ...(goal ? { goal } : {}),
    ...(request.attachments ? { attachments: request.attachments } : {}),
    ...(request.askRelay ? { askRelay: request.askRelay } : {}),
  });
  if (!launched.ok) {
    await rollback();
    return launched;
  }
  return { ok: true, conversationId: id };
}

/**
 * 秘书自己的会话：只建会话并拉起，不发消息，消息由调用方照常投。
 * 秘书项目没有 worktree，cwd 就是它的隐藏项目目录。
 */
export async function createSecretaryConversationFromMain(
  ports: SessionFactoryPorts,
  request: { projectId: string; title: string }
): Promise<MainSessionResult> {
  const project = ports.project(request.projectId);
  if (project?.state !== 'active' || project.kind !== 'secretary') {
    return { ok: false, error: 'not an active secretary project' };
  }
  const defaults = ports.defaults(request.projectId);
  if (!defaults) return { ok: false, error: 'no usable model' };
  const conversation = ports.createConversation(request.projectId, project.version);
  if (!conversation) return { ok: false, error: 'conversation authority unavailable' };
  const id = conversation.conversationId;
  const createdAt = ports.now();
  ports.writeRow({
    id,
    projectId: request.projectId,
    title: request.title.slice(0, 80),
    createdAt,
    lastActiveAt: createdAt,
    messages: [],
    commands: [],
    customEntries: [],
    dispatchMainEvents: {},
    lastSeq: 0,
    spawning: false,
    status: 'idle',
    started: false,
    reasoningEnabled: defaults.reasoningEnabled,
    thinkingLevel: defaults.thinkingLevel,
    lastProviderId: defaults.providerId,
    lastModelId: defaults.modelId,
    ...(defaults.presetId ? { presetId: defaults.presetId } : {}),
    approvalMode: defaults.approvalMode,
    driver: 'main',
  });
  const spawned = await ports.spawn({
    sessionId: id,
    providerId: defaults.providerId,
    modelId: defaults.modelId,
    cwd: project.canonicalPath,
    reasoningEnabled: defaults.reasoningEnabled,
    thinkingLevel: defaults.thinkingLevel,
    ...(defaults.presetId ? { presetId: defaults.presetId } : {}),
    approvalMode: defaults.approvalMode,
  });
  if (!spawned.ok) {
    ports.removeRow(id);
    ports.removeConversation(id);
    return { ok: false, error: spawned.error ?? 'spawn failed' };
  }
  return { ok: true, conversationId: id };
}

export interface MainSessionDefaultsInput {
  project?: ({ groupId?: string } & ScopedReasoningSource) | null;
  groups: readonly ({ id: string } & ScopedReasoningSource)[];
  defaultModel: DefaultModelRef | null;
  defaultReasoningEnabled?: boolean;
  defaultThinkingLevel?: ThinkingLevel;
  providers: readonly ModelProvider[];
  credentials: ModelCredentialContext;
  virtualModels?: readonly VirtualModelEntry[];
  approvalReviewer: DefaultModelRef | null;
  lastApprovalMode?: ApprovalMode | null;
  defaultPresetId: string;
  presets: readonly { id: string }[];
}

type ScopedReasoningSource = {
  defaultModel?: DefaultModelRef | null;
  defaultReasoningEnabled?: boolean;
  defaultThinkingLevel?: ThinkingLevel;
};

/** 与 renderer 的 newConversation 同口径：项目 > 分组 > 全局，预设只在存在时写 */
export function mainSessionDefaults(input: MainSessionDefaultsInput): MainSessionDefaults | null {
  const scoped = scopedDefaultModels(input.project, input.groups);
  const model = resolveChatModel({
    defaultModel: input.defaultModel,
    ...scoped,
    providers: input.providers,
    credentials: input.credentials,
    ...(input.virtualModels ? { virtualModels: input.virtualModels } : {}),
  });
  if (!model.providerId || !model.modelId) return null;
  const reasoning = resolveChatReasoning({
    ...scoped,
    ...(input.defaultReasoningEnabled === undefined
      ? {}
      : { defaultReasoningEnabled: input.defaultReasoningEnabled }),
    ...(input.defaultThinkingLevel ? { defaultThinkingLevel: input.defaultThinkingLevel } : {}),
  });
  const wantedPresetId = input.defaultPresetId;
  const presetId =
    wantedPresetId !== 'default' &&
    (input.presets.some((preset) => preset.id === wantedPresetId) ||
      isPluginPresetId(wantedPresetId))
      ? wantedPresetId
      : undefined;
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    reasoningEnabled: reasoning.reasoningEnabled,
    thinkingLevel: reasoning.thinkingLevel,
    ...(presetId ? { presetId } : {}),
    approvalMode: defaultApprovalMode(
      input.approvalReviewer,
      input.providers,
      input.credentials,
      input.lastApprovalMode
    ),
  };
}
