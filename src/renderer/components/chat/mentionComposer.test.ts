import type { AgentTypeCandidate } from '@shared/builtinAgents';
import { describe, expect, it } from 'vitest';
import {
  flattenMentionGroups,
  flattenMentionRoot,
  groupMentionCandidates,
  toAgentMentionCandidates,
  toChatMentionCandidates,
  toFileMentionCandidates,
} from '../../hooks/useMentionSearch';
import {
  createComposerPayload,
  extractMentionQuery,
  resolvePopupKeyAction,
  unresolvedMentionToken,
} from './mentionComposer';

const registry: AgentTypeCandidate[] = [
  {
    typeKey: 'agent:enso',
    displayName: 'Enso',
    description: 'EnsoCode system agent for product capabilities and team setup',
    source: 'system',
    locked: true,
    canDisable: false,
    canEdit: false,
  },
  {
    typeKey: 'builtin:scout',
    displayName: 'Scout',
    description: 'Fast repository reconnaissance',
    source: 'builtin',
    locked: false,
    canDisable: true,
    canEdit: false,
  },
  {
    typeKey: 'builtin:reviewer',
    displayName: 'Review',
    description: 'Built-in review',
    source: 'builtin',
    locked: false,
    canDisable: true,
    canEdit: false,
  },
  {
    typeKey: 'custom:123e4567-e89b-42d3-a456-426614174000',
    displayName: 'Review',
    description: 'Custom review',
    source: 'custom',
    locked: false,
    canDisable: false,
    canEdit: true,
  },
];
const agents = toAgentMentionCandidates(registry);
const duplicateNames = toFileMentionCandidates([
  { name: 'index.ts', relativePath: 'src/main/index.ts' },
  { name: 'index.ts', relativePath: 'src/renderer/index.ts' },
]);

