import type { SecretaryProposal } from '@shared/types/secretary';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 服务端渲染拿的是 store 的初始快照，状态注入只能走 mock；store 本身的订阅由 secretary.test.ts 覆盖
const h = vi.hoisted(() => ({
  proposal: null as unknown,
  resolving: false,
  resolveProposal: (() => {}) as (proposalId: string, action: string) => void,
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => `[${key}]` }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (
    selector: (state: { projects: { id: string; name: string; path: string }[] }) => unknown
  ) => selector({ projects: [{ id: 'p1', name: 'enso', path: '/p/enso' }] }),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (selector: (state: unknown) => unknown) =>
    selector({
      secretary: { proposals: h.proposal ? { pr1: h.proposal } : {} },
      resolving: h.resolving ? { pr1: true } : {},
      resolveProposal: h.resolveProposal,
    }),
}));

const { SecretaryProposalRow, secretaryProposalId } = await import('./SecretaryProposalRow');

const base: SecretaryProposal = {
  id: 'pr1',
  secretaryConversationId: 'sec1',
  createdAt: 1,
  updatedAt: 1,
  status: 'pending',
  kind: 'dispatch',
  draft: {
    projectId: 'p1',
    prompt: '把登录页的报错修掉\n第二行不该出现在卡片上',
    worktree: true,
  },
};

const render = (over: Partial<SecretaryProposal> = {}, resolving = false): string => {
  h.proposal = { ...base, ...over };
  h.resolving = resolving;
  return renderToStaticMarkup(createElement(SecretaryProposalRow, { proposalId: 'pr1' }));
};

const buttons = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    match[1].replace(/<[^>]+>/g, '')
  );

describe('secretaryProposalId', () => {
  it('只认派活类工具结果里的待确认提案', () => {
    const output = '{"status":"awaiting_confirmation","proposalId":"pr1"}';
    expect(secretaryProposalId({ name: 'session_create', output, state: 'ok' })).toBe('pr1');
    expect(secretaryProposalId({ name: 'todo_item_dispatch', output, state: 'ok' })).toBe('pr1');
    // 已建成的结果、别的工具、运行中与出错行都不是提案卡片
    expect(
      secretaryProposalId({ name: 'session_create', output: '{"status":"created"}', state: 'ok' })
    ).toBeNull();
    expect(secretaryProposalId({ name: 'session_send', output, state: 'ok' })).toBeNull();
    expect(secretaryProposalId({ name: 'session_create', output, state: 'running' })).toBeNull();
    expect(secretaryProposalId({ name: 'session_create', output, state: 'error' })).toBeNull();
    expect(
      secretaryProposalId({ name: 'session_create', output: 'not json', state: 'ok' })
    ).toBeNull();
    expect(secretaryProposalId({ name: 'session_create', output: null, state: 'ok' })).toBeNull();
  });
});

describe('SecretaryProposalRow', () => {
  beforeEach(() => {
    h.proposal = base;
    h.resolving = false;
  });

  it('待确认：显示项目名、首句、worktree 与两个按钮', () => {
    const html = render();
    expect(html).toContain('>enso<');
    expect(html).toContain('把登录页的报错修掉');
    expect(html).not.toContain('第二行不该出现在卡片上');
    expect(html).toContain('[Isolated worktree]');
    expect(html).toContain('[Waiting for your confirmation]');
    expect(buttons(html)).toEqual(['[Confirm dispatch]', '[Reject]']);
    expect(html).not.toContain('disabled=""');
  });

  it('不加 worktree 的提案标出是项目目录', () => {
    const html = render({
      draft: { ...base.draft, worktree: false },
    } as Partial<SecretaryProposal>);
    expect(html).toContain('[Project checkout]');
    expect(html).not.toContain('[Isolated worktree]');
  });

  it('处理中：按钮禁用，避免重复提交', () => {
    const html = render({}, true);
    expect(html).toContain('[Confirm dispatch]');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it('执行中与终态只显示状态，不再给按钮', () => {
    const executing = render({ status: 'executing' });
    expect(executing).toContain('[Creating the session…]');
    expect(buttons(executing)).toEqual([]);

    const succeeded = render({ status: 'succeeded' });
    expect(succeeded).toContain('[Session created]');
    expect(buttons(succeeded)).toEqual([]);

    const failed = render({ status: 'failed', error: 'project is not visible' });
    expect(failed).toContain('[Failed]');
    expect(failed).toContain('project is not visible');
    expect(buttons(failed)).toEqual([]);

    expect(render({ status: 'rejected' })).toContain('[Rejected]');
    expect(render({ status: 'expired' })).toContain('[Expired]');
  });

  it('状态还没推过来时占位，而不是把整行吞掉', () => {
    h.proposal = null;
    const html = renderToStaticMarkup(
      createElement(SecretaryProposalRow, { proposalId: 'missing' })
    );
    expect(html).toContain('[Waiting for your confirmation]');
    expect(buttons(html)).toEqual([]);
  });
});
