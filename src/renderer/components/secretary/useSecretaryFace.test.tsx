import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Avatar = { color: string; imageVersion?: number; imageHash?: string };
type FaceState = {
  secretaryId: string | null;
  enabled: boolean;
  projectId: string | null;
  profile: { name: string; avatar: Avatar } | null;
  board: { needsYou: unknown[]; running: unknown[]; done: unknown[]; todos: unknown[] };
  takeovers: { conversationId: string }[];
};

const emptyBoard = () => ({ needsYou: [], running: [], done: [], todos: [] });

function faceState(over: Partial<FaceState> = {}): FaceState {
  return {
    secretaryId: 's-248c5247',
    enabled: true,
    projectId: 'p-ken',
    profile: { name: 'Ken', avatar: { color: '#654321', imageVersion: 5, imageHash: 'bbbb' } },
    board: emptyBoard(),
    takeovers: [],
    ...over,
  };
}

const harness = vi.hoisted(() => ({
  secretary: {
    secretaryId: 's-248c5247' as string | null,
    enabled: true,
    projectId: 'p-ken' as string | null,
    profile: {
      name: 'Ken',
      avatar: { color: '#654321', imageVersion: 5, imageHash: 'bbbb' },
    } as FaceState['profile'],
    board: { needsYou: [], running: [], done: [], todos: [] } as FaceState['board'],
    takeovers: [] as { conversationId: string }[],
  },
  secretaries: [] as {
    id: string;
    projectId: string | null;
    name: string | null;
    avatar: Avatar | null;
  }[],
  states: {} as Record<string, FaceState>,
  focusedId: 's-248c5247' as string | null,
  conversations: {} as Record<
    string,
    {
      projectId?: string;
      secretaryOrigin?: { secretaryConversationId: string; secretaryId?: string };
    }
  >,
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: { conversations: typeof harness.conversations }) => unknown) =>
    select({ conversations: harness.conversations }),
}));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => undefined }));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (select: (state: unknown) => unknown) =>
    select({
      secretary: harness.secretary,
      secretaries: harness.secretaries,
      states: harness.states,
      focusedId: harness.focusedId,
    }),
}));

const { useSecretaryFace } = await import('./useSecretaryFace');

function Probe({ conversationId }: { conversationId?: string }) {
  return createElement('i', { 'data-src': useSecretaryFace(conversationId)?.image ?? '' });
}

const image = (conversationId?: string) =>
  /data-src="([^"]*)"/u.exec(renderToStaticMarkup(createElement(Probe, { conversationId })))?.[1] ??
  '';

const KEN_FACE = 'local-image://secretary-avatar/avatar.png?v=5&amp;h=bbbb&amp;s=s-248c5247';
const B_FACE = 'local-image://secretary-avatar/avatar.png?v=9&amp;h=cccc&amp;s=s-b';

describe('useSecretaryFace', () => {
  beforeEach(() => {
    harness.secretary = faceState();
    harness.secretaries = [];
    harness.states = {};
    harness.focusedId = 's-248c5247';
    harness.conversations = {};
  });

  it('头像地址带上这张脸所属秘书的 s=，多秘书时 Main 才认得出', () => {
    expect(image()).toBe(KEN_FACE);
  });

  it('状态没有秘书 id 时不带 s=，单秘书时 Main 接受省略', () => {
    harness.secretary.secretaryId = null;
    expect(image()).toBe('local-image://secretary-avatar/avatar.png?v=5&amp;h=bbbb');
  });

  it('单秘书且未传会话时与原来一致；秘书未启用则没有脸', () => {
    harness.secretary.projectId = 'p-ken';
    harness.secretaries = [
      {
        id: 's-248c5247',
        projectId: 'p-ken',
        name: 'Ken',
        avatar: harness.secretary.profile?.avatar ?? null,
      },
    ];
    harness.states = { 's-248c5247': harness.secretary };
    harness.conversations = { 'conv-ken': { projectId: 'p-ken' } };
    expect(image('conv-ken')).toBe(KEN_FACE);
    expect(image()).toBe(KEN_FACE);

    harness.secretary.enabled = false;
    expect(image()).toBe('');
    expect(image('conv-ken')).toBe('');
  });

  it('两个秘书时，渲染 B 的会话拿到 B 的脸', () => {
    const focused = faceState({
      secretaryId: 's-a',
      projectId: 'p-a',
      profile: { name: 'A', avatar: { color: '#111111', imageVersion: 1, imageHash: 'aaaa' } },
    });
    const other = faceState({
      secretaryId: 's-b',
      projectId: 'p-b',
      profile: { name: 'B', avatar: { color: '#222222', imageVersion: 9, imageHash: 'cccc' } },
    });
    harness.secretary = focused;
    harness.focusedId = 's-a';
    harness.secretaries = [
      { id: 's-a', projectId: 'p-a', name: 'A', avatar: focused.profile?.avatar ?? null },
      { id: 's-b', projectId: 'p-b', name: 'B', avatar: other.profile?.avatar ?? null },
    ];
    harness.states = { 's-a': focused, 's-b': other };
    harness.conversations = { 'conv-b': { projectId: 'p-b' } };
    expect(image('conv-b')).toBe(B_FACE);
    expect(image()).toBe('local-image://secretary-avatar/avatar.png?v=1&amp;h=aaaa&amp;s=s-a');
  });

  it('派出的会话不在秘书项目里时，按看板认所属秘书', () => {
    const focused = faceState({
      secretaryId: 's-a',
      projectId: 'p-a',
      profile: { name: 'A', avatar: { color: '#111111', imageVersion: 1, imageHash: 'aaaa' } },
    });
    const other = faceState({
      secretaryId: 's-b',
      projectId: 'p-b',
      profile: { name: 'B', avatar: { color: '#222222', imageVersion: 9, imageHash: 'cccc' } },
      board: {
        needsYou: [],
        running: [{ kind: 'session', conversationId: 'conv-dispatch' }],
        done: [],
        todos: [],
      },
    });
    harness.secretary = focused;
    harness.focusedId = 's-a';
    harness.secretaries = [
      { id: 's-a', projectId: 'p-a', name: 'A', avatar: focused.profile?.avatar ?? null },
      { id: 's-b', projectId: 'p-b', name: 'B', avatar: other.profile?.avatar ?? null },
    ];
    harness.states = { 's-a': focused, 's-b': other };
    harness.conversations = { 'conv-dispatch': { projectId: 'p-user' } };
    expect(image('conv-dispatch')).toBe(B_FACE);
  });

  it('会话归属的秘书已删除或未知时，回退到当前聚焦秘书的脸', () => {
    const focused = faceState();
    harness.secretary = focused;
    harness.secretaries = [
      {
        id: 's-248c5247',
        projectId: 'p-ken',
        name: 'Ken',
        avatar: focused.profile?.avatar ?? null,
      },
    ];
    harness.states = {
      's-248c5247': focused,
      's-deleted': faceState({
        secretaryId: 's-deleted',
        projectId: 'p-gone',
        profile: { name: 'Gone', avatar: { color: '#333333', imageVersion: 7, imageHash: 'dddd' } },
      }),
    };
    harness.conversations = {
      gone: {
        projectId: 'p-gone',
        secretaryOrigin: { secretaryConversationId: 'old', secretaryId: 's-deleted' },
      },
      mystery: { projectId: 'p-unknown' },
    };
    expect(image('gone')).toBe(KEN_FACE);
    expect(image('mystery')).toBe(KEN_FACE);
  });
});
