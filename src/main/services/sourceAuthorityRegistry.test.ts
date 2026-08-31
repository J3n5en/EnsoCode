import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('ssh 项目：跳过本地 FS 校验、持久化 kind/sshHost、按 host+路径去重', () => {
    const root = temporary();
    const registryFile = path.join(root, 'registry.json');
    const registry = new SourceAuthorityRegistry({ registryFile });
    // 远端路径在本机并不存在，不得走 realpathSync
    const created = registry.createProject({
      requestId: 'p1',
      path: '/srv/app/',
      kind: 'ssh',
      sshHost: 'user@dev-box',
    });
    expect(created.accepted).toBe(true);
    if (!created.accepted) return;
    expect(created.value.kind).toBe('ssh');
    expect(created.value.sshHost).toBe('user@dev-box');
    expect(created.value.canonicalPath).toBe('/srv/app'); // 尾斜杠规范化

    // 同 host 同路径去重（含尾斜杠变体）
    const dup = registry.createProject({
      requestId: 'p2',
      path: '/srv/app',
      kind: 'ssh',
      sshHost: 'user@dev-box',
    });
    expect(dup).toEqual({ accepted: true, value: created.value });
    // 不同 host 同路径是不同项目
    const otherHost = registry.createProject({
      requestId: 'p3',
      path: '/srv/app',
      kind: 'ssh',
      sshHost: 'user@other-box',
    });
    expect(otherHost.accepted).toBe(true);
    if (!otherHost.accepted) return;
    expect(otherHost.value.projectId).not.toBe(created.value.projectId);

    // 非绝对路径拒绝
    expect(
      registry.createProject({ requestId: 'p4', path: 'srv/app', kind: 'ssh', sshHost: 'h' })
        .accepted
    ).toBe(false);

    // 重新加载后 kind/sshHost 保留
    const reloaded = new SourceAuthorityRegistry({ registryFile });
    const project = reloaded.project(created.value.projectId);
    expect(project?.kind).toBe('ssh');
    expect(project?.sshHost).toBe('user@dev-box');

    // 本地项目不受 ssh 去重影响：同路径的 local 创建仍走本地校验（不存在 → 拒绝）
    expect(registry.createProject({ requestId: 'p5', path: '/srv/app' }).accepted).toBe(false);
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
