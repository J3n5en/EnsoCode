import { CHAT_REF_MAX_PER_MESSAGE, splitChatReferences } from '@shared/bots/composerRefs';
import { stripBotNotesUpdate } from '@shared/bots/notes';

/** Bot 输入框草稿：按聊天存 localStorage（图片不存） */
export interface BotComposerDraft {
  text: string;
  files: string[];
  chats: string[];
  skill?: string;
}

export const EMPTY_BOT_DRAFT: BotComposerDraft = { text: '', files: [], chats: [] };

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const key = (chatId: string) => `enso-bot-draft:${chatId}`;
const TEXT_MAX = 50_000;

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .slice(0, max)
    : [];

export function readBotDraft(storage: Pick<Storage, 'getItem'>, chatId: string): BotComposerDraft {
  try {
    const raw = JSON.parse(storage.getItem(key(chatId)) ?? 'null');
    if (!raw || typeof raw !== 'object') return EMPTY_BOT_DRAFT;
    return {
      text: typeof raw.text === 'string' ? raw.text.slice(0, TEXT_MAX) : '',
      files: strings(raw.files, 50),
      chats: strings(raw.chats, CHAT_REF_MAX_PER_MESSAGE),
      ...(typeof raw.skill === 'string' && raw.skill ? { skill: raw.skill } : {}),
    };
  } catch {
    return EMPTY_BOT_DRAFT;
  }
}

export function writeBotDraft(storage: DraftStorage, chatId: string, draft: BotComposerDraft) {
  try {
    if (!draft.text && !draft.chats.length && !draft.skill) storage.removeItem(key(chatId));
    else
      storage.setItem(
        key(chatId),
        JSON.stringify({ ...draft, text: draft.text.slice(0, TEXT_MAX) })
      );
  } catch {
    // 配额满 / 存储不可用：草稿只是便利，不影响输入
  }
}

const seedListeners = new Set<(chatId: string) => void>();

const SKILL_PREFIX =
  /^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]*))?$/;

/**
 * 回退回填：Main 发出的正文 → 草稿。聊天摘录还原为引用；技能块只知道名称，
 * 先以名称存入 skill，输入框按 id 或名称解析。
 */
export function draftFromSentText(sent: string): BotComposerDraft {
  const { body, refs } = splitChatReferences(stripBotNotesUpdate(sent));
  const skill = SKILL_PREFIX.exec(body);
  return {
    text: skill ? (skill[2] ?? '').trim() : body,
    files: [],
    chats: refs.map((ref) => ref.id).slice(0, CHAT_REF_MAX_PER_MESSAGE),
    ...(skill ? { skill: skill[1] } : {}),
  };
}

/** 预填某聊天的输入框（不发送）：写入持久化草稿，已挂载的输入框立即更新 */
export function seedBotDraft(chatId: string, draft: string | BotComposerDraft): void {
  writeBotDraft(
    localStorage,
    chatId,
    typeof draft === 'string' ? { ...readBotDraft(localStorage, chatId), text: draft } : draft
  );
  for (const listener of seedListeners) listener(chatId);
}

export function onBotDraftSeeded(listener: (chatId: string) => void): () => void {
  seedListeners.add(listener);
  return () => {
    seedListeners.delete(listener);
  };
}
