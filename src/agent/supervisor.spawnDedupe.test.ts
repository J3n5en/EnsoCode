import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentWorkerEvent } from '@shared/types/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));

vi.mock('./cursor/loadProvider', () => ({
  CURSOR_PROVIDER_ID: 'cursor',
  loadCursorProvider: vi.fn(async () => undefined),
}));

vi.mock('./mcp', () => ({
  McpManager: class {
    toolsFor = vi.fn(async () => []);
    resolve = vi.fn();
    refresh = vi.fn();
    closeAll = vi.fn(async () => undefined);
  },
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  class Loader {
    async reload() {}
    getSkills() {
      return { skills: [] };
    }
    getPrompts() {
      return { prompts: [] };
    }
  }
  const manager = () => {
    const branch: unknown[] = [];
    return {
      getBranch: vi.fn(() => branch),
      appendCustomEntry: vi.fn(() => `entry-${branch.length}`),
      buildSessionContext: vi.fn(() => ({ messages: [] })),
    };
  };
  const runtime = {
    models: new Map<string, Record<string, unknown>>(),
    registerProvider(providerId: string, config: { models?: Record<string, unknown>[] }) {
      for (const model of config.models ?? [])
        this.models.set(`${providerId}/${model.id}`, { ...model, provider: providerId });
    },
    getModel(providerId: string, modelId: string) {
      return this.models.get(`${providerId}/${modelId}`);
    },
    getModels() {
      return [...this.models.values()];
    },
    resolveModel: vi
      .fn<ModelRuntime['resolveModel']>()
      .mockRejectedValue(new Error('Unexpected virtual model routing in spawn fixture')),
    getAuth: vi.fn<ModelRuntime['getAuth']>().mockResolvedValue(undefined),
    getProvider(providerId: string) {
      if (![...this.models.keys()].some((key) => key.startsWith(`${providerId}/`)))
        return undefined;
      return { id: providerId, models: [], stream: vi.fn(), streamSimple: vi.fn() };
    },
    registerNativeProvider: vi.fn(),
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    completeSimple: vi.fn(async () => ({ content: [] })),
  };
  return {
    ...original,
    DefaultResourceLoader: Loader,
    ModelRuntime: { create: vi.fn(async () => runtime) },
    SessionManager: { create: vi.fn(manager), open: vi.fn(manager), inMemory: vi.fn(manager) },
    createAgentSession: mocks.createAgentSession,
  };
});

import { SessionSupervisor } from './supervisor';

const identity = {
  sessionId: 'dispatch-1',
  generation: '11111111-1111-4111-8111-111111111111',
};
const model = {
  api: 'openai-completions' as const,
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret',
  modelId: 'model',
  settingsProviderId: 'settings-provider',
};

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('SessionSupervisor 并发 spawn 同一会话', () => {
  beforeEach(() => {
    mocks.createAgentSession.mockReset();
    mocks.createAgentSession.mockImplementation(async () => ({
      session: {
        model,
        resourceLoader: { getSkills: () => ({ skills: [] }), getPrompts: () => ({ prompts: [] }) },
        sessionManager: {
          getBranch: () => [],
          appendCustomEntry: () => 'entry',
          buildSessionContext: () => ({ messages: [] }),
        },
        messages: [],
        sessionFile: '/tmp/spawn-dedupe.jsonl',
        subscribe: vi.fn(() => () => undefined),
        prompt: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        waitForIdle: vi.fn(async () => undefined),
        dispose: vi.fn(),
        setThinkingLevel: vi.fn(),
        getActiveToolNames: () => [],
        setActiveToolsByName: vi.fn(),
        navigateTree: vi.fn(async () => ({ cancelled: false })),
        isStreaming: false,
        isRetrying: false,
        isCompacting: false,
      },
    }));
  });

  it('Main 与 renderer 同时 spawn 同一会话：只建一代，两边都收到 parent-ready', async () => {
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      emit: (event) => events.push(event),
      agentDir: path.join(tmpdir(), 'enso-spawn-dedupe-agent'),
      sessionDir: path.join(tmpdir(), 'enso-spawn-dedupe-sessions'),
    });
    try {
      const command = {
        type: 'spawn-parent' as const,
        identity,
        cwd: '/workspace',
        model,
      };
      supervisor.handleCommand(command);
      supervisor.handleCommand(command);
      await waitFor(
        () => events.filter((event) => event.type === 'parent-ready').length === 2,
        'two parent-ready'
      );
      expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    } finally {
      await supervisor.shutdown();
    }
  });
});
