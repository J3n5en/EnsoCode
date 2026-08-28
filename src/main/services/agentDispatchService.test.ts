import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { CapabilityReceipt } from '@shared/capabilities/types';
import type {
  AgentSessionCustomEntry,
  DispatchMainEvent,
  ResolvedAgentTypeSpawnConfig,
} from '@shared/types/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveConversationRegistry } from './activeConversationRegistry';
import { AgentDispatchService } from './agentDispatchService';
import { AgentSessionIndex } from './agentSessionIndex';
import { SourceAuthorityRegistry } from './sourceAuthorityRegistry';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(
  proofOverride?: (proof: ResolvedAgentTypeSpawnConfig) => Partial<ResolvedAgentTypeSpawnConfig>
) {
  const root = path.join(process.cwd(), 'temp', `dispatch-${crypto.randomUUID()}`);
  const projectPath = path.join(root, 'project');
  mkdirSync(projectPath, { recursive: true });
  roots.push(root);
  const authority = new SourceAuthorityRegistry({ registryFile: path.join(root, 'registry.json') });
  const project = authority.createProject({ requestId: 'p', path: projectPath });
  if (!project.accepted) throw new Error(project.error);
  const conversation = authority.createConversation({
    requestId: 'c',
    projectId: project.value.projectId,
    projectVersion: project.value.version,
  });
  if (!conversation.accepted) throw new Error(conversation.error);
  const selected = authority.updateSelection({
    requestId: 's',
    conversationId: conversation.value.conversationId,
    version: conversation.value.version,
    selection: { providerId: 'provider', modelId: 'model' },
  });
  if (!selected.accepted) throw new Error(selected.error);
  const index = new AgentSessionIndex({ readSettings: () => null });
  const bindings = new ActiveConversationRegistry({
    authority,
    sessionIndex: index,
    isMainWebContents: (id) => id === 1,
  });
  bindings.selectConversation(1, selected.value.conversationId);
  const parentBinding = bindings.bindSource(1, { requestId: 'bind' });
  if (!parentBinding.accepted) throw new Error(parentBinding.error);
  const selection = bindings.registerModelSelection(
    1,
    {
      parentBindingId: parentBinding.parentBindingId,
      selection: { providerId: 'provider', modelId: 'model' },
    },
    true
  );
  if (!selection.accepted) throw new Error(selection.error);
  const config: ResolvedAgentTypeSpawnConfig = {
    typeKey: 'agent:enso',
    displayName: 'Enso',
    description: 'Built in',
    spawnSpecId: crypto.randomUUID(),
    systemPrompt: 'safe',
    model: {
      api: 'openai-completions',
      baseUrl: 'https://example.com',
      apiKey: 'key',
      modelId: 'model',
    },
    tools: 'enso-locked',
    skillPaths: [],
    skillBindingIds: [],
    mcpServers: [],
    mcpBindingIds: [],
    systemPromptHash: 'hash',
    lockedProfileId: 'enso-locked-v1',
  };
  const mainEvents: DispatchMainEvent[] = [];
  const customEntries: AgentSessionCustomEntry[] = [];
  let service!: AgentDispatchService;
  service = new AgentDispatchService({
    sourceRegistry: bindings,
    sessionIndex: index,
    readStoredOauthCredentialKeys: async () => new Set(),
    emitRendererEvent: () => {},
    emitDispatchEvent: (_owner, event) => mainEvents.push(event),
    host: {
      registrySnapshot: () => ({
        revision: 1,
        candidates: [
          {
            kind: 'agent-type',
            id: 'agent:enso',
            typeKey: 'agent:enso',
            displayName: 'Enso',
            description: 'Built in',
            source: 'system',
            locked: true,
            canDisable: false,
            canEdit: false,
          },
        ],
      }),
      resolveModel: () => ({
        ok: true,
        selection: {
          ref: { providerId: 'provider', modelId: 'model' },
          runtimeRef: { providerId: 'runtime', modelId: 'model' },
          config: config.model,
        },
      }),
      resolveAgentType: () => ({
        ok: true,
        config,
        expectedModel: { providerId: 'runtime', modelId: 'model' },
        expectedToolIds: ['enso_capabilities', 'enso_app', 'ask_user'],
      }),
      spawnParent: (identity) => {
        queueMicrotask(() =>
          service.observe({
            type: 'parent-ready',
            identity,
            seq: 1,
            sessionFile: path.join(root, 'parent.jsonl'),
            model: { providerId: 'runtime', modelId: 'model' },
          })
        );
        return { ok: true };
      },
      spawnChild: (identity) => {
        const altered = proofOverride?.(config) ?? {};
        queueMicrotask(() =>
          service.observe({
            type: 'child-ready',
            identity,
            seq: 1,
            sessionFile: path.join(root, 'child.jsonl'),
            proof: {
              spawnSpecId: altered.spawnSpecId ?? config.spawnSpecId,
              typeKey: config.typeKey,
              model: { providerId: 'runtime', modelId: 'model' },
              toolIds: ['enso_capabilities', 'enso_app', 'ask_user'],
              loadedSkillBindingIds: config.skillBindingIds,
              loadedMcpBindingIds: config.mcpBindingIds,
              systemPromptHash: altered.systemPromptHash ?? config.systemPromptHash,
            },
          })
        );
        return { ok: true };
      },
      promptChild: () => ({ ok: true }),
      appendCustomEntry: (_identity, entry) => {
        customEntries.push(entry);
        return { ok: true };
      },
      dismissChild: () => ({ ok: true }),
    },
  });
  return {
    service,
    selectionBindingId: selection.binding.selectionBindingId,
    mainEvents,
    customEntries,
  };
}

