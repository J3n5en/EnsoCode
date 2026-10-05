import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { splitChatReferences } from '../../../shared/bots/composerRefs';
import type { ProjectedMessage } from '../../../shared/types/agent';
import type { SkillEntry } from '../../../shared/types/assets';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import {
  type ComposerRefsDeps,
  createComposerRefs,
  directExcerpt,
  insideWorkspace,
} from './composerRefs';

let root: string;
let workspace: string;
let bots: BotStore;
let chats: BotChatStore;
let deps: ComposerRefsDeps;
let alice: string;
let bob: string;
let direct: string;
let other: string;
let group: string;
const sessionMessages = vi.fn<(conversationId: string) => Promise<ProjectedMessage[]>>();

const text = (role: string, value: string): ProjectedMessage => ({
  role,
  content: [{ type: 'text', text: value }],
});

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue([]);
  root = mkdtempSync(join(tmpdir(), 'composer-refs-'));
  workspace = join(root, 'ws');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'a.txt'), 'a');
  writeFileSync(join(workspace, 'src', 'b.ts'), 'b');
  writeFileSync(join(root, 'secret.txt'), 's');
  symlinkSync(join(root, 'secret.txt'), join(workspace, 'link.txt'));
  mkdirSync(join(root, 'skills', 'review'), { recursive: true });
  writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\nReview it.');
  bots = new BotStore(join(root, 'bots'));
  chats = new BotChatStore(join(root, 'chats'));
  const a = bots.create({ name: 'Alice', skillIds: ['s-review'] }, []);
  const b = bots.create({ name: 'Bob' }, []);
  if (!a.ok || !b.ok) throw new Error('fixture');
  alice = a.bot.id;
  bob = b.bot.id;
  direct = chats.create({
    kind: 'direct',
    title: 'Alice',
    members: [alice],
    bossBotId: null,
    workspace: { kind: 'member-home' },
  })!.id;
  other = chats.create({
    kind: 'direct',
    title: 'Bob',
    members: [bob],
    bossBotId: null,
    workspace: { kind: 'member-home' },
  })!.id;
  chats.update(other, (draft) => {
    draft.sessions[bob] = { conversationId: 'conv-bob', cursor: 0 };
    return draft;
  });
  group = chats.create({
    kind: 'group',
    title: 'Team',
    members: [alice, bob],
    bossBotId: alice,
    workspace: { kind: 'chat-home', projectId: 'home' },
  })!.id;
  const skills: SkillEntry[] = [
    {
      id: 's-review',
      name: 'review',
      description: '',
      path: join(root, 'skills', 'review'),
      source: 'x',
      enabled: true,
    },
    {
      id: 's-other',
      name: 'other',
      description: '',
      path: join(root, 'skills', 'other'),
      source: 'x',
      enabled: true,
    },
  ];
  deps = {
    bots,
    chats,
    skills: () => skills,
    sessionMessages,
    workspacePath: (chatId) => (chats.get(chatId) ? workspace : undefined),
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('insideWorkspace', () => {
  it('只接受工作区内真实存在的相对路径', () => {
    expect(insideWorkspace(workspace, 'a.txt')).toBe(true);
    expect(insideWorkspace(workspace, 'src/')).toBe(true);
    expect(insideWorkspace(workspace, 'src/b.ts#L3-L5')).toBe(true);
    expect(insideWorkspace(workspace, '../secret.txt')).toBe(false);
    expect(insideWorkspace(workspace, 'src/../../secret.txt')).toBe(false);
    expect(insideWorkspace(workspace, join(root, 'secret.txt'))).toBe(false);
    expect(insideWorkspace(workspace, 'link.txt')).toBe(false);
    expect(insideWorkspace(workspace, 'missing.txt')).toBe(false);
    expect(insideWorkspace(workspace, '')).toBe(false);
  });
});

describe('check', () => {
  it('拒绝不存在 / 引用自身的聊天、越界文件与成员没有的技能', () => {
    const refs = createComposerRefs(deps);
    const chat = chats.get(direct)!;
    expect(refs.check(chat, { chats: ['nope'] })).toBe('chat-ref-not-found');
    expect(refs.check(chat, { chats: [direct] })).toBe('chat-ref-self');
    expect(refs.check(chat, { files: ['../secret.txt'] })).toBe('file-outside-workspace');
    expect(refs.check(chat, { skill: 's-other' })).toBe('skill-unavailable');
    expect(refs.check(chats.get(other)!, { skill: 's-review' })).toBe('skill-unavailable');
    expect(refs.check(chat, { chats: [other, group], files: ['a.txt'], skill: 's-review' })).toBe(
      undefined
    );
  });

  it('群聊里技能只要有一位成员可用即可', () => {
    const refs = createComposerRefs(deps);
    expect(refs.check(chats.get(group)!, { skill: 's-review' })).toBeUndefined();
    expect(refs.check(chats.get(group)!, { skill: 's-other' })).toBe('skill-unavailable');
  });
});

describe('expandDirect', () => {
  it('技能块在前，引用聊天的最近 3 轮摘录在后', async () => {
    sessionMessages.mockResolvedValue([
      text('user', 'q1'),
      text('assistant', 'a1'),
      text('user', 'q2'),
      text('assistant', 'a2'),
      text('user', 'q3'),
      text('assistant', 'a3'),
      text('user', 'q4'),
      text('assistant', 'a4'),
    ]);
    const refs = createComposerRefs(deps);
    const result = await refs.expandDirect(chats.get(direct)!, {
      text: '总结一下',
      chats: [other],
      skill: 's-review',
    });
    expect(sessionMessages).toHaveBeenCalledWith('conv-bob');
    expect(
      result.startsWith(
        `<skill name="review" location="${join(root, 'skills', 'review', 'SKILL.md')}">`
      )
    ).toBe(true);
    expect(result).toContain('Review it.\n</skill>\n\n总结一下');
    const split = splitChatReferences(result);
    expect(split.refs).toEqual([{ id: other, title: 'Bob' }]);
    expect(result).toContain('[User]: q2');
    expect(result).toContain('[Bob]: a4');
    expect(result).not.toContain('q1');
  });

  it('群聊引用取时间线最近 3 轮，跳过系统条目', async () => {
    for (const [index, value] of ['h1', 'h2', 'h3', 'h4'].entries()) {
      chats.appendEntry(group, {
        kind: 'human',
        text: value,
        mentions: [],
        id: `h${index}`,
        at: 1,
      });
      chats.appendEntry(group, {
        kind: 'bot',
        botId: bob,
        text: `r${index}`,
        conversationId: 'c',
        turnId: `t${index}`,
        id: `b${index}`,
        at: 1,
      });
      chats.appendEntry(group, { kind: 'system', text: 'sys', id: `s${index}`, at: 1 });
    }
    const result = await createComposerRefs(deps).expandDirect(chats.get(direct)!, {
      text: 'x',
      chats: [group],
    });
    expect(result).toContain('[User]: h2');
    expect(result).toContain('[Bob]: r3');
    expect(result).not.toContain('h1');
    expect(result).not.toContain('sys');
  });
});

describe('groupAppendix', () => {
  it('按被投递成员各自的技能集合解析，附上被引用聊天的摘录', async () => {
    const entry = chats.appendEntry(group, {
      kind: 'human',
      text: 'hi',
      mentions: [],
      id: 'h',
      at: 1,
      refs: { chats: [other], skill: 's-review' },
    })!;
    const refs = createComposerRefs(deps);
    const chat = chats.get(group)!;
    const forAlice = await refs.groupAppendix(chat, alice, [entry]);
    const forBob = await refs.groupAppendix(chat, bob, [entry]);
    expect(forAlice).toContain('<skill name="review"');
    expect(forBob).not.toContain('<skill name="review"');
    expect(forBob).toContain('<skill-unavailable name="review">');
    expect(splitChatReferences(forBob).refs).toEqual([{ id: other, title: 'Bob' }]);
    expect(await refs.groupAppendix(chat, bob, [])).toBe('');
  });
});

describe('directExcerpt', () => {
  it('剥掉笔记 / 引用块，技能折叠成名称，每轮只取最后一条回复', () => {
    const messages = directExcerpt(
      [
        text(
          'user',
          '<notes-updated>n</notes-updated>\n<skill name="review" location="/x/SKILL.md">\nbody\n</skill>\n\n看看\n\n<chat-reference id="c" title="T" kind="direct">\nold\n</chat-reference>'
        ),
        text('assistant', '思考中'),
        { role: 'toolResult', content: [{ type: 'text', text: 'tool' }] },
        text('assistant', '最终答复'),
      ],
      'Alice'
    );
    expect(messages).toEqual([
      { speaker: 'User', human: true, text: '[skill: review] 看看' },
      { speaker: 'Alice', human: false, text: '最终答复' },
    ]);
  });
});
