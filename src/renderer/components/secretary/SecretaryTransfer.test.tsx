import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretaryTransferControl, useManagingSecretary } from './SecretaryTransfer';

const h = vi.hoisted(() => ({
  secretaries: [] as { id: string; name: string | null }[],
  states: {} as Record<
    string,
    { takeovers: { conversationId: string }[]; profile: { name: string } | null }
  >,
  conversations: {} as Record<
    string,
    { secretaryOrigin?: { secretaryConversationId: string; secretaryId?: string } }
  >,
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '') : key,
    locale: 'en',
  }),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (select: (state: object) => unknown) =>
    select({ secretaries: h.secretaries, states: h.states }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) =>
    select({ conversations: h.conversations }),
}));

function Probe({ id }: { id: string }) {
  return createElement('span', null, useManagingSecretary(id) ?? 'none');
}
const manager = (id: string) =>
  renderToStaticMarkup(createElement(Probe, { id })).replace(/<[^>]*>/g, '');
const control = (conversationId: string) =>
  renderToStaticMarkup(createElement(SecretaryTransferControl, { conversationId }));

beforeEach(() => {
  h.secretaries = [
    { id: 'default', name: '小安' },
    { id: 's2', name: '小乐' },
  ];
  h.states = {
    default: { takeovers: [], profile: { name: '小安' } },
    s2: { takeovers: [], profile: { name: '小乐' } },
  };
  h.conversations = {};
});

describe('管理会话的秘书', () => {
  it('派出归属带 id 就认它；旧数据没有 id 归 default', () => {
    h.conversations = {
      a: { secretaryOrigin: { secretaryConversationId: 'x', secretaryId: 's2' } },
      b: { secretaryOrigin: { secretaryConversationId: 'x' } },
      c: {},
    };
    expect(manager('a')).toBe('s2');
    expect(manager('b')).toBe('default');
    expect(manager('c')).toBe('none');
  });

  it('接管记录优先于派出归属；已删除的秘书不算', () => {
    h.conversations = {
      a: { secretaryOrigin: { secretaryConversationId: 'x', secretaryId: 'default' } },
      d: { secretaryOrigin: { secretaryConversationId: 'x', secretaryId: 'gone' } },
    };
    h.states.s2.takeovers = [{ conversationId: 'a' }];
    expect(manager('a')).toBe('s2');
    expect(manager('d')).toBe('none');
  });
});

describe('转交入口', () => {
  it('只有一个秘书或会话没人管时不出现', () => {
    h.conversations = { a: { secretaryOrigin: { secretaryConversationId: 'x' } }, c: {} };
    expect(control('c')).toBe('');
    h.secretaries = [{ id: 'default', name: '小安' }];
    expect(control('a')).toBe('');
  });

  it('有人管且还有别的秘书时出现入口', () => {
    h.conversations = { a: { secretaryOrigin: { secretaryConversationId: 'x' } } };
    expect(control('a')).toContain('secretary-transfer');
  });
});
