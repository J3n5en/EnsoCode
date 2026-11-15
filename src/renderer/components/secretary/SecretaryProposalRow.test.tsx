import type { SecretaryProposal } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 服务端渲染拿的是 store 的初始快照，状态注入只能走 mock；store 本身的订阅由 secretary.test.ts 覆盖
const h = vi.hoisted(() => ({
  proposal: null as unknown,
  extra: {} as Record<string, unknown>,
  resolving: false,
  resolveProposal: (() => {}) as (...args: unknown[]) => void,
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
      secretary: { proposals: { ...(h.proposal ? { pr1: h.proposal } : {}), ...h.extra } },
      resolving: h.resolving ? { pr1: true } : {},
      resolveProposal: h.resolveProposal,
    }),
}));
// 就地修改的表单由 profileFormState 与 SecretaryProfileForm 自己的测试覆盖，这里只验卡片把整份草案交出去
vi.mock('./SecretaryProfileForm', () => ({
  SecretaryProfileForm: ({
    initialDraft,
    onSubmit,
  }: {
    initialDraft: Record<string, unknown>;
    onSubmit: (draft: Record<string, unknown>) => void;
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        'data-enso': 'mock-profile-form',
        onClick: () => onSubmit({ ...initialDraft, name: '改过的名字' }),
      },
      'Submit profile'
    ),
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
    expect(secretaryProposalId({ name: 'secretary_profile_propose', output, state: 'ok' })).toBe(
      'pr1'
    );
    expect(secretaryProposalId({ name: 'session_takeover_propose', output, state: 'ok' })).toBe(
      'pr1'
    );
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

  it('指定了模型的提案把模型显示出来', () => {
    const html = render({
      draft: {
        ...base.draft,
        model: { providerId: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
      },
    } as Partial<SecretaryProposal>);
    expect(html).toContain('secretary-proposal-model');
    // i18n 在测试里是直通 mock，只验模型行被渲染出来
    expect(html).toContain('[Model: {{model}}]');
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

const profileProposal: SecretaryProposal = {
  id: 'pr2',
  secretaryConversationId: 'sec1',
  createdAt: 1,
  updatedAt: 1,
  status: 'pending',
  kind: 'profile',
  draft: {
    name: '小安',
    autonomy: 'full',
    dispatchWorktree: 'always',
    maxRunningDispatches: 5,
    model: { providerId: 'p', modelId: 'm' },
  },
};

const renderProfile = (over: Partial<SecretaryProposal> = {}): string => {
  h.proposal = null;
  h.extra = { pr2: { ...profileProposal, ...over } };
  h.resolving = false;
  return renderToStaticMarkup(createElement(SecretaryProposalRow, { proposalId: 'pr2' }));
};

describe('SecretaryProposalRow profile proposals', () => {
  beforeEach(() => {
    h.proposal = null;
    h.extra = { pr2: profileProposal };
    h.resolving = false;
    h.resolveProposal = vi.fn();
  });

  it('待确认：逐项列出草案并给确认、拒绝、就地修改三个入口', () => {
    const html = renderProfile();
    expect(html).toContain('[Profile]');
    expect(html).toContain('小安');
    expect(html).toContain('m');
    expect(html).toContain('[Fully autonomous]');
    expect(html).toContain('[Always an isolated worktree]');
    expect(html).toContain('[Up to {{n}} at a time]');
    expect(html).toContain('[Waiting for your confirmation]');
    expect(buttons(html)).toEqual(['[Confirm]', '[Reject]', '[Edit here]']);
  });

  it('没指定模型时标出跟随全局默认', () => {
    expect(renderProfile({ draft: { name: '小安' } } as Partial<SecretaryProposal>)).toContain(
      '[Follows the default model]'
    );
  });

  it('终态只显示状态，不再给按钮', () => {
    expect(renderProfile({ status: 'succeeded' })).toContain('[Profile saved]');
    expect(buttons(renderProfile({ status: 'succeeded' }))).toEqual([]);
    expect(renderProfile({ status: 'rejected' })).toContain('[Rejected]');
    expect(renderProfile({ status: 'expired' })).toContain('[Expired]');
    const failed = renderProfile({ status: 'failed', error: 'invalid autonomy' });
    expect(failed).toContain('invalid autonomy');
    expect(buttons(failed)).toEqual([]);
  });

  it('就地修改后确认，把改过的整份草案作为 profileDraft 交给 Main', async () => {
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = window.document.getElementById('root') as unknown as HTMLElement;
    const root: Root = createRoot(container);
    await act(async () => root.render(createElement(SecretaryProposalRow, { proposalId: 'pr2' })));

    const edit = [...container.querySelectorAll('button')].find(
      (el) => el.textContent === '[Edit here]'
    );
    await act(async () => edit?.click());
    const submit = container.querySelector('[data-enso="mock-profile-form"]');
    expect(submit).not.toBeNull();
    await act(async () => (submit as unknown as HTMLElement).click());

    expect(h.resolveProposal).toHaveBeenCalledWith(
      'pr2',
      'confirm',
      undefined,
      expect.objectContaining({ name: '改过的名字', autonomy: 'full', maxRunningDispatches: 5 })
    );
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
});

const skillProposal: SecretaryProposal = {
  id: 'pr3',
  secretaryConversationId: 'sec1',
  createdAt: 1,
  updatedAt: 1,
  status: 'pending',
  kind: 'skill',
  draft: { name: 'deploy-check', description: '发布前跑一遍', body: '# 步骤\n\n- 跑测试' },
};

const renderSkill = (over: Partial<SecretaryProposal> = {}): string => {
  h.proposal = null;
  h.extra = { pr3: { ...skillProposal, ...over } };
  h.resolving = false;
  return renderToStaticMarkup(createElement(SecretaryProposalRow, { proposalId: 'pr3' }));
};

describe('SecretaryProposalRow skill proposals', () => {
  beforeEach(() => {
    h.proposal = null;
    h.extra = { pr3: skillProposal };
    h.resolving = false;
    h.resolveProposal = vi.fn();
  });

  it('待确认：显示名字、用途与可折叠的完整内容', () => {
    const html = renderSkill();
    expect(html).toContain('[Skill]');
    expect(html).toContain('deploy-check');
    expect(html).toContain('发布前跑一遍');
    expect(html).toContain('[New]');
    expect(html).toContain('[Show the content]');
    expect(html).toContain('跑测试');
    expect(buttons(html)).toEqual(['[Confirm]', '[Reject]']);
  });

  it('同名更新时标出更新，并摊开现有版本', () => {
    const html = renderSkill({
      previous: { description: '旧描述', body: '# 旧步骤' },
    } as Partial<SecretaryProposal>);
    expect(html).toContain('[Update]');
    expect(html).toContain('[Show the current version]');
    expect(html).toContain('旧步骤');
  });

  it('终态只显示状态，不再给按钮', () => {
    expect(renderSkill({ status: 'succeeded' })).toContain('[Skill saved]');
    expect(buttons(renderSkill({ status: 'succeeded' }))).toEqual([]);
    const failed = renderSkill({ status: 'failed', error: 'invalid skill name' });
    expect(failed).toContain('invalid skill name');
    expect(buttons(failed)).toEqual([]);
  });
});

const takeoverProposal: SecretaryProposal = {
  id: 'pr4',
  secretaryConversationId: 'sec1',
  createdAt: 1,
  updatedAt: 1,
  status: 'pending',
  kind: 'takeover',
  draft: { conversationId: 'c9', projectId: 'p1', title: '修登录', reason: '帮你盯着构建' },
};

describe('SecretaryProposalRow takeover proposals', () => {
  const renderTakeover = (over: Partial<SecretaryProposal> = {}): string => {
    h.proposal = null;
    h.extra = { pr4: { ...takeoverProposal, ...over } };
    h.resolving = false;
    return renderToStaticMarkup(createElement(SecretaryProposalRow, { proposalId: 'pr4' }));
  };

  it('待确认：显示项目、会话标题、理由与同意/拒绝', () => {
    const html = renderTakeover();
    expect(html).toContain('data-kind="takeover"');
    expect(html).toContain('[Take over]');
    expect(html).toContain('>enso<');
    expect(html).toContain('修登录');
    expect(html).toContain('帮你盯着构建');
    expect(buttons(html)).toEqual(['[Allow takeover]', '[Reject]']);
  });

  it('终态只显示状态', () => {
    const done = renderTakeover({ status: 'succeeded' });
    expect(done).toContain('[Handed over to the secretary]');
    expect(buttons(done)).toEqual([]);
    const failed = renderTakeover({ status: 'failed', error: 'archived' });
    expect(failed).toContain('archived');
    expect(buttons(failed)).toEqual([]);
  });
});

const cleanupProposal: SecretaryProposal = {
  id: 'pr5',
  secretaryConversationId: 'sec1',
  createdAt: 1,
  updatedAt: 1,
  status: 'pending',
  kind: 'cleanup',
  draft: {
    items: [
      {
        id: 'branch|/repo|feat/done',
        kind: 'branch',
        name: 'feat/done',
        mergedInto: ['feat/secretary-agent'],
      },
      {
        id: 'worktree|/wt/1',
        kind: 'worktree',
        name: 'feat/wt',
        mergedInto: ['main'],
        sizeBytes: 3 * 1024 * 1024,
      },
      { id: 'session|c9', kind: 'session', name: '写发布说明' },
    ],
  },
};

describe('SecretaryProposalRow cleanup proposals', () => {
  const renderCleanup = (over: Partial<SecretaryProposal> = {}): string => {
    h.proposal = null;
    h.extra = { pr5: { ...cleanupProposal, ...over } };
    h.resolving = false;
    return renderToStaticMarkup(createElement(SecretaryProposalRow, { proposalId: 'pr5' }));
  };

  it('确认卡把会删的每一条都列出来', () => {
    const html = renderCleanup();
    expect(html).toContain('data-kind="cleanup"');
    expect(html).toContain('[Clean up]');
    expect(html).toContain('feat/done');
    expect(html).toContain('feat/wt');
    expect(html).toContain('写发布说明');
    expect(html).toContain('[merged into {{refs}}]');
    expect(html).toContain('3.0 MB');
    expect(buttons(html)).toEqual(['[Confirm cleanup]', '[Reject]']);
  });

  it('确认后显示执行摘要，不再有按钮', () => {
    const html = renderCleanup({ status: 'succeeded', report: 'deleted 2; archived 1' });
    expect(html).toContain('[Cleanup done]');
    expect(html).toContain('deleted 2; archived 1');
    expect(buttons(html)).toEqual([]);
  });

  it('几十条时卡片只列前几条，剩下的只给数量', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: `branch|/repo|feat/b-${index}`,
      kind: 'branch' as const,
      name: `feat/b-${index}`,
    }));
    const html = renderCleanup({ draft: { items } });
    expect([...html.matchAll(/data-enso="secretary-cleanup-kind"/g)].length).toBe(5);
    expect(html).toContain('feat/b-4');
    expect(html).not.toContain('feat/b-5');
    expect(html).toContain('[and {{count}} more]');
    // 数量摘要还在：30 条分支
    expect(html).toContain('30 [Branch]');
  });

  it('cleanup_apply 的结果也算提案卡片', () => {
    const output = '{"status":"awaiting_confirmation","proposalId":"pr5"}';
    expect(secretaryProposalId({ name: 'cleanup_apply', output, state: 'ok' })).toBe('pr5');
  });
});
