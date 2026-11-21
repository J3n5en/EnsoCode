import { type Locale, translate } from '@shared/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretaryOriginBadge, showsMutedBell } from './SecretaryOriginBadge';
import { SecretaryTakeoverBadge, SecretaryTakeoverControl } from './SecretaryTakeover';

const h = vi.hoisted(() => ({
  name: '',
  locale: 'zh' as Locale,
  takeovers: [] as { conversationId: string }[],
  states: {} as Record<
    string,
    {
      secretaryId: string;
      profile: { name: string; avatar: { color: string } } | null;
      board: { running: unknown[]; needsYou: unknown[]; done: unknown[]; todos: unknown[] };
      takeovers: { conversationId: string }[];
    }
  >,
  focusedId: null as string | null,
  secretaries: [] as {
    id: string;
    projectId: string | null;
    name: string | null;
    avatar: { color: string; imageVersion?: number; imageHash?: string } | null;
    order: number;
  }[],
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate(h.locale, key, params),
    locale: h.locale,
  }),
}));
vi.mock('@/stores/secretary', () => ({
  focusedSecretaryId: () => undefined,
  useSecretaryStore: (select: (state: object) => unknown) =>
    select({
      secretary: {
        profile: { name: h.name, avatar: { color: '#ff6b9d' } },
        takeovers: h.takeovers,
        board: { running: [], needsYou: [], done: [], todos: [] },
      },
      states: h.states,
      focusedId: h.focusedId,
      secretaries: h.secretaries,
    }),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => undefined }));

const render = (component: typeof SecretaryTakeoverBadge) =>
  renderToStaticMarkup(createElement(component)).replace(/<[^>]*>/g, '');
const takeoverBadge = (conversationId?: string) =>
  renderToStaticMarkup(
    createElement(
      SecretaryTakeoverBadge as (props: { conversationId?: string }) => React.ReactNode,
      { conversationId }
    )
  ).replace(/<[^>]*>/g, '');
const origin = (props: Parameters<typeof SecretaryOriginBadge>[0] = {}) =>
  renderToStaticMarkup(createElement(SecretaryOriginBadge, props));
const labelOf = (html: string) => /aria-label="([^"]*)"/.exec(html)?.[1];

beforeEach(() => {
  h.secretaries = [];
  h.takeovers = [];
  h.states = {};
  h.focusedId = null;
});

describe('秘书会话标识用昵称', () => {
  it('显示用户改的名字', () => {
    h.name = '爱酱';
    h.locale = 'zh';
    expect(labelOf(origin())).toBe('由 爱酱 派出');
    expect(render(SecretaryTakeoverBadge)).toBe('爱酱接管中');
  });

  it('没设名字时回退到「秘书」', () => {
    h.name = '  ';
    h.locale = 'zh';
    expect(labelOf(origin())).toBe('由 秘书 派出');
    expect(render(SecretaryTakeoverBadge)).toBe('秘书接管中');
  });

  it('英文界面同样带名字', () => {
    h.name = 'Ai';
    h.locale = 'en';
    expect(labelOf(origin())).toBe('Dispatched by Ai');
    expect(render(SecretaryTakeoverBadge)).toBe('Managed by Ai');
  });
});

