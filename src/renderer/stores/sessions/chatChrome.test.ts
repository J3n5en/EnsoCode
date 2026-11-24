import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchFiles } from '../../../main/services/fileSearch';
import {
  chatProjectRoot,
  chatWorkspacePath,
  selectChatChrome,
  selectEmptyChatState,
} from './chatChrome';
import type { Conversation } from './index';

const conv = (id: string, extra: Partial<Conversation> = {}): Conversation =>
  ({
    id,
    projectId: 'p',
    title: 't',
    status: 'running',
    spawning: false,
    started: true,
    createdAt: 1,
    messages: [],
    customEntries: [],
    commands: [],
    lastSeq: 0,
    dispatchMainEvents: {},
    activeMs: 0,
    pendingApprovals: [],
    pendingAsks: [],
    backgroundTasks: [],
    subagents: [],
    toolOutputs: {},
    ...extra,
  }) as Conversation;

describe('selectChatChrome', () => {
  it('只改 messages / lastSeq 时切片字段引用不变', () => {
    const parent = conv('parent', {
      messages: [{ role: 'assistant', content: [{ type: 'thinking', text: 'a' }] }],
      lastSeq: 1,
    });
    const first = selectChatChrome({
      activeId: 'parent',
      conversations: { parent },
    });
    const second = selectChatChrome({
      activeId: 'parent',
      conversations: {
        parent: {
          ...parent,
          messages: [{ role: 'assistant', content: [{ type: 'thinking', text: 'ab' }] }],
          lastSeq: 2,
          lastOutputAt: 99,
        },
      },
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const keys = Object.keys(first!) as (keyof NonNullable<typeof first>)[];
    for (const key of keys) {
      expect(second![key]).toBe(first![key]);
    }
  });

  it('水合完成前不把空 chrome 当成未选择会话，水合完成后才显示空会话提示', () => {
    const parent = conv('parent');
    const chrome = selectChatChrome({ activeId: 'parent', conversations: { parent } });
    expect(selectEmptyChatState(null, false)).toBe('hydrating');
    expect(selectEmptyChatState(null, true)).toBe('empty');
    expect(selectEmptyChatState(chrome, false)).toBeNull();
    expect(selectEmptyChatState(chrome, true)).toBeNull();
  });
});

describe('chatWorkspacePath', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const chromeOf = (extra: Partial<Conversation> = {}) =>
    selectChatChrome({ activeId: ID, conversations: { [ID]: conv(ID, extra) } });

  it('临时会话指向 scratch/<会话 id>，而不是 scratch 根目录', () => {
    expect(chatWorkspacePath(chromeOf(), { kind: 'scratch', path: '/data/scratch' })).toBe(
      `/data/scratch/${ID}`
    );
  });

  it('普通项目仍是项目路径，有 worktree 时是 worktree', () => {
    const project = { kind: 'local', path: '/repo' };
    expect(chatWorkspacePath(chromeOf(), project)).toBe('/repo');
    expect(
      chatWorkspacePath(
        chromeOf({ worktree: { path: '/wt/feature', branch: 'feature' } } as Partial<Conversation>),
        project
      )
    ).toBe('/wt/feature');
  });
});

describe('chatProjectRoot', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('临时会话的 @ 搜索只覆盖自己的目录，看不到其他临时会话的文件', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'enso-scratch-'));
    try {
      for (const [id, file] of [
        [A, 'mine.md'],
        [B, 'theirs.md'],
      ]) {
        mkdirSync(path.join(scratch, id));
        writeFileSync(path.join(scratch, id, file), '');
      }
      const root = chatProjectRoot(A, { kind: 'scratch', path: scratch });
      const hits = searchFiles(root as string, '.md').map((hit) => hit.relativePath);
      expect(hits).toEqual(['mine.md']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('普通项目仍是项目根，不跟 worktree', () => {
    expect(chatProjectRoot(A, { kind: 'local', path: '/repo' })).toBe('/repo');
    expect(chatProjectRoot(A, { path: '/repo' })).toBe('/repo');
  });
});
