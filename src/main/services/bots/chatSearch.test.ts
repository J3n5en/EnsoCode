import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectedMessage } from '@shared/types/agent';
import type { BotChat, GroupEntry } from '@shared/types/bot';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ChatSearchDeps,
  matchSnippet,
  parseChatSearchQuery,
  searchBotChats,
} from './chatSearch';

async function* batches(entries: GroupEntry[]) {
  yield entries;
}

import { BotChatStore } from './chatStore';

const GROUP = '11111111-1111-4111-8111-111111111111';
const DIRECT = '22222222-2222-4222-8222-222222222222';
const ALICE = '33333333-3333-4333-8333-333333333333';
const BOB = '44444444-4444-4444-8444-444444444444';

const chat = (id: string, kind: BotChat['kind'], members: string[]): BotChat =>
  ({ id, kind, members, title: '', sessions: {} }) as unknown as BotChat;

const msg = (role: string, text: string, timestamp: number): ProjectedMessage => ({
  role,
  content: [{ type: 'text', text }],
  timestamp,
});

function deps(over: Partial<ChatSearchDeps> = {}): ChatSearchDeps {
  const entries: GroupEntry[] = [
    { seq: 1, id: 'e1', at: 100, kind: 'human', text: 'Deploy the API please', mentions: [] },
    {
      seq: 2,
      id: 'e2',
      at: 300,
      kind: 'bot',
      botId: ALICE,
      text: 'deployed api v2',
      conversationId: 'c-a',
      turnId: 't',
    },
    { seq: 3, id: 'e3', at: 400, kind: 'system', text: 'api limit reached' },
  ];
  return {
    chats: () => [chat(GROUP, 'group', [ALICE, BOB]), chat(DIRECT, 'direct', [BOB])],
    timeline: () => batches(entries),
    sessions: () => [
      { conversationId: 'old', botId: BOB, current: false, sessionFile: 'old.jsonl' },
      { conversationId: 'cur', botId: BOB, current: true, sessionFile: 'cur.jsonl' },
    ],
    readMessages: async (file) =>
      file === 'old.jsonl'
        ? [msg('user', 'old API question', 50), msg('assistant', 'nothing', 60)]
        : [
            msg('user', 'hi', 200),
            {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'api thoughts' },
                { type: 'text', text: 'The API is up' },
              ],
              timestamp: 350,
            } as ProjectedMessage,
            { role: 'toolResult', content: [{ type: 'text', text: 'api' }], timestamp: 351 },
          ],
    ...over,
  };
}

describe('parseChatSearchQuery', () => {
  it('收窄 query 与 limit', () => {
    expect(parseChatSearchQuery({ query: '  api ' })).toEqual({ query: 'api', limit: 50 });
    expect(parseChatSearchQuery({ query: 'a', limit: 5 })).toEqual({ query: 'a', limit: 5 });
    expect(parseChatSearchQuery({ query: 'a', limit: 1000 })).toEqual({ query: 'a', limit: 100 });
  });
  it('拒绝坏入参', () => {
    for (const bad of [
      null,
      'api',
      {},
      { query: 1 },
      { query: '   ' },
      { query: 'x'.repeat(201) },
      { query: 'a', limit: 0 },
      { query: 'a', limit: 1.5 },
      { query: 'a', limit: '5' },
    ]) {
      expect(parseChatSearchQuery(bad)).toBeNull();
    }
  });
});

describe('matchSnippet', () => {
  it('大小写不敏感，返回全部命中区间', () => {
    const result = matchSnippet('Api and API and aPi', 'api');
    expect(result?.snippet).toBe('Api and API and aPi');
    expect(result?.ranges).toEqual([
      [0, 3],
      [8, 11],
      [16, 19],
    ]);
  });
  it('未命中返回 null；正则元字符按字面量匹配', () => {
    expect(matchSnippet('hello', 'xyz')).toBeNull();
    expect(matchSnippet('a.b a*b', 'a*b')?.ranges).toEqual([[4, 7]]);
  });
  it('长文本围绕首个命中裁剪并加省略号，空白折叠', () => {
    const text = `${'x '.repeat(200)}needle\n\n here ${'y '.repeat(200)}`;
    const result = matchSnippet(text, 'NEEDLE');
    expect(result).not.toBeNull();
    const { snippet, ranges } = result!;
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(170);
    expect(snippet).toContain('needle here');
    const [start, end] = ranges[0];
    expect(snippet.slice(start, end)).toBe('needle');
  });
});

