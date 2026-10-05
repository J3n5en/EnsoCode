import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  type ExcerptMessage,
  formatChatReference,
  formatSkillBlock,
  recentRounds,
  skillUnavailableNote,
  splitChatReferences,
  withChatReferences,
} from '../../../shared/bots/composerRefs';
import { stripBotNotesUpdate } from '../../../shared/bots/notes';
import type { ProjectedMessage } from '../../../shared/types/agent';
import type { SkillEntry } from '../../../shared/types/assets';
import type { BotChat, GroupEntry } from '../../../shared/types/bot';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';

/** 输入框引用：renderer 只给标识符（相对路径 / chatId / 技能 id），Main 校验后展开 */
export interface ComposerRefsInput {
  files?: string[];
  chats?: string[];
  skill?: string;
}

export interface ComposerRefsDeps {
  bots: Pick<BotStore, 'get'>;
  chats: Pick<BotChatStore, 'get' | 'readEntries'>;
  skills: () => readonly SkillEntry[];
  /** 私聊成员会话的投影（当前分支） */
  sessionMessages: (conversationId: string) => Promise<readonly ProjectedMessage[]>;
  workspacePath: (chatId: string) => string | undefined;
}

const GROUP_EXCERPT_SCAN = 120;

/** 相对路径解析（含软链）后仍落在工作区内且存在；绝对路径、.. 越界一律拒绝 */
export function insideWorkspace(root: string, relative: string): boolean {
  if (!relative || relative.length > 1024 || relative.includes('\0')) return false;
  if (path.isAbsolute(relative)) return false;
  try {
    const base = realpathSync(root);
    const target = realpathSync(path.resolve(base, relative.replace(/#L\d+(?:-L\d+)?$/, '')));
    const rest = path.relative(base, target);
    return !rest.startsWith('..') && !path.isAbsolute(rest);
  } catch {
    return false;
  }
}

const SKILL_PREFIX =
  /^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]*))?$/;

const partsText = (message: ProjectedMessage) =>
  message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();

function cleanUserText(raw: string): string {
  const body = splitChatReferences(stripBotNotesUpdate(raw)).body.trim();
  const skill = SKILL_PREFIX.exec(body);
  return skill ? `[skill: ${skill[1]}] ${(skill[2] ?? '').trim()}`.trim() : body;
}

/** 私聊会话 → 摘录消息：每轮人类输入 + 该轮最后一条有正文的回复 */
export function directExcerpt(
  messages: readonly ProjectedMessage[],
  botName: string
): ExcerptMessage[] {
  const result: ExcerptMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const text = cleanUserText(partsText(message));
      if (text) result.push({ speaker: 'User', human: true, text });
    } else if (message.role === 'assistant') {
      const text = partsText(message);
      if (!text) continue;
      const last = result.at(-1);
      if (last && !last.human) last.text = text;
      else result.push({ speaker: botName, human: false, text });
    }
  }
  return result;
}

export function createComposerRefs(deps: ComposerRefsDeps) {
  const botName = (id: string) => deps.bots.get(id)?.name ?? 'Deleted member';
  const skillEntry = (id: string) => deps.skills().find((skill) => skill.id === id);

  const skillBlock = (botId: string, skillId: string): string | undefined => {
    const entry = skillEntry(skillId);
    if (!entry || !deps.bots.get(botId)?.skillIds.includes(skillId)) return undefined;
    const filePath = path.join(entry.path, 'SKILL.md');
    try {
      return formatSkillBlock({
        name: entry.name,
        filePath,
        content: readFileSync(filePath, 'utf8'),
      });
    } catch {
      return undefined;
    }
  };

  const excerpt = async (chatId: string): Promise<string> => {
    const chat = deps.chats.get(chatId);
    if (!chat) return '';
    let messages: ExcerptMessage[] = [];
    if (chat.kind === 'group') {
      messages = deps.chats
        .readEntries(chatId, { limit: GROUP_EXCERPT_SCAN })
        .flatMap((entry): ExcerptMessage[] => {
          if (entry.kind === 'human') return [{ speaker: 'User', human: true, text: entry.text }];
          if (entry.kind === 'bot')
            return [{ speaker: botName(entry.botId), human: false, text: entry.text }];
          return [];
        });
    } else {
      const botId = chat.members[0];
      const conversationId = chat.sessions[botId]?.conversationId;
      const projected = conversationId
        ? await deps.sessionMessages(conversationId).catch(() => [])
        : [];
      messages = directExcerpt(projected, botName(botId));
    }
    return formatChatReference({
      chatId,
      title: chat.title || botName(chat.members[0]),
      kind: chat.kind,
      messages: recentRounds(messages),
    });
  };

  return {
    /** 发送前校验；返回错误码则整条消息拒绝（不会发给 worker） */
    check(chat: BotChat, refs: ComposerRefsInput): string | undefined {
      for (const id of refs.chats ?? []) {
        if (id === chat.id) return 'chat-ref-self';
        if (!deps.chats.get(id)) return 'chat-ref-not-found';
      }
      if (refs.files?.length) {
        const root = deps.workspacePath(chat.id);
        if (!root || refs.files.some((file) => !insideWorkspace(root, file)))
          return 'file-outside-workspace';
      }
      if (refs.skill && !chat.members.some((botId) => skillBlock(botId, refs.skill!)))
        return 'skill-unavailable';
      return undefined;
    },

    /** 私聊：技能块 + 正文 + 引用聊天摘录（与 pi /skill: 展开同序） */
    async expandDirect(chat: BotChat, input: ComposerRefsInput & { text: string }) {
      if (!input.skill && !input.chats?.length) return input.text;
      const skill = input.skill ? skillBlock(chat.members[0], input.skill) : undefined;
      const text = input.text.trim();
      const body = skill ? [skill, text].filter(Boolean).join('\n\n') : text;
      return withChatReferences(body, await Promise.all((input.chats ?? []).map(excerpt)));
    },

    /** 群聊：本次投递增量里人类消息的引用，按被投递成员的技能集合展开 */
    async groupAppendix(chat: BotChat, botId: string, entries: readonly GroupEntry[]) {
      const parts: string[] = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        if (entry.kind !== 'human' || !entry.refs) continue;
        const { skill, chats = [] } = entry.refs;
        if (skill)
          parts.push(
            skillBlock(botId, skill) ?? skillUnavailableNote(skillEntry(skill)?.name ?? skill)
          );
        for (const id of chats) {
          if (seen.has(id) || id === chat.id) continue;
          seen.add(id);
          const block = await excerpt(id);
          if (block) parts.push(block);
        }
      }
      return parts.join('\n\n');
    },
  };
}

export type ComposerRefs = ReturnType<typeof createComposerRefs>;
