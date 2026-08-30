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
  createEditorPayload,
  extractMentionQuery,
  mentionDisplayText,
  mentionPopupLayout,
  resolvePopupKeyAction,
  serializeSegments,
  splitInlineFileTokens,
  splitInlineMentions,
  splitMentionRefs,
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

  it('turns root conversations with session files into chat candidates across projects', () => {
    const conversations = [
      // 同项目：优先排前
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
      // 跨项目：也收录，排在同项目之后
      { id: 'c5', title: 'other proj', projectId: 'p2', sessionFile: '/s/c5.jsonl', createdAt: 6 },
    ];
    expect(toChatMentionCandidates(conversations, 'p1', 'self')).toEqual([
      // 同项目 createdAt 倒序在前；空标题回落；跨项目垫后
      { kind: 'chat', id: 'c2', label: 'Untitled chat', sessionFile: '/s/c2.jsonl' },
      { kind: 'chat', id: 'c1', label: 'fix login', sessionFile: '/s/c1.jsonl' },
      { kind: 'chat', id: 'c5', label: 'other proj', sessionFile: '/s/c5.jsonl' },
    ]);
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      title: `chat ${i}`,
      projectId: 'p1',
      sessionFile: `/s/m${i}.jsonl`,
      createdAt: i,
    }));
    expect(toChatMentionCandidates(many, 'p1', 'self')).toHaveLength(20);
    // 旧数据污染：标题被追加引用块污染过（含换行），label 必须压成单行，
    // 否则拼进 chat 引用行会破坏单行格式、渲染侧解不回 chip
    expect(
      toChatMentionCandidates(
        [
          {
            id: 'dirty',
            title: 'upgrade deps\n\n@README.md\n[Referenced',
            projectId: 'p1',
            sessionFile: '/s/dirty.jsonl',
            createdAt: 1,
          },
        ],
        'p1',
        'self'
      )[0].label
    ).toBe('upgrade deps');
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

  it('detects only cursor-local mention tokens', () => {
    expect(extractMentionQuery('hello @Ens', 10)).toBe('Ens');
    expect(extractMentionQuery('mail@example.com', 16)).toBeNull();
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

  it('splits appended mention refs back out of a sent message for chip rendering', () => {
    const chat = {
      kind: 'chat' as const,
      id: 'c1',
      label: 'fix login',
      sessionFile: '/sessions/my chats/c1.jsonl',
    };
    // 旧格式尾部追加的引用块，渲染侧必须能无损解回：两者共享同一套格式约定
    const wire = `continue here\n\n[Referenced past chat "${chat.label}" — transcript file: ${chat.sessionFile} (pi session jsonl; read it if relevant)]`;
    expect(splitMentionRefs(wire)).toEqual({
      body: 'continue here',
      files: [],
      chats: [{ label: 'fix login', sessionFile: '/sessions/my chats/c1.jsonl' }],
    });
    // 无引用块：原样返回，不误伤正文里的 @ 与方括号
    expect(splitMentionRefs('hi @someone\n\nsee [docs] please')).toEqual({
      body: 'hi @someone\n\nsee [docs] please',
      files: [],
      chats: [],
    });
    // 历史消息兼容：旧版本追加过 @path 行，仍能解回 chip；只剥尾部完整匹配块
    expect(
      splitMentionRefs('para one\n\npara two\n\n@src/main/index.ts\n@src/renderer/index.ts')
    ).toEqual({
      body: 'para one\n\npara two',
      files: ['src/main/index.ts', 'src/renderer/index.ts'],
      chats: [],
    });
  });

  it('splits inline @file tokens for in-place tag rendering without touching plain @ text', () => {
    // 发出的气泡里，内联 @path 原位渲染成 tag（Cursor 式）：保持顺序与上下文
    expect(splitInlineFileTokens('compare @src/main.ts and @README.md please')).toEqual([
      { type: 'text', text: 'compare ' },
      { type: 'file', path: 'src/main.ts' },
      { type: 'text', text: ' and ' },
      { type: 'file', path: 'README.md' },
      { type: 'text', text: ' please' },
    ]);
    // 句尾标点不吃进 token
    expect(splitInlineFileTokens('see @docs/a.md.')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'file', path: 'docs/a.md' },
      { type: 'text', text: '.' },
    ]);
    // 隐藏文件与长扩展名：.DS_Store（下划线）、.gitignore（9 位）
    expect(splitInlineFileTokens('asd @.DS_Store and @.gitignore')).toEqual([
      { type: 'text', text: 'asd ' },
      { type: 'file', path: '.DS_Store' },
      { type: 'text', text: ' and ' },
      { type: 'file', path: '.gitignore' },
    ]);
    // 不误伤：无扩展名的 npm scope、邮箱（@ 前非空白）、裸 @
    expect(splitInlineFileTokens('upgrade @types/node mail user@a.com @ ok')).toEqual([
      { type: 'text', text: 'upgrade @types/node mail user@a.com @ ok' },
    ]);
    // 纯文本原样
    expect(splitInlineFileTokens('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('round-trips editor segments through wire text: files and chats keep inline positions', () => {
    const segments = [
      { type: 'text' as const, text: 'compare ' },
      { type: 'file' as const, path: 'src/main.ts' },
      { type: 'text' as const, text: ' with ' },
      {
        type: 'chat' as const,
        label: 'fix login',
        sessionFile: '/s/c1.jsonl',
      },
      { type: 'text' as const, text: ' then summarize' },
    ];
    const wire = serializeSegments(segments);
    expect(wire).toBe(
      'compare @src/main.ts with ' +
        '[Referenced past chat "fix login" — transcript file: /s/c1.jsonl (pi session jsonl; read it if relevant)]' +
        ' then summarize'
    );
    // 气泡侧全文扫描解回同样的段：两端同一套格式约定，位置/顺序无损
    expect(splitInlineMentions(wire)).toEqual(segments);
  });

  it('splitInlineMentions tolerates plain text and does not touch npm scopes or emails', () => {
    expect(splitInlineMentions('upgrade @types/node mail user@a.com')).toEqual([
      { type: 'text', text: 'upgrade @types/node mail user@a.com' },
    ]);
    expect(splitInlineMentions('asd @.DS_Store ok')).toEqual([
      { type: 'text', text: 'asd ' },
      { type: 'file', path: '.DS_Store' },
      { type: 'text', text: ' ok' },
    ]);
    // 旧格式尾部追加的 chat 引用块也能被全文扫描解到（兼容历史消息）
    expect(
      splitInlineMentions(
        'hi\n\n[Referenced past chat "old" — transcript file: /s/o.jsonl (pi session jsonl; read it if relevant)]'
      )
    ).toEqual([
      { type: 'text', text: 'hi\n\n' },
      { type: 'chat', label: 'old', sessionFile: '/s/o.jsonl' },
    ]);
  });

  it('collapses chat ref blocks to @label for titles/plain display', () => {
    const wire =
      'see [Referenced past chat "fix login" — transcript file: /s/c1.jsonl (pi session jsonl; read it if relevant)] for context';
    expect(mentionDisplayText(wire)).toBe('see @fix login for context');
    expect(mentionDisplayText('plain text')).toBe('plain text');
  });

  it('sanitizes hostile labels so nested quotes/brackets cannot break the ref line format', () => {
    // 被引用会话的标题可能含 " 或旧版污染残留的 [Referenced...] 前缀，
    // 直接嵌入会破坏引用行解析（惰性 "(.+?)" 会在内层引号提前结束）
    const hostile = '[Referenced past chat "inner" — transcript file: x] real title';
    const segments = [
      { type: 'chat' as const, label: hostile, sessionFile: '/s/c9.jsonl' },
      { type: 'text' as const, text: ' go' },
    ];
    const wire = serializeSegments(segments);
    const parsed = splitInlineMentions(wire);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe('chat');
    if (parsed[0].type === 'chat') {
      expect(parsed[0].sessionFile).toBe('/s/c9.jsonl');
      expect(parsed[0].label).not.toContain('"');
      expect(parsed[0].label).not.toContain('[');
    }
    expect(parsed[1]).toEqual({ type: 'text', text: ' go' });
  });

  it('builds the payload from editor segments: wire text inline, mentions derived', () => {
    const segments = [
      { type: 'text' as const, text: 'compare ' },
      { type: 'file' as const, path: 'src/main.ts' },
      { type: 'text' as const, text: ' with ' },
      { type: 'chat' as const, label: 'fix login', sessionFile: '/s/c1.jsonl' },
    ];
    const payload = createEditorPayload({
      segments,
      slash: null,
      images: [],
      recipient: agents[1],
    });
    expect(payload.text).toBe(
      'compare @src/main.ts with ' +
        '[Referenced past chat "fix login" — transcript file: /s/c1.jsonl (pi session jsonl; read it if relevant)]'
    );
    // mentions 从段派生：dispatch 的 fileMentions/回显都靠它
    expect(payload.mentions).toEqual([
      { kind: 'file', id: 'src/main.ts', label: 'main.ts', relativePath: 'src/main.ts' },
      { kind: 'chat', id: '/s/c1.jsonl', label: 'fix login', sessionFile: '/s/c1.jsonl' },
      agents[1],
    ]);
    expect(payload.recipient).toBe(agents[1]);
    // slash 前缀拼接；空正文只发 slash
    expect(createEditorPayload({ segments: [], slash: '/plan', images: [] }).text).toBe('/plan');
    expect(
      createEditorPayload({
        segments: [{ type: 'text', text: ' go ' }],
        slash: '/plan',
        images: [],
      }).text
    ).toBe('/plan go');
  });
});