describe('AgentDispatchService delta coordination', () => {
  it('settles receipt + turn exactly once with strictly increasing Main seq', async () => {
    const { service, selectionBindingId, mainEvents, customEntries } = await setup();
    const result = await service.dispatch(
      {
        requestId: 'turn-1',
        selectionBindingId,
        typeKey: 'agent:enso',
        task: { text: 'do it', images: [], fileMentions: [] },
      },
      1
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const child = result.child;
    service.observeReceipt({
      type: 'receipt-started',
      child,
      turnId: 'turn-1',
      requestId: 'turn-1',
      receiptId: 'r1',
      receiptSeq: 1,
      executionState: 'executing',
    });
    service.observe({ type: 'turn-completed', identity: child, seq: 2, turnId: 'turn-1' });
    expect(mainEvents.at(-1)?.phase).not.toBe('terminal');
    const receipt: CapabilityReceipt = {
      receiptId: 'r1',
      operationId: 'op',
      child,
      turnId: 'turn-1',
      requestId: 'turn-1',
      capabilityId: 'appearance.status-line-segments',
      risk: 'reversible',
      subject: { kind: 'setting', id: 'statusLineSegments', label: 'Status line segments' },
      outcome: 'succeeded',
      summary: 'saved',
      occurredAt: 1,
      sequence: 1,
    };
    service.observeReceipt({
      type: 'receipt-settled',
      child,
      turnId: 'turn-1',
      requestId: 'turn-1',
      receiptId: 'r1',
      receiptSeq: 1,
      executionState: 'settled',
      receipt,
    });
    service.observeReceipt({
      type: 'receipt-settled',
      child,
      turnId: 'turn-1',
      requestId: 'turn-1',
      receiptId: 'r1',
      receiptSeq: 1,
      executionState: 'settled',
      receipt,
    });
    expect(mainEvents.filter((event) => event.phase === 'terminal')).toHaveLength(1);
    expect(mainEvents.map((event) => event.mainSeq)).toEqual(
      mainEvents.map((_event, index) => index + 1)
    );
    expect(customEntries.filter((entry) => entry.kind === 'agent-completed')).toHaveLength(1);
  });

  it('rejects ordinary/locked child when exact spawn proof drifts', async () => {
    const { service, selectionBindingId } = await setup(() => ({ systemPromptHash: 'drifted' }));
    const result = await service.dispatch(
      {
        requestId: 'turn-2',
        selectionBindingId,
        typeKey: 'agent:enso',
        task: { text: 'do it', images: [], fileMentions: [] },
      },
      1
    );
    expect(result).toMatchObject({ accepted: false, code: 'dispatch-failed' });
  });
});
