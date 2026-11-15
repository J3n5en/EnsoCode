import { tmpdir } from 'node:os';
import type { AgentCommand } from '@shared/types/agent';
import { expect, it, vi } from 'vitest';

vi.mock('../../agent/index?modulePath', () => ({ default: '/tmp/agent.js' }));
const fork = vi.hoisted(() => ({
  posted: [] as unknown[],
  children: [] as Array<{ emit(event: string, ...args: unknown[]): void }>,
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir(),
    isPackaged: false,
    getVersion: () => '0.0.0',
    on: () => {},
  },
  notification: { isSupported: () => false },
  clipboard: { writeText: () => {} },
  shell: { openExternal: () => Promise.resolve() },
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

const state: Record<string, unknown> = {
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

/** 装了插件、勾选了一个：插件贡献的 MCP 与 workflow 都不能进秘书会话 */
vi.mock('./extensionPlugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./extensionPlugins')>()),
  getExtensionPlugins: () => ({
    presetForSpawn: () => undefined,
    skillPathsForSpawn: (_preset?: string, ids?: readonly string[]) =>
      ids ? ['/plugins/skill'] : [],
    workflowPathsForSpawn: () => ['/plugins/workflow.js'],
    mcpServersForSpawn: () => [
      {
        name: 'plugin-enso-tgclient-srv',
        description: '插件',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {},
      },
    ],
    toolsForSpawn: () => [],
    eventPlanForSpawn: () => null,
    agentTypesForSpawn: () => [],
  }),
}));

import { spawnSession, startAgentWorker } from './agentHost';

it('秘书会话不挂插件的 MCP 与 workflow，即使插件已被勾选', () => {
  startAgentWorker();
  fork.children[0].emit('spawn');
  fork.posted.length = 0;
  const result = spawnSession(
    { sessionId: 'secretary', generation: '11111111-1111-4111-8111-111111111111' },
    { sessionId: 'secretary', providerId: 'p', modelId: 'm', cwd: '/workspace' },
    new Set(),
    undefined,
    undefined,
    {
      secretary: {
        systemPrompt: 'SECRETARY PROMPT',
        pluginIds: ['enso.tgclient'],
        skillDirs: ['/userdata/secretary/workspace/skills'],
      },
    }
  );
  expect(result.ok).toBe(true);
  const command = fork.posted.find(
    (entry) => (entry as AgentCommand).type === 'spawn-parent'
  ) as Extract<AgentCommand, { type: 'spawn-parent' }>;
  expect(command.mcpServers).toBeUndefined();
  expect(command.workflowPresetFiles).toBeUndefined();
  // 勾选的插件仍按 id 下发 skill
  expect(command.skillPaths).toEqual(['/plugins/skill', '/userdata/secretary/workspace/skills']);
});