describe('typed multi-entity mentions', () => {
  it('keeps Main registry order, all legal types, duplicate labels, and Files after Agents', () => {
    const groups = groupMentionCandidates('', agents, duplicateNames);
    expect(groups.agents.map((candidate) => candidate.typeKey)).toEqual([
      'agent:enso',
      'builtin:scout',
      'builtin:reviewer',
      'custom:123e4567-e89b-42d3-a456-426614174000',
    ]);
    expect(groups.agents.filter((candidate) => candidate.label === 'Review')).toMatchObject([
      { source: 'builtin', typeKey: 'builtin:reviewer' },
      {
        source: 'custom',
        typeKey: 'custom:123e4567-e89b-42d3-a456-426614174000',
      },
    ]);
    expect(flattenMentionGroups(groups).map((item) => item.group)).toEqual([
      'agents',
      'agents',
      'agents',
      'agents',
      'files',
      'files',
    ]);
  });

  it('nests Agents as a folder on empty query and flattens agents when searching', () => {
    const groups = groupMentionCandidates('', agents, duplicateNames);
    expect(flattenMentionRoot(groups, '')).toEqual([
      { type: 'folder', id: 'agents' },
      {
        type: 'item',
        group: 'files',
        candidate: duplicateNames[0],
      },
      {
        type: 'item',
        group: 'files',
        candidate: duplicateNames[1],
      },
    ]);
    expect(flattenMentionRoot(groups, '  ')).toEqual(flattenMentionRoot(groups, ''));
    const filesOnly = groupMentionCandidates('', [], duplicateNames);
    expect(flattenMentionRoot(filesOnly, '').every((item) => item.type === 'item')).toBe(true);
    const searched = groupMentionCandidates('scout', agents, duplicateNames);
    expect(flattenMentionRoot(searched, 'scout')).toEqual([
      { type: 'item', group: 'agents', candidate: agents[1] },
    ]);
  });

  it('turns same-project root conversations with session files into chat candidates', () => {
    const conversations = [
      // 命中：同项目 root 会话且有 sessionFile
      { id: 'c1', title: 'fix login', projectId: 'p1', sessionFile: '/s/c1.jsonl', createdAt: 3 },
      { id: 'c2', title: '', projectId: 'p1', sessionFile: '/s/c2.jsonl', createdAt: 5 },
      // 排除：当前会话
      { id: 'self', title: 'me', projectId: 'p1', sessionFile: '/s/self.jsonl', createdAt: 9 },
      // 排除：coworker 子会话
      {
        id: 'c3',
        title: 'child',
        projectId: 'p1',
        parentId: 'c1',
        sessionFile: '/s/c3.jsonl',
        createdAt: 8,
      },
      // 排除：无 sessionFile（无从回放）
      { id: 'c4', title: 'draft', projectId: 'p1', createdAt: 7 },
      // 排除：其它项目
      { id: 'c5', title: 'other', projectId: 'p2', sessionFile: '/s/c5.jsonl', createdAt: 6 },
    ];
    expect(toChatMentionCandidates(conversations, 'p1', 'self')).toEqual([
      // createdAt 倒序；空标题回落
      { kind: 'chat', id: 'c2', label: 'Untitled chat', sessionFile: '/s/c2.jsonl' },
      { kind: 'chat', id: 'c1', label: 'fix login', sessionFile: '/s/c1.jsonl' },
    ]);
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      title: `chat ${i}`,
      projectId: 'p1',
      sessionFile: `/s/m${i}.jsonl`,
      createdAt: i,
    }));
    expect(toChatMentionCandidates(many, 'p1', 'self')).toHaveLength(20);
  });

  it('groups chat candidates by title match and nests them as a second folder', () => {
    const chats = [
      { kind: 'chat' as const, id: 'c1', label: 'fix login', sessionFile: '/s/c1.jsonl' },
      { kind: 'chat' as const, id: 'c2', label: 'refactor store', sessionFile: '/s/c2.jsonl' },
    ];
    const grouped = groupMentionCandidates('login', agents, duplicateNames, chats);
    expect(grouped.chats).toEqual([chats[0]]);
    // 有关键词：摸平，顺序 agents → chats → files
    expect(flattenMentionRoot(grouped, 'login').map((item) => item.type)).not.toContain('folder');
    // 空查询：两个文件夹
    const empty = groupMentionCandidates('', agents, duplicateNames, chats);
    expect(flattenMentionRoot(empty, '').slice(0, 2)).toEqual([
      { type: 'folder', id: 'agents' },
      { type: 'folder', id: 'chats' },
    ]);
    // chats 为空：不出 chats 文件夹
    const noChats = groupMentionCandidates('', agents, duplicateNames, []);
    expect(flattenMentionRoot(noChats, '').filter((item) => item.type === 'folder')).toEqual([
      { type: 'folder', id: 'agents' },
    ]);
  });

  it('keeps duplicate file names distinguishable by relative path', () => {
    expect(duplicateNames).toEqual([
      {
        kind: 'file',
        id: 'src/main/index.ts',
        label: 'index.ts',
        relativePath: 'src/main/index.ts',
      },
      {
        kind: 'file',
        id: 'src/renderer/index.ts',
        label: 'index.ts',
        relativePath: 'src/renderer/index.ts',
      },
    ]);
  });

  it('detects only cursor-local mention tokens and refuses unresolved tokens', () => {
    expect(extractMentionQuery('hello @Ens', 10)).toBe('Ens');
    expect(extractMentionQuery('mail@example.com', 16)).toBeNull();
    expect(unresolvedMentionToken('review @src/main/index.ts', duplicateNames)).toBeNull();
    const spacedPath = toFileMentionCandidates([
      { name: 'design notes.md', relativePath: 'docs/design notes.md' },
    ]);
    expect(unresolvedMentionToken('review @docs/design notes.md', spacedPath)).toBeNull();
    expect(unresolvedMentionToken('review @not-selected.ts', duplicateNames)).toBe(
      'not-selected.ts'
    );
  });

  it('supports wraparound keyboard selection, Tab, Escape, and IME-safe Enter', () => {
    expect(
      resolvePopupKeyAction({
        key: 'ArrowUp',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
      })
    ).toEqual({ type: 'move', index: 2 });
    expect(
      resolvePopupKeyAction({
        key: 'Tab',
        shiftKey: false,
        isComposing: false,
        activeIndex: 1,
        itemCount: 3,
      })
    ).toEqual({ type: 'pick' });
    expect(
      resolvePopupKeyAction({
        key: 'Escape',
        shiftKey: false,
        isComposing: false,
        activeIndex: 1,
        itemCount: 3,
      })
    ).toEqual({ type: 'close' });
    expect(
      resolvePopupKeyAction({
        key: 'Enter',
        shiftKey: false,
        isComposing: true,
        activeIndex: 1,
        itemCount: 3,
      })
    ).toEqual({ type: 'none' });
  });

  it('opens, navigates, and closes the Agents folder without picking the parent row', () => {
    expect(
      resolvePopupKeyAction({
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        activeIsFolder: true,
      })
    ).toEqual({ type: 'open-folder' });
    expect(
      resolvePopupKeyAction({
        key: 'ArrowRight',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        activeIsFolder: true,
      })
    ).toEqual({ type: 'open-folder' });
    expect(
      resolvePopupKeyAction({
        key: 'ArrowDown',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 0,
        folderItemCount: 4,
      })
    ).toEqual({ type: 'move-folder', index: 1 });
    expect(
      resolvePopupKeyAction({
        key: 'ArrowUp',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 0,
        folderItemCount: 4,
      })
    ).toEqual({ type: 'move-folder', index: 3 });
    expect(
      resolvePopupKeyAction({
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 2,
        folderItemCount: 4,
      })
    ).toEqual({ type: 'pick' });
    expect(
      resolvePopupKeyAction({
        key: 'Escape',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 1,
        folderItemCount: 4,
      })
    ).toEqual({ type: 'close-folder' });
    expect(
      resolvePopupKeyAction({
        key: 'ArrowLeft',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 1,
        folderItemCount: 4,
      })
    ).toEqual({ type: 'close-folder' });
    // 候选异步变空时 Escape 仍要能退出 folder，否则根级 close 永远走不到，弹窗死锁
    expect(
      resolvePopupKeyAction({
        key: 'Escape',
        shiftKey: false,
        isComposing: false,
        activeIndex: 0,
        itemCount: 3,
        folderOpen: true,
        folderIndex: 0,
        folderItemCount: 0,
      })
    ).toEqual({ type: 'close-folder' });
  });

  it('appends file and past-chat references for chip mentions at send time', () => {
    // 文件/会话都走 chip 形态不占文本 token（色块 tag 无法在 textarea 内渲染），
    // 发送时统一追加：文件给 @path token，会话给 jsonl 路径引用块。
    const chat = {
      kind: 'chat' as const,
      id: 'c1',
      label: 'fix login',
      sessionFile: '/sessions/c1.jsonl',
    };
    const payload = createComposerPayload({
      text: 'continue from where we left off',
      slash: null,
      images: [],
      mentions: [chat, duplicateNames[0]],
    });
    expect(payload.text).toBe(
      'continue from where we left off\n\n' +
        `@${duplicateNames[0].relativePath}\n` +
        '[Referenced past chat "fix login" — transcript file: /sessions/c1.jsonl (pi session jsonl; read it if relevant)]'
    );
    // 无 chip mention 时文本原样；recipient(agent-type) 不产生引用块
    expect(
      createComposerPayload({ text: 'hi', slash: null, images: [], mentions: [agents[1]] }).text
    ).toBe('hi');
    // slash 前缀在引用块之前拼接
    expect(
      createComposerPayload({ text: 'go', slash: '/plan', images: [], mentions: [chat] }).text
    ).toBe(
      '/plan go\n\n[Referenced past chat "fix login" — transcript file: /sessions/c1.jsonl (pi session jsonl; read it if relevant)]'
    );
  });

  it('builds a typed recipient payload with explicit file context', () => {
    const payload = createComposerPayload({
      text: 'summarize this file',
      slash: null,
      images: [],
      mentions: [duplicateNames[0], agents[1]],
      recipient: agents[1],
    });
    expect(payload.recipient).toMatchObject({
      kind: 'agent-type',
      typeKey: 'builtin:scout',
    });
    expect(payload.mentions[0]).toMatchObject({ kind: 'file', id: 'src/main/index.ts' });
    expect(payload.text).toBe('summarize this file\n\n@src/main/index.ts');
  });
});
