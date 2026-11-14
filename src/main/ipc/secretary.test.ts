import { parseProfile } from '@shared/secretary/parse';
import type { ConversationAuthority, ProjectAuthority } from '@shared/types/agent';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProfile,
} from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import {
  parseDismissRequest,
  parseReferenceRequest,
  parseResolveProposalRequest,
  parseTodoMutateRequest,
  type ReferencePorts,
  referenceConversations,
} from '../services/secretary/requests';

const localProject = (projectId: string, overrides: Partial<ProjectAuthority> = {}) =>
  ({
    projectId,
    canonicalPath: `/repo/${projectId}`,
    state: 'active',
    version: 1,
    ...overrides,
  }) as ProjectAuthority;

const rootConversation = (
  conversationId: string,
  projectId: string,
  overrides: Partial<ConversationAuthority> = {}
) =>
  ({
    conversationId,
    projectId,
    kind: 'root',
    lifecycle: 'ready',
    version: 1,
    ...overrides,
  }) as ConversationAuthority;

const emptyFile = (): SecretaryDispatchFile => ({
  version: 1,
  dispatched: {},
  named: [],
  proposals: {},
  outbox: [],
});

interface Harness {
  ports: ReferencePorts;
  file: SecretaryDispatchFile;
  audits: SecretaryAuditEntry[];
}

function harness(options: {
  projects?: ProjectAuthority[];
  conversations?: ConversationAuthority[];
  profile?: SecretaryProfile | null;
}): Harness {
  const h: Harness = {
    file: emptyFile(),
    audits: [],
    ports: undefined as unknown as ReferencePorts,
  };
  h.ports = {
    conversations: () => options.conversations ?? [],
    projects: () => options.projects ?? [localProject('p1')],
    profile: () => options.profile ?? parseProfile({}),
    dispatchFile: () => h.file,
    saveDispatch: (file) => {
      h.file = file;
    },
    audit: (entry) => {
      h.audits.push(entry);
    },
    now: () => 1_000,
  };
  return h;
}

const secretary = (conversationId: string) => conversationId === 'sec-chat';

describe('referenceConversations', () => {
  it('非秘书会话发起时拒绝', async () => {
    const h = harness({ conversations: [rootConversation('c1', 'p1')] });
    const result = await referenceConversations(
      h.ports,
      { secretaryConversationId: 'c1', conversationIds: ['c1'] },
      secretary
    );
    expect(result).toEqual({ ok: false, error: 'not-secretary' });
    expect(h.file.named).toEqual([]);
  });

  it('拒绝没有权威记录的 child 会话', async () => {
    const h = harness({ conversations: [rootConversation('c1', 'p1')] });
    const result = await referenceConversations(
      h.ports,
      { secretaryConversationId: 'sec-chat', conversationIds: ['c1::cw-abc'] },
      secretary
    );
    expect(result).toEqual({ ok: false, error: 'no-valid-conversation' });
    expect(h.file.named).toEqual([]);
  });

  it('拒绝 bot 会话', async () => {
    const h = harness({
      conversations: [
        rootConversation('bot-1', 'p1', { bot: { botId: 'b1' } as ConversationAuthority['bot'] }),
      ],
    });
    const result = await referenceConversations(
      h.ports,
      { secretaryConversationId: 'sec-chat', conversationIds: ['bot-1'] },
      secretary
    );
    expect(result).toEqual({ ok: false, error: 'no-valid-conversation' });
  });

  it('拒绝不可见项目的会话', async () => {
    const h = harness({
      projects: [localProject('p1'), localProject('p2')],
      conversations: [rootConversation('c2', 'p2')],
      profile: { ...(parseProfile({}) as SecretaryProfile), visibleProjectIds: ['p1'] },
    });
    const result = await referenceConversations(
      h.ports,
      { secretaryConversationId: 'sec-chat', conversationIds: ['c2'] },
      secretary
    );
    expect(result).toEqual({ ok: false, error: 'no-valid-conversation' });
  });

  it('拒绝秘书项目里的会话', async () => {
    const h = harness({
      projects: [localProject('p1'), localProject('sec-proj', { kind: 'secretary' })],
      conversations: [rootConversation('sec-other', 'sec-proj')],
    });
    const result = await referenceConversations(
      h.ports,
      { secretaryConversationId: 'sec-chat', conversationIds: ['sec-other'] },
      secretary
    );
    expect(result).toEqual({ ok: false, error: 'no-valid-conversation' });
  });

  it('通过的加入 named 并逐条审计', async () => {
    const h = harness({
      conversations: [rootConversation('c1', 'p1'), rootConversation('c2', 'p1')],
    });
    const result = await referenceConversations(
      h.ports,
      { secretaryConversationId: 'sec-chat', conversationIds: ['c1', 'c2', 'missing'] },
      secretary
    );
    expect(result).toEqual({ ok: true, named: ['c1', 'c2'] });
    expect(h.file.named).toEqual(['c1', 'c2']);
    expect(h.audits.map((entry) => entry.targetId)).toEqual(['c1', 'c2']);
    expect(h.audits.every((entry) => entry.ok && entry.op === 'reference_conversations')).toBe(
      true
    );
  });

  it('重复点名不重复记录', async () => {
    const h = harness({ conversations: [rootConversation('c1', 'p1')] });
    await referenceConversations(
      h.ports,
      { secretaryConversationId: 'sec-chat', conversationIds: ['c1'] },
      secretary
    );
    await referenceConversations(
      h.ports,
      { secretaryConversationId: 'sec-chat', conversationIds: ['c1'] },
      secretary
    );
    expect(h.file.named).toEqual(['c1']);
  });
});

