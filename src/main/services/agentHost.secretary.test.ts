import { tmpdir } from 'node:os';
import type { AgentCommand } from '@shared/types/agent';
import { expect, it, vi } from 'vitest';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const fork = vi.hoisted(() => ({
  posted: [] as unknown[],
  children: [] as Array<{ emit(event: string, ...args: unknown[]): void }>,
}));
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false },
  utilityProcess: {
    fork: () => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const child = {
        postMessage: (message: unknown) => fork.posted.push(message),
        once: (event: string, handler: (...args: unknown[]) => void) =>
          handlers.set(event, handler),
        on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
        kill: () => {},
        emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
      };
      fork.children.push(child);
      return child;
    },
  },
}));

const state = {
  providers: [
    {
      id: 'p',
      name: 'P',
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      apiKey: 'fixture',
      enabled: true,
      models: [{ id: 'm' }],
    },
  ],
};
vi.mock('../ipc/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/settings')>()),
  readSettings: () => ({ 'enso-settings': { version: 1, state } }),
}));

import { spawnSession, startAgentWorker } from './agentHost';

const identity = { sessionId: 'secretary', generation: '11111111-1111-4111-8111-111111111111' };

it('秘书 spawn-parent 不带插件、技能、MCP、hooks、命令与子代理类型，并带强制禁用列表', () => {
  startAgentWorker();
  fork.children[0].emit('spawn');
  fork.posted.length = 0;
  const result = spawnSession(
    identity,
    { sessionId: 'secretary', providerId: 'p', modelId: 'm', cwd: '/workspace' },
    new Set(),
    undefined,
    undefined,
    { secretary: { systemPrompt: 'SECRETARY PROMPT' } }
  );
  expect(result.ok).toBe(true);
  const command = fork.posted.find(
    (entry) => (entry as AgentCommand).type === 'spawn-parent'
  ) as Extract<AgentCommand, { type: 'spawn-parent' }>;
  expect(command.secretaryMode).toBe(true);
  expect(command.systemPrompt).toBe('SECRETARY PROMPT');
  expect(command.instruction).toBeUndefined();
  expect(command.pluginTools).toBeUndefined();
  expect(command.pluginEvents).toBeUndefined();
  expect(command.pluginCommands).toBeUndefined();
  expect(command.pluginHooks).toBeUndefined();
  expect(command.skillPaths).toBeUndefined();
  expect(command.mcpServers).toBeUndefined();
  expect(command.agentTypes).toBeUndefined();
  expect(command.subagentModels).toBeUndefined();
  expect(command.workflowPresetFiles).toBeUndefined();
  expect(command.loadLocalSkills).toBe(false);
  expect(command.disabledTools).toEqual(
    expect.arrayContaining([
      'isolated_sandbox',
      'workspace_write',
      'goal',
      'todo',
      'subagent',
      'workflow',
      'browser',
      'computer',
      'plan',
      'background_tasks',
      'turn_discard',
      'image_generation',
    ])
  );
  expect(command.disabledTools).not.toContain('web');
  expect(command.disabledTools).not.toContain('ask_user');
});