describe('mentionPopupLayout', () => {
  const popupWidth = 280;
  const flyoutWidth = 252;
  const flyoutGap = 4;

  it('锚在 caret 左侧，左边有空间时不偏移', () => {
    expect(
      mentionPopupLayout({
        anchorLeft: 48,
        containerWidth: 640,
        popupWidth,
        flyoutWidth,
        flyoutGap,
      }).left
    ).toBe(48);
  });

  it('caret 靠右会溢出时把弹窗夹进容器右缘', () => {
    expect(
      mentionPopupLayout({
        anchorLeft: 500,
        containerWidth: 640,
        popupWidth,
        flyoutWidth,
        flyoutGap,
      }).left
    ).toBe(360);
  });

  it('caret 在容器外或为负时不小于 0', () => {
    expect(
      mentionPopupLayout({
        anchorLeft: -20,
        containerWidth: 640,
        popupWidth,
        flyoutWidth,
        flyoutGap,
      }).left
    ).toBe(0);
  });

  it('弹窗比容器还宽时仍贴左，避免负 left', () => {
    expect(
      mentionPopupLayout({
        anchorLeft: 80,
        containerWidth: 200,
        popupWidth,
        flyoutWidth,
        flyoutGap,
      }).left
    ).toBe(0);
  });

  it('夹紧后右侧仍放得下 flyout 时向右展开', () => {
    expect(
      mentionPopupLayout({
        anchorLeft: 40,
        containerWidth: 640,
        popupWidth,
        flyoutWidth,
        flyoutGap,
      }).flyoutSide
    ).toBe('right');
  });

  it('贴右后右侧不够放 flyout 时翻到左边', () => {
    expect(
      mentionPopupLayout({
        anchorLeft: 500,
        containerWidth: 640,
        popupWidth,
        flyoutWidth,
        flyoutGap,
      }).flyoutSide
    ).toBe('left');
  });
});
