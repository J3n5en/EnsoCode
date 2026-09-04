import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeRemoteProjectPath, SourceAuthorityRegistry } from './sourceAuthorityRegistry';

const roots: string[] = [];
const temporary = () => {
  const root = path.join(process.cwd(), 'temp', `source-authority-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SourceAuthorityRegistry', () => {
  it('atomically owns project/conversation target and ignores later generic settings forgery', () => {
    const root = temporary();
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath);
    const projectId = '11111111-1111-4111-8111-111111111111';
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const settingsState = { projects: [{ id: projectId, path: projectPath }] };
    const settings: Record<string, unknown> = {
      'enso-settings': { state: settingsState },
      'enso-conversations': {
        state: { conversations: { [conversationId]: { projectId } } },
      },
    };
    const registryFile = path.join(root, 'agent', 'source-registry.json');
    const registry = new SourceAuthorityRegistry({ registryFile, legacySettings: () => settings });
    expect(registry.conversation(conversationId)?.projectId).toBe(projectId);

    settingsState.projects = [{ id: projectId, path: '/tmp/forged-target' }];
    expect(registry.project(projectId)?.canonicalPath).toBe(projectPath);
    expect(readFileSync(registryFile, 'utf8')).not.toContain('forged-target');
  });

  it('uses Main ids, versions, and prevents stale mutations from reviving ended roots', () => {
    const root = temporary();
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath);
    const ids = ['project-main', 'conversation-main'];
    const registry = new SourceAuthorityRegistry({
      registryFile: path.join(root, 'registry.json'),
      randomUuid: () => ids.shift()!,
    });
    const project = registry.createProject({ requestId: 'p', path: projectPath });
    expect(project.accepted).toBe(true);
    if (!project.accepted) return;
    const conversation = registry.createConversation({
      requestId: 'c',
      projectId: project.value.projectId,
      projectVersion: project.value.version,
    });
    expect(conversation.accepted).toBe(true);
    if (!conversation.accepted) return;
    const ended = registry.endConversation({
      requestId: 'e',
      conversationId: conversation.value.conversationId,
      version: conversation.value.version,
    });
    expect(ended.accepted).toBe(true);
    expect(
      registry.updateSelection({
        requestId: 'stale',
        conversationId: conversation.value.conversationId,
        version: conversation.value.version,
        selection: { providerId: 'forged', modelId: 'forged' },
      })
    ).toEqual({ accepted: false, error: 'Conversation authority is stale or unavailable.' });
  });

  it('persists forkedFrom across create, markReady, and reload', () => {
    const root = temporary();
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath);
    const registryFile = path.join(root, 'registry.json');
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const registry = new SourceAuthorityRegistry({
      registryFile,
      randomUuid: () => ids.shift()!,
    });
    const project = registry.createProject({ requestId: 'p', path: projectPath });
    expect(project.accepted).toBe(true);
    if (!project.accepted) return;
    const source = registry.createConversation({
      requestId: 'c1',
      projectId: project.value.projectId,
      projectVersion: project.value.version,
    });
    expect(source.accepted).toBe(true);
    if (!source.accepted) return;
    const origin = {
      conversationId: source.value.conversationId,
      entryId: 'leaf-1',
    };
    const branched = registry.createConversation({
      requestId: 'c2',
      projectId: project.value.projectId,
      projectVersion: project.value.version,
      forkedFrom: origin,
    });
    expect(branched.accepted).toBe(true);
    if (!branched.accepted) return;
    expect(branched.value.forkedFrom).toEqual(origin);
    registry.markReady(
      branched.value.conversationId,
      '/tmp/branch.jsonl',
      { providerId: 'p', modelId: 'm' },
      { conversationId: source.value.conversationId, entryId: 'leaf-2' }
    );
    const reloaded = new SourceAuthorityRegistry({ registryFile });
    expect(reloaded.conversation(branched.value.conversationId)?.forkedFrom).toEqual({
      conversationId: source.value.conversationId,
      entryId: 'leaf-2',
    });
  });

  it('skips legacy session files outside the safe session root', () => {
    const root = temporary();
    const projectPath = path.join(root, 'project');
    const sessions = path.join(root, 'agent', 'sessions');
    mkdirSync(projectPath);
    mkdirSync(sessions, { recursive: true });
    const outside = path.join(root, 'outside.jsonl');
    writeFileSync(outside, '{}\n');
    const registry = new SourceAuthorityRegistry({
      registryFile: path.join(root, 'registry.json'),
      safeSessionRoot: sessions,
      legacySettings: () => ({
        'enso-settings': {
          state: {
            projects: [{ id: '33333333-3333-4333-8333-333333333333', path: projectPath }],
          },
        },
        'enso-conversations': {
          state: {
            conversations: {
              '44444444-4444-4444-8444-444444444444': {
                projectId: '33333333-3333-4333-8333-333333333333',
                sessionFile: outside,
              },
            },
          },
        },
      }),
    });
    expect(registry.conversation('44444444-4444-4444-8444-444444444444')).toMatchObject({
      lifecycle: 'draft',
    });
    expect(
      registry.conversation('44444444-4444-4444-8444-444444444444')?.sessionFile
    ).toBeUndefined();
  });

  it('adopts a phone-generated root id instead of minting a new one', () => {
    const root = temporary();
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath);
    const phoneSessionId = '55555555-5555-4555-8555-555555555555';
    const registry = new SourceAuthorityRegistry({
      registryFile: path.join(root, 'registry.json'),
      randomUuid: () => 'should-not-mint',
    });
    const project = registry.createProject({ requestId: 'p', path: projectPath });
    expect(project.accepted).toBe(true);
    if (!project.accepted) return;
    const created = registry.createConversation({
      requestId: 'c',
      projectId: project.value.projectId,
      projectVersion: project.value.version,
      conversationId: phoneSessionId,
    });
    expect(created).toEqual({
      accepted: true,
      value: {
        conversationId: phoneSessionId,
        projectId: project.value.projectId,
        kind: 'root',
        lifecycle: 'draft',
        version: 1,
      },
    });
    expect(registry.conversation(phoneSessionId)?.conversationId).toBe(phoneSessionId);
  });

  it('adopts the same live root id idempotently and refuses ended or foreign roots', () => {
    const root = temporary();
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath);
    const otherPath = path.join(root, 'other');
    mkdirSync(otherPath);
    const phoneSessionId = '66666666-6666-4666-8666-666666666666';
    const registry = new SourceAuthorityRegistry({
      registryFile: path.join(root, 'registry.json'),
    });
    const project = registry.createProject({ requestId: 'p', path: projectPath });
    const other = registry.createProject({ requestId: 'o', path: otherPath });
    expect(project.accepted && other.accepted).toBe(true);
    if (!project.accepted || !other.accepted) return;
    const first = registry.createConversation({
      requestId: 'c1',
      projectId: project.value.projectId,
      projectVersion: project.value.version,
      conversationId: phoneSessionId,
    });
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;
    expect(
      registry.createConversation({
        requestId: 'c2',
        projectId: project.value.projectId,
        projectVersion: project.value.version,
        conversationId: phoneSessionId,
      })
    ).toEqual(first);
    expect(
      registry.createConversation({
        requestId: 'c3',
        projectId: other.value.projectId,
        projectVersion: other.value.version,
        conversationId: phoneSessionId,
      })
    ).toEqual({ accepted: false, error: 'Conversation authority is stale or unavailable.' });
    const ended = registry.endConversation({
      requestId: 'e',
      conversationId: phoneSessionId,
      version: first.value.version,
    });
    expect(ended.accepted).toBe(true);
    expect(
      registry.createConversation({
        requestId: 'c4',
        projectId: project.value.projectId,
        projectVersion: project.value.version,
        conversationId: phoneSessionId,
      })
    ).toEqual({ accepted: false, error: 'Conversation authority is stale or unavailable.' });
  });

  it('ssh 项目：跳过本地 FS 校验、持久化 connectionId、按连接+路径去重', () => {
    const root = temporary();
    const registryFile = path.join(root, 'registry.json');
    const connA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const connB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const registry = new SourceAuthorityRegistry({
      registryFile,
      resolveSshConnection: (id) => {
        if (id === connA) return { host: 'dev-box', user: 'user', name: 'prod' };
        if (id === connB) return { host: 'other-box', user: 'user', name: 'staging' };
        return null;
      },
    });
    const created = registry.createProject({
      requestId: 'p1',
      path: '/srv/app/',
      kind: 'ssh',
      sshConnectionId: connA,
    });
    expect(created.accepted).toBe(true);
    if (!created.accepted) return;
    expect(created.value.kind).toBe('ssh');
    expect(created.value.sshHost).toBe('user@dev-box');
    expect(created.value.sshConnectionName).toBe('prod');
    expect(created.value.sshConnectionId).toBe(connA);
    expect(created.value.canonicalPath).toBe('/srv/app');
    expect(registry.sshConnectionInUse(connA)).toBe(true);

    const dup = registry.createProject({
      requestId: 'p2',
      path: '/srv/app',
      kind: 'ssh',
      sshConnectionId: connA,
    });
    expect(dup).toEqual({ accepted: true, value: created.value });
    const otherHost = registry.createProject({
      requestId: 'p3',
      path: '/srv/app',
      kind: 'ssh',
      sshConnectionId: connB,
    });
    expect(otherHost.accepted).toBe(true);
    if (!otherHost.accepted) return;
    expect(otherHost.value.projectId).not.toBe(created.value.projectId);

    expect(
      registry.createProject({
        requestId: 'p4',
        path: 'srv/app',
        kind: 'ssh',
        sshConnectionId: connA,
      }).accepted
    ).toBe(false);
    expect(
      registry.createProject({
        requestId: 'p4b',
        path: '/srv/app',
        kind: 'ssh',
        sshConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      })
    ).toEqual({ accepted: false, error: 'SSH 连接不存在。' });

    const reloaded = new SourceAuthorityRegistry({ registryFile });
    const project = reloaded.project(created.value.projectId);
    expect(project?.kind).toBe('ssh');
    expect(project?.sshHost).toBe('user@dev-box');
    expect(project?.sshConnectionId).toBe(connA);

    expect(registry.createProject({ requestId: 'p5', path: '/srv/app' }).accepted).toBe(false);
  });

  it('reuses the existing local project when the same directory is added again', () => {
    const root = temporary();
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath);
    const registry = new SourceAuthorityRegistry({
      registryFile: path.join(root, 'registry.json'),
    });
    const created = registry.createProject({ requestId: 'p1', path: projectPath });
    expect(created.accepted).toBe(true);
    if (!created.accepted) return;
    const again = registry.createProject({
      requestId: 'p2',
      path: `${projectPath}${path.sep}`,
    });
    expect(again).toEqual(created);
    expect(
      registry.projection().projects.filter((project) => project.state === 'active')
    ).toHaveLength(1);
  });

  it('merges persisted local duplicates onto the earliest project and remaps conversations', () => {
    const root = temporary();
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath);
    const keeperId = '11111111-1111-4111-8111-111111111111';
    const duplicateId = '22222222-2222-4222-8222-222222222222';
    const keeperConversation = '33333333-3333-4333-8333-333333333333';
    const duplicateConversation = '44444444-4444-4444-8444-444444444444';
    const registryFile = path.join(root, 'registry.json');
    writeFileSync(
      registryFile,
      JSON.stringify({
        migrationVersion: 1,
        projects: [
          {
            projectId: keeperId,
            canonicalPath: projectPath,
            state: 'active',
            version: 1,
          },
          {
            projectId: duplicateId,
            canonicalPath: `${projectPath}${path.sep}`,
            state: 'active',
            version: 1,
          },
        ],
        conversations: [
          {
            conversationId: keeperConversation,
            projectId: keeperId,
            kind: 'root',
            lifecycle: 'draft',
            version: 1,
          },
          {
            conversationId: duplicateConversation,
            projectId: duplicateId,
            kind: 'root',
            lifecycle: 'draft',
            version: 1,
          },
        ],
      })
    );
    const registry = new SourceAuthorityRegistry({ registryFile });
    expect(registry.project(keeperId)?.state).toBe('active');
    expect(registry.project(duplicateId)?.state).toBe('removed');
    expect(registry.conversation(keeperConversation)?.projectId).toBe(keeperId);
    expect(registry.conversation(duplicateConversation)?.projectId).toBe(keeperId);
    expect(
      registry.projection().projects.filter((project) => project.state === 'active')
    ).toHaveLength(1);
    const reloaded = new SourceAuthorityRegistry({ registryFile });
    expect(reloaded.conversation(duplicateConversation)?.projectId).toBe(keeperId);
    expect(reloaded.project(duplicateId)?.state).toBe('removed');
  });

  it('treats a symlink and its realpath as the same local project', () => {
    const root = temporary();
    const projectPath = path.join(root, 'project');
    const linkPath = path.join(root, 'alias');
    mkdirSync(projectPath);
    symlinkSync(projectPath, linkPath);
    const registryFile = path.join(root, 'registry.json');
    writeFileSync(
      registryFile,
      JSON.stringify({
        migrationVersion: 1,
        projects: [
          {
            projectId: '11111111-1111-4111-8111-111111111111',
            canonicalPath: linkPath,
            state: 'active',
            version: 1,
          },
        ],
        conversations: [],
      })
    );
    const registry = new SourceAuthorityRegistry({ registryFile });
    const again = registry.createProject({ requestId: 'p', path: projectPath });
    expect(again.accepted).toBe(true);
    if (!again.accepted) return;
    expect(again.value.projectId).toBe('11111111-1111-4111-8111-111111111111');
    expect(again.value.canonicalPath).toBe(projectPath);
  });

  it('merges duplicate legacy settings projects onto the earliest path identity', () => {
    const root = temporary();
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath);
    const keeperId = '11111111-1111-4111-8111-111111111111';
    const duplicateId = '22222222-2222-4222-8222-222222222222';
    const conversationId = '33333333-3333-4333-8333-333333333333';
    const registry = new SourceAuthorityRegistry({
      registryFile: path.join(root, 'registry.json'),
      legacySettings: () => ({
        'enso-settings': {
          state: {
            projects: [
              { id: keeperId, path: projectPath },
              { id: duplicateId, path: `${projectPath}${path.sep}` },
            ],
          },
        },
        'enso-conversations': {
          state: {
            conversations: {
              [conversationId]: { projectId: duplicateId },
            },
          },
        },
      }),
    });
    expect(registry.project(keeperId)?.state).toBe('active');
    expect(registry.project(duplicateId)).toBeUndefined();
    expect(registry.conversation(conversationId)?.projectId).toBe(keeperId);
    expect(
      registry.projection().projects.filter((project) => project.state === 'active')
    ).toHaveLength(1);
  });

  it('merges persisted ssh duplicates on the same connection and path', () => {
    const root = temporary();
    const connA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const keeperId = '11111111-1111-4111-8111-111111111111';
    const duplicateId = '22222222-2222-4222-8222-222222222222';
    const registryFile = path.join(root, 'registry.json');
    writeFileSync(
      registryFile,
      JSON.stringify({
        migrationVersion: 1,
        projects: [
          {
            projectId: keeperId,
            canonicalPath: '/srv/app/',
            kind: 'ssh',
            sshHost: 'user@dev-box',
            sshConnectionId: connA,
            state: 'active',
            version: 1,
          },
          {
            projectId: duplicateId,
            canonicalPath: '/srv/app',
            kind: 'ssh',
            sshHost: 'user@dev-box',
            sshConnectionId: connA,
            state: 'active',
            version: 1,
          },
        ],
        conversations: [],
      })
    );
    const registry = new SourceAuthorityRegistry({
      registryFile,
      resolveSshConnection: (id) =>
        id === connA ? { host: 'dev-box', user: 'user', name: 'prod' } : null,
    });
    expect(registry.project(keeperId)?.canonicalPath).toBe('/srv/app');
    expect(registry.project(duplicateId)?.state).toBe('removed');
    const again = registry.createProject({
      requestId: 'p',
      path: '/srv/app',
      kind: 'ssh',
      sshConnectionId: connA,
    });
    expect(again.accepted).toBe(true);
    if (!again.accepted) return;
    expect(again.value.projectId).toBe(keeperId);
  });
});

describe('normalizeRemoteProjectPath', () => {
  it('规范化远端绝对路径，拒绝相对/空/带 .. 的路径', () => {
    expect(normalizeRemoteProjectPath('/srv/app')).toBe('/srv/app');
    expect(normalizeRemoteProjectPath('/srv/app/')).toBe('/srv/app');
    expect(normalizeRemoteProjectPath('/srv//app///')).toBe('/srv/app');
    expect(normalizeRemoteProjectPath('/')).toBe('/');
    expect(normalizeRemoteProjectPath('relative/path')).toBeNull();
    expect(normalizeRemoteProjectPath('')).toBeNull();
    expect(normalizeRemoteProjectPath('~/app')).toBeNull();
    expect(normalizeRemoteProjectPath('/srv/../etc')).toBeNull();
    expect(normalizeRemoteProjectPath('/srv/./app')).toBeNull();
  });
});
