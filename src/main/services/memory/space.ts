import type { MemoryCaptureSpace, MemorySearchSpace } from '@shared/memory/toolParams';
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
 * `bot` / `chat` 没有对应上下文直接报错。`all` 的顺序：bot → chat → project → global。
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
      return [...bot, ...chat, ...project, GLOBAL_SPACE];
  }
}