describe('IPC 入参收窄', () => {
  it('确认提案请求只接受 confirm 与 reject', () => {
    expect(parseResolveProposalRequest({ proposalId: 'p1', action: 'confirm' })).toEqual({
      proposalId: 'p1',
      action: 'confirm',
    });
    expect(parseResolveProposalRequest({ proposalId: 'p1', action: 'execute' })).toBeNull();
    expect(parseResolveProposalRequest({ proposalId: '', action: 'confirm' })).toBeNull();
    expect(parseResolveProposalRequest('p1')).toBeNull();
  });

  it('确认提案请求带上编辑后的草案字段', () => {
    expect(
      parseResolveProposalRequest({
        proposalId: 'p1',
        action: 'confirm',
        edits: { prompt: '修发布', worktree: true, junk: 1 },
      })
    ).toEqual({ proposalId: 'p1', action: 'confirm', edits: { prompt: '修发布', worktree: true } });
    expect(
      parseResolveProposalRequest({ proposalId: 'p1', action: 'confirm', edits: 'x' })
    ).toBeNull();
  });

  it('确认档案提案时带上就地改过的草案', () => {
    expect(
      parseResolveProposalRequest({
        proposalId: 'p1',
        action: 'confirm',
        profileDraft: { name: '小秘', autonomy: 'full' },
      })
    ).toEqual({
      proposalId: 'p1',
      action: 'confirm',
      profileDraft: { name: '小秘', autonomy: 'full' },
    });
    expect(
      parseResolveProposalRequest({ proposalId: 'p1', action: 'confirm', profileDraft: 'x' })
    ).toBeNull();
  });

  it('点名请求去重并拒绝空 id', () => {
    expect(
      parseReferenceRequest({
        secretaryConversationId: 'sec-chat',
        conversationIds: ['a', 'a', ''],
      })
    ).toEqual({ secretaryConversationId: 'sec-chat', conversationIds: ['a'] });
    expect(parseReferenceRequest({ secretaryConversationId: 'sec-chat' })).toBeNull();
  });

  it('待办请求逐 action 收窄', () => {
    expect(parseTodoMutateRequest({ action: 'add', text: '看构建', dueAt: 5 })).toEqual({
      action: 'add',
      text: '看构建',
      dueAt: 5,
    });
    expect(parseTodoMutateRequest({ action: 'update', todoId: 't1', done: true })).toEqual({
      action: 'update',
      todoId: 't1',
      done: true,
    });
    expect(parseTodoMutateRequest({ action: 'update', todoId: 't1' })).toBeNull();
    expect(parseTodoMutateRequest({ action: 'remove', todoId: 't1' })).toEqual({
      action: 'remove',
      todoId: 't1',
    });
    expect(parseTodoMutateRequest({ action: 'reopen', todoId: 't1' })).toEqual({
      action: 'reopen',
      todoId: 't1',
    });
    expect(parseTodoMutateRequest({ action: 'reopen' })).toBeNull();
    expect(parseTodoMutateRequest({ action: 'dispatch', todoId: 't1', projectId: 'p1' })).toEqual({
      action: 'dispatch',
      todoId: 't1',
      projectId: 'p1',
    });
    expect(parseTodoMutateRequest({ action: 'nuke' })).toBeNull();
  });

  it('清结果请求只接受非空会话 id', () => {
    expect(parseDismissRequest({ conversationId: 'c1' })).toEqual({ conversationId: 'c1' });
    expect(parseDismissRequest({ conversationId: '  ' })).toBeNull();
    expect(parseDismissRequest({ conversationId: 5 })).toBeNull();
    expect(parseDismissRequest('c1')).toBeNull();
    expect(parseDismissRequest(null)).toBeNull();
  });
});
