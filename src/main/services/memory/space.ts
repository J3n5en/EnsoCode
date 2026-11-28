import type { MemoryCaptureSpace, MemorySearchSpace } from '@shared/memory/toolParams';
import type { ProjectAuthority, ProjectKind } from '@shared/types/agent';
import { isBotChatId, isBotId } from '@shared/types/bot';
import {
  botSpaceId,
  chatSpaceId,
  GLOBAL_SPACE,
  MemoryValidationError,
  projectSpaceId,
} from './types';

/** 会话的记忆归属：projectId 来自会话权威；botId / chatId 仅 Bot 模式会话有 */
export interface MemorySpaceContext {
  projectId?: string | null;
  botId?: string;
  chatId?: string;
  /**
   * 秘书会话：projectId 是私有空间；projectIds 是它可见的其它项目（可读写，写入记审计），
   * sessionId 是秘书会话 id，只用于审计
   */
  secretary?: { projectIds: readonly string[]; sessionId: string };
}

/** 推导所需的会话权威记录子集（ConversationAuthority） */
export interface MemoryAuthority {
  projectId: string | null;
  bot?: { botId: string; chatId: string | null };
}

/**
 * 会话权威 → 记忆上下文。bot 工作区是成员 / 群 home 等非 Code 项目时，由 isCodeProject 排除项目层；
 * 非 uuid 的 botId / chatId 视为无效，不进上下文（落不到 bot:/chat: space）。
 */
export function memorySpaceContext(
  authority: MemoryAuthority,
  isCodeProject: (projectId: string) => boolean = () => true
): MemorySpaceContext {
  const bot = authority.bot && isBotId(authority.bot.botId) ? authority.bot : undefined;
  const ctx: MemorySpaceContext = {};
  if (authority.projectId && (!bot || isCodeProject(authority.projectId))) {
    ctx.projectId = authority.projectId;
  }
  if (bot) {
    ctx.botId = bot.botId;
    if (isBotChatId(bot.chatId)) ctx.chatId = bot.chatId;
  }
  return ctx;
}

/** 模型未指定 spaceId 时 capture 的语义 space */
export function defaultCaptureSpace(ctx: MemorySpaceContext): MemoryCaptureSpace {
  return ctx.botId ? 'bot' : 'project';
}

/** 自动蒸馏落库的 space：与 capture 缺省一致，无项目时落 global */
export function distillSpaceId(ctx: MemorySpaceContext): string {
  if (ctx.botId) return botSpaceId(ctx.botId);
  return ctx.projectId ? projectSpaceId(ctx.projectId) : GLOBAL_SPACE;
}

/** 群聊成员会话的蒸馏落点：自身 space 之外再给群 space，由模型按 scope 分流；其余会话只有 self */
export function distillSpaces(ctx: MemorySpaceContext): { self: string; chat?: string } {
  const self = distillSpaceId(ctx);
  return ctx.botId && isBotChatId(ctx.chatId) ? { self, chat: chatSpaceId(ctx.chatId) } : { self };
}

/**
 * 模型只说 space 语义，这里换成真实 space_id。`project` 无项目时返回空集合让调用方决定拒绝还是空结果；
 * `bot` / `chat` 没有对应上下文直接报错。`all` 的顺序：bot → chat → project → 秘书可见项目 → global。
 * 秘书会话的 `project` 是私有空间，其它可见项目经 `all` 或 projectId（requestSpaceIds）访问。
 */
export function resolveSpaceIds(space: MemorySearchSpace, ctx: MemorySpaceContext): string[] {
  const project = ctx.projectId ? [projectSpaceId(ctx.projectId)] : [];
  const bot = ctx.botId ? [botSpaceId(ctx.botId)] : [];
  const chat = ctx.chatId ? [chatSpaceId(ctx.chatId)] : [];
  switch (space) {
    case 'global':
      return [GLOBAL_SPACE];
    case 'project':
      return project;
    case 'bot':
      if (!bot.length) {
        throw new MemoryValidationError(
          'no_bot',
          "spaceId 'bot' is only available in Bot mode sessions; use 'project' or 'global'"
        );
      }
      return bot;
    case 'chat':
      if (!chat.length) {
        throw new MemoryValidationError(
          'no_chat',
          "spaceId 'chat' is only available in Bot mode chat sessions; this session has no chat"
        );
      }
      return chat;
    default:
      return [...bot, ...chat, ...project, ...secretaryProjectSpaces(ctx), GLOBAL_SPACE];
  }
}

/** 秘书可见的其它项目空间：去掉私有空间自己与重复项 */
function secretaryProjectSpaces(ctx: MemorySpaceContext): string[] {
  if (!ctx.secretary) return [];
  const ids = new Set(ctx.secretary.projectIds);
  if (ctx.projectId) ids.delete(ctx.projectId);
  return [...ids].map(projectSpaceId);
}

/**
 * 工具请求的 spaceId + 可选 projectId → 真实 space_id。projectId 只给秘书，指向它可见的某个项目空间，
 * 只能与 spaceId 'project'（或检索缺省 'all'）同用，且优先于它们。
 */
export function requestSpaceIds(
  space: MemorySearchSpace,
  projectId: string | undefined,
  ctx: MemorySpaceContext
): string[] {
  if (projectId === undefined) return resolveSpaceIds(space, ctx);
  if (!ctx.secretary) {
    throw new MemoryValidationError(
      'project_scope',
      'projectId is only available to the secretary'
    );
  }
  if (space !== 'all' && space !== 'project') {
    throw new MemoryValidationError(
      'invalid_request',
      `projectId selects one project's memory space and cannot be combined with spaceId '${space}'`
    );
  }
  if (!ctx.secretary.projectIds.includes(projectId)) {
    throw new MemoryValidationError(
      'project_not_visible',
      `project ${projectId} is not among the secretary's visible projects; ` +
        "for your own memory space use spaceId 'project' without projectId"
    );
  }
  return [projectSpaceId(projectId)];
}

/** 秘书会话的私有空间：检索不脱敏、写入不记审计的那个空间；非秘书会话为 null */
export function secretaryPrivateSpace(ctx: MemorySpaceContext): string | null {
  return ctx.secretary && ctx.projectId ? projectSpaceId(ctx.projectId) : null;
}

/** 隐藏项目（Bot 工作区、临时会话、秘书自己）不在秘书可见的记忆空间里 */
const HIDDEN_PROJECT_KINDS: ReadonlySet<ProjectKind> = new Set([
  'bot-home',
  'scratch',
  'secretary',
]);

/**
 * profile 的可见项目 → 秘书可读写记忆的项目 id。未完成初次设置时按默认档案（全部可见），
 * 与项目、会话读取同口径。
 */
export function secretaryProjectIds(
  profile: { visibleProjectIds: 'all' | readonly string[] } | null,
  projects: readonly Pick<ProjectAuthority, 'projectId' | 'kind' | 'state'>[]
): string[] {
  const allowed = profile?.visibleProjectIds ?? 'all';
  const visible = allowed === 'all' ? null : new Set(allowed);
  return projects
    .filter((project) => project.state === 'active')
    .filter((project) => !HIDDEN_PROJECT_KINDS.has(project.kind ?? 'local'))
    .map((project) => project.projectId)
    .filter((projectId) => !visible || visible.has(projectId));
}
