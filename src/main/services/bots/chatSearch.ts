import type { ProjectedMessage } from '@shared/types/agent';
import type { BotChat, GroupEntry } from '@shared/types/bot';
import {
  BOT_SEARCH_LIMIT_DEFAULT,
  BOT_SEARCH_LIMIT_MAX,
  BOT_SEARCH_QUERY_MAX,
  type BotSearchHit,
} from '@shared/types/botIpc';

export interface ChatSearchQuery {
  query: string;
  limit: number;
}

export interface ChatSearchSession {
  conversationId: string;
  botId: string;
  current: boolean;
  sessionFile?: string;
}

export interface ChatSearchDeps {
  chats: () => BotChat[];
  /** 群时间线分批异步读取，避免一次性读入大文件占用主线程 */
  timeline: (chatId: string) => AsyncIterable<readonly GroupEntry[]>;
  /** 私聊的当前与历史成员会话 */
  sessions: (chatId: string) => ChatSearchSession[];
  /** 会话文件的投影消息；下标即消息绝对下标 */
  readMessages: (sessionFile: string) => Promise<readonly ProjectedMessage[]>;
}

const SNIPPET_BEFORE = 50;
const SNIPPET_MAX = 160;

export function parseChatSearchQuery(input: unknown): ChatSearchQuery | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { query, limit } = input as Record<string, unknown>;
  if (typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > BOT_SEARCH_QUERY_MAX) return null;
  if (limit === undefined) return { query: trimmed, limit: BOT_SEARCH_LIMIT_DEFAULT };
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) return null;
  return { query: trimmed, limit: Math.min(limit, BOT_SEARCH_LIMIT_MAX) };
}

const collapse = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** 大小写不敏感子串匹配；片段围绕首个命中裁剪，ranges 为片段内全部命中 */
export function matchSnippet(
  text: string,
  query: string
): { snippet: string; ranges: Array<[number, number]> } | null {
  const needle = collapse(query);
  if (!needle) return null;
  const flat = collapse(text);
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');
  const matches = [...flat.matchAll(pattern)];
  const first = matches[0];
  if (!first) return null;
  const firstEnd = first.index + first[0].length;
  const start = Math.max(0, Math.min(first.index - SNIPPET_BEFORE, flat.length - SNIPPET_MAX));
  const end = Math.min(flat.length, Math.max(start + SNIPPET_MAX, firstEnd));
  const prefix = start > 0 ? '…' : '';
  const snippet = `${prefix}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  const ranges = matches
    .filter((match) => match.index >= start && match.index + match[0].length <= end)
    .map((match): [number, number] => {
      const at = match.index - start + prefix.length;
      return [at, at + match[0].length];
    });
  return { snippet, ranges };
}

const messageText = (message: ProjectedMessage): string =>
  message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');

const order = (hit: BotSearchHit): number =>
  hit.locator.kind === 'timeline' ? hit.locator.seq : hit.locator.messageIndex;

/** 群时间线（human / bot 条目）+ 私聊当前及历史会话（用户 / 助手正文）；单个来源失败跳过 */
export async function searchBotChats(
  deps: ChatSearchDeps,
  { query, limit }: ChatSearchQuery
): Promise<{ hits: BotSearchHit[]; truncated: boolean }> {
  const hits: BotSearchHit[] = [];
  for (const chat of deps.chats()) {
    if (chat.kind === 'group') {
      try {
        for await (const batch of deps.timeline(chat.id))
          for (const entry of batch) {
            if (entry.kind !== 'human' && entry.kind !== 'bot') continue;
            const match = matchSnippet(entry.text, query);
            if (!match) continue;
            hits.push({
              chatId: chat.id,
              chatKind: chat.kind,
              speaker:
                entry.kind === 'bot' ? { kind: 'bot', botId: entry.botId } : { kind: 'human' },
              at: entry.at,
              ...match,
              locator: { kind: 'timeline', seq: entry.seq },
            });
          }
      } catch (error) {
        console.warn('[bots] search timeline failed', chat.id, error);
      }
      continue;
    }
    let sessions: ChatSearchSession[] = [];
    try {
      sessions = deps.sessions(chat.id);
    } catch (error) {
      console.warn('[bots] search sessions failed', chat.id, error);
    }
    for (const session of sessions) {
      if (!session.sessionFile) continue;
      let messages: readonly ProjectedMessage[];
      try {
        messages = await deps.readMessages(session.sessionFile);
      } catch (error) {
        console.warn('[bots] search session failed', session.conversationId, error);
        continue;
      }
      messages.forEach((message, messageIndex) => {
        if (message.role !== 'user' && message.role !== 'assistant') return;
        const match = matchSnippet(messageText(message), query);
        if (!match) return;
        hits.push({
          chatId: chat.id,
          chatKind: chat.kind,
          speaker:
            message.role === 'assistant'
              ? { kind: 'bot', botId: session.botId }
              : { kind: 'human' },
          at: message.timestamp ?? 0,
          ...match,
          locator: {
            kind: 'session',
            conversationId: session.conversationId,
            messageIndex,
            current: session.current,
          },
        });
      });
    }
  }
  hits.sort((a, b) => b.at - a.at || order(b) - order(a));
  return { hits: hits.slice(0, limit), truncated: hits.length > limit };
}
