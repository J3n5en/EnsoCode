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
import { extractRepresentativeTitle } from '@shared/titleSource';
import type {
  AgentSpawnRequest,
  ApprovalMode,
  ConversationAuthority,
  ModelRef,
  ProjectAuthority,
  ThinkingLevel,
} from '@shared/types/agent';
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
  prompt(id: string, text: string, deliveryId: string): { ok: boolean; error?: string };
  newId(): string;
  now(): number;
}

/**
 * Main 原生建会话：不依赖任何 renderer 在线，行先落盘再 spawn，
 * 之后 renderer 打开它走现有 attach / 快照路径，不再二次 spawn。
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
  ports.writeRow({
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
    ...(goal ? { goal: { text: goal, status: 'active', autoTurns: 0, noProgressRuns: 0 } } : {}),
    ...(request.secretaryOrigin ? { secretaryOrigin: request.secretaryOrigin } : {}),
  });

  const rollback = async (): Promise<void> => {
    if (worktree) await ports.removeWorktree(worktree).catch(() => undefined);
    ports.removeRow(id);
    ports.removeConversation(id);
  };

  const spawned = await ports.spawn({
    sessionId: id,
    providerId,
    modelId,
    cwd: worktree?.path ?? project.canonicalPath,
    reasoningEnabled: defaults.reasoningEnabled,
    thinkingLevel,
    ...(defaults.presetId ? { presetId: defaults.presetId } : {}),
    approvalMode: defaults.approvalMode,
    ...(request.unattended ? { autoRejectApprovals: true } : {}),
    ...(request.askRelay ? { askRelay: request.askRelay } : {}),
  });
  if (!spawned.ok) {
    await rollback();
    return { ok: false, error: spawned.error ?? 'spawn failed' };
  }

  const prompted = ports.prompt(
    id,
    goal ? `${prompt}\n\n${goalKickoffText(goal)}` : prompt,
    ports.newId()
  );
  if (!prompted.ok) {
    await ports.release(id).catch(() => undefined);
    await rollback();
    return { ok: false, error: prompted.error ?? 'prompt failed' };
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
