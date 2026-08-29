import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveConversationRegistry } from './activeConversationRegistry';
import { AgentSessionIndex } from './agentSessionIndex';
import { SourceAuthorityRegistry } from './sourceAuthorityRegistry';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = path.join(process.cwd(), 'temp', `active-source-${crypto.randomUUID()}`);
  const projectPath = path.join(root, 'project');
  mkdirSync(projectPath, { recursive: true });
  roots.push(root);
  const ids = ['project-1', 'conversation-1', 'parent-binding-1', 'selection-binding-1'];
  const authority = new SourceAuthorityRegistry({
    registryFile: path.join(root, 'registry.json'),
    randomUuid: () => ids.shift()!,
  });
  const project = authority.createProject({ requestId: 'project', path: projectPath });
  if (!project.accepted) throw new Error(project.error);
  const conversation = authority.createConversation({
    requestId: 'conversation',
    projectId: project.value.projectId,
    projectVersion: project.value.version,
  });
  if (!conversation.accepted) throw new Error(conversation.error);
  const selected = authority.updateSelection({
    requestId: 'selection',
    conversationId: conversation.value.conversationId,
    version: conversation.value.version,
    selection: { providerId: 'provider', modelId: 'model' },
  });
  if (!selected.accepted) throw new Error(selected.error);
  const registry = new ActiveConversationRegistry({
    authority,
    sessionIndex: new AgentSessionIndex({ readSettings: () => null }),
    isMainWebContents: (id) => id === 1,
    randomUuid: () => ids.shift()!,
    now: () => 100,
  });
  return { authority, registry, conversation: selected.value };
}

describe('ActiveConversationRegistry', () => {
  it('issues a Main model selection binding and consumes it once', () => {
    const { registry, conversation } = setup();
    expect(registry.selectConversation(1, conversation.conversationId)).toBe(true);
    const parent = registry.bindSource(1, { requestId: 'bind' });
    expect(parent.accepted).toBe(true);
    if (!parent.accepted) return;
    const selection = registry.registerModelSelection(
      1,
      {
        parentBindingId: parent.parentBindingId,
        selection: { providerId: 'provider', modelId: 'model' },
      },
      true
    );
    expect(selection.accepted).toBe(true);
    if (!selection.accepted) return;
    expect(registry.consumeSelection(selection.binding.selectionBindingId, 1)).toMatchObject({
      parentConversationId: conversation.conversationId,
      selectedModel: { providerId: 'provider', modelId: 'model' },
    });
    expect(registry.consumeSelection(selection.binding.selectionBindingId, 1)).toBeNull();
  });

  it('rejects forged sender and stale revision after dedicated selection mutation', () => {
    const { authority, registry, conversation } = setup();
    expect(registry.selectConversation(2, conversation.conversationId)).toBe(false);
    expect(registry.selectConversation(1, conversation.conversationId)).toBe(true);
    const parent = registry.bindSource(1, { requestId: 'bind' });
    if (!parent.accepted) throw new Error(parent.error);
    const selection = registry.registerModelSelection(
      1,
      {
        parentBindingId: parent.parentBindingId,
        selection: { providerId: 'provider', modelId: 'model' },
      },
      true
    );
    if (!selection.accepted) throw new Error(selection.error);
    const current = authority.conversation(conversation.conversationId)!;
    authority.updateSelection({
      requestId: 'change',
      conversationId: current.conversationId,
      version: current.version,
      selection: { providerId: 'provider', modelId: 'new-model' },
    });
    expect(registry.consumeSelection(selection.binding.selectionBindingId, 1)).toBeNull();
  });
});