describe('派出来源：秘书小头像', () => {
  const summary = (id: string, name: string, avatar: (typeof h.secretaries)[number]['avatar']) => ({
    id,
    projectId: `p-${id}`,
    name,
    avatar,
    order: 0,
  });

  it('行上只放头像不放文字，悬停与读屏写明谁派的', () => {
    h.name = '爱酱';
    h.locale = 'zh';
    const html = origin();
    expect(html.replace(/<[^>]*>/g, '')).toBe('');
    expect(html).toContain('data-enso="secretary-origin-face"');
    expect(html).toContain('role="img"');
    expect(labelOf(html)).toBe('由 爱酱 派出');
  });

  it('静音写进提示：由 爱酱 派出 · 已静音', () => {
    h.name = '爱酱';
    h.locale = 'zh';
    expect(labelOf(origin({ muted: true }))).toBe('由 爱酱 派出 · 已静音');
    h.locale = 'en';
    expect(labelOf(origin({ muted: true }))).toBe('Dispatched by 爱酱 · muted');
  });

  it('多个秘书各显示各的头像：GIF 用图片，没传图的按名字生成', () => {
    h.locale = 'zh';
    h.secretaries = [
      summary('default', '爱酱', { color: '#ff6b9d', imageVersion: 3, imageHash: 'abc' }),
      summary('s-2', '小乐', { color: '#3fa7ff' }),
    ];
    const first = origin({ secretaryId: 'default' });
    expect(labelOf(first)).toBe('由 爱酱 派出');
    expect(first).toContain('<img');
    expect(first).toMatch(/src="[^"]*v=3[^"]*s=default/);
    const second = origin({ secretaryId: 's-2' });
    expect(labelOf(second)).toBe('由 小乐 派出');
    expect(second).not.toContain('<img');
    expect(second).toContain('data-generated="true"');
  });

  it('清单还没到时按当前秘书认；聚焦秘书换了也不影响已经能对上号的会话', () => {
    h.locale = 'zh';
    h.name = '爱酱';
    // 清单为空：还没有 secretaryId 的旧会话按当前秘书
    expect(labelOf(origin())).toBe('由 爱酱 派出');
    h.secretaries = [
      summary('default', '爱酱', { color: '#ff6b9d' }),
      summary('s-ken', 'Ken', { color: '#3fa7ff' }),
    ];
    // 旧会话没有 id：回退到看板记录，Ken 的看板里有它就显示 Ken
    h.states = {
      's-ken': {
        secretaryId: 's-ken',
        profile: { name: 'Ken', avatar: { color: '#3fa7ff' } },
        board: {
          running: [
            { kind: 'session', conversationId: 'c-ken', secretaryConversationId: 'sec-ken' },
          ],
          needsYou: [],
          done: [],
          todos: [],
        },
        takeovers: [],
      },
    };
    expect(labelOf(origin({ conversationId: 'c-ken' }))).toBe('由 Ken 派出');
    // 聚焦切到爱酱：这一行仍然是 Ken
    h.focusedId = 'default';
    h.name = '爱酱';
    expect(labelOf(origin({ conversationId: 'c-ken' }))).toBe('由 Ken 派出');
  });

  it('秘书已删除：通用秘书小图标，提示写「由已删除的秘书派出」', () => {
    h.locale = 'zh';
    h.secretaries = [summary('default', '爱酱', { color: '#ff6b9d' })];
    const html = origin({ secretaryId: 'gone', muted: true });
    expect(html).toContain('data-deleted="true"');
    expect(html).not.toContain('secretary-origin-face');
    expect(html).toContain('<svg');
    expect(labelOf(html)).toBe('由已删除的秘书派出 · 已静音');
  });
});

describe('静音铃铛', () => {
  it('派出且静音不挂铃铛；手动静音的普通会话照旧挂', () => {
    expect(showsMutedBell(true, true)).toBe(false);
    expect(showsMutedBell(true, false)).toBe(true);
    expect(showsMutedBell(false, true)).toBe(false);
    expect(showsMutedBell(false, false)).toBe(false);
  });
});

describe('会话顶栏不再给「交给…接管」按钮', () => {
  const control = (conversationId: string) =>
    renderToStaticMarkup(createElement(SecretaryTakeoverControl, { conversationId }));

  it('未接管时什么都不渲染，逐个授权只走秘书提的确认卡', () => {
    h.name = '爱酱';
    h.locale = 'zh';
    h.takeovers = [];
    expect(control('c1')).toBe('');
    expect(control('c1')).not.toContain('secretary-takeover-grant');
    expect(control('c1')).not.toContain('交给爱酱接管');
  });

  it('接管中仍显示标识与取消按钮', () => {
    h.name = '爱酱';
    h.locale = 'zh';
    h.takeovers = [{ conversationId: 'c1' }];
    const html = control('c1');
    expect(html).toContain('secretary-takeover-chip');
    expect(html).toContain('secretary-takeover-revoke');
    expect(html).toContain('爱酱接管中');
    // 别的会话不受影响
    expect(control('c2')).toBe('');
  });

  it('接管标识按管着这个会话的那个秘书，不随当前聚焦的秘书变', () => {
    h.locale = 'zh';
    h.name = '爱酱';
    h.focusedId = 'default';
    h.states = {
      's-ken': {
        secretaryId: 's-ken',
        profile: { name: 'Ken', avatar: { color: '#3fa7ff' } },
        board: { running: [], needsYou: [], done: [], todos: [] },
        takeovers: [{ conversationId: 'c1' }],
      },
    };
    expect(takeoverBadge('c1')).toBe('Ken接管中');
  });
});
