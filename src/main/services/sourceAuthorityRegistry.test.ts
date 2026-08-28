import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SourceAuthorityRegistry } from './sourceAuthorityRegistry';

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
});