describe('searchBotChats', () => {
  it('匹配群时间线 human/bot 条目与私聊当前及历史会话的用户/助手正文', async () => {
    const { hits, truncated } = await searchBotChats(deps(), { query: 'API', limit: 50 });
    expect(truncated).toBe(false);
    expect(hits.map((hit) => [hit.chatId, hit.at])).toEqual([
      [DIRECT, 350],
      [GROUP, 300],
      [GROUP, 100],
      [DIRECT, 50],
    ]);
    expect(hits[0]).toMatchObject({
      chatKind: 'direct',
      speaker: { kind: 'bot', botId: BOB },
      snippet: 'The API is up',
      ranges: [[4, 7]],
      locator: { kind: 'session', conversationId: 'cur', messageIndex: 1, current: true },
    });
    expect(hits[1]).toMatchObject({
      speaker: { kind: 'bot', botId: ALICE },
      locator: { kind: 'timeline', seq: 2 },
    });
    expect(hits[2].speaker).toEqual({ kind: 'human' });
    expect(hits[3]).toMatchObject({
      speaker: { kind: 'human' },
      locator: { kind: 'session', conversationId: 'old', messageIndex: 0, current: false },
    });
  });

  it('按时间倒序截断到上限并标记 truncated', async () => {
    const result = await searchBotChats(deps(), { query: 'api', limit: 2 });
    expect(result.hits.map((hit) => hit.at)).toEqual([350, 300]);
    expect(result.truncated).toBe(true);
  });

  it('单个会话或时间线读取失败不阻断整体', async () => {
    const result = await searchBotChats(
      deps({
        timeline: () => {
          throw new Error('broken timeline');
        },
        readMessages: async (file) => {
          if (file === 'cur.jsonl') throw new Error('broken jsonl');
          return [msg('user', 'old API question', 50)];
        },
      }),
      { query: 'api', limit: 50 }
    );
    expect(result.hits.map((hit) => hit.at)).toEqual([50]);
  });

  it('没有会话文件的会话跳过', async () => {
    const result = await searchBotChats(
      deps({
        timeline: () => batches([]),
        sessions: () => [{ conversationId: 'draft', botId: BOB, current: true }],
      }),
      { query: 'api', limit: 50 }
    );
    expect(result.hits).toEqual([]);
  });
});

describe('searchBotChats + 真实时间线文件', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  it('时间线坏行跳过，其余条目照常命中', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bot-search-'));
    const store = new BotChatStore(dir);
    const created = store.create(
      {
        kind: 'group',
        title: 'g',
        members: [ALICE, BOB],
        bossBotId: ALICE,
        workspace: { kind: 'chat-home', projectId: 'p' },
      },
      GROUP
    );
    expect(created).toBeTruthy();
    const file = path.join(dir, GROUP, 'timeline.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ seq: 1, id: 'a', at: 10, kind: 'human', text: 'find me', mentions: [] }),
        '{not json',
        JSON.stringify({ seq: 2, id: 'b', at: 20, kind: 'human', text: 'also find', mentions: [] }),
        '',
      ].join('\n')
    );
    const result = await searchBotChats(
      {
        chats: () => store.list(),
        timeline: (chatId) => store.scanEntries(chatId),
        sessions: () => [],
        readMessages: async () => [],
      },
      { query: 'FIND', limit: 10 }
    );
    expect(result.hits.map((hit) => hit.locator)).toEqual([
      { kind: 'timeline', seq: 2 },
      { kind: 'timeline', seq: 1 },
    ]);
  });
});
