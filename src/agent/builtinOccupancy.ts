import type { OccupancyTool } from '@shared/occupancy';
import { BUILTIN_AGENT_TYPES } from '@shared/types';
import type { AgentTypeSpawnConfig, SubagentModelOption } from '@shared/types/agent';
import { AskManager, createAskTool } from './ask';
import { createTaskTools } from './backgroundTasks';
import { createCoworkerTool } from './coworker';
import { createSubagentTool } from './subagent';
import { createTodoTool } from './todo';
import { BrowserInvoker, createBrowserTools } from './tools/browser';

function fields(tool: { name: string; description?: string; parameters?: unknown }): OccupancyTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

const noopIdentity = {
  sessionId: 'occupancy',
  generation: 'occupancy',
};

export function snapshotBuiltinOccupancyTools(input?: {
  agentTypes?: AgentTypeSpawnConfig[];
  models?: SubagentModelOption[];
}): Record<string, OccupancyTool[]> {
  const agentTypes =
    input?.agentTypes ??
    BUILTIN_AGENT_TYPES.map((type) => ({
      name: type.name,
      description: type.description,
      systemPrompt: type.systemPrompt,
      tools: type.tools,
    }));
  const models = input?.models ?? [];
  const ask = new AskManager(
    () => {},
    () => {}
  );
  const browser = new BrowserInvoker(noopIdentity, () => {});
  return {
    subagent: [
      fields(
        createSubagentTool({
          createSubSession: async () => {
            throw new Error('occupancy snapshot');
          },
          modelId: '',
          agentTypes,
          models,
          emitUpdate: () => {},
          runGate: async () => '',
          notify: () => {},
        })
      ),
    ],
    coworker: [
      fields(
        createCoworkerTool({
          agentTypes,
          models,
          spawn: async () => {
            throw new Error('occupancy snapshot');
          },
          send: async () => '',
          list: () => [],
          dismiss: async () => {},
          wait: async () => '',
          report: () => '',
        })
      ),
    ],
    todo: [fields(createTodoTool())],
    ask_user: [fields(createAskTool(ask))],
    browser: createBrowserTools(browser).map(fields),
    background_tasks: createTaskTools({
      read: async () => undefined,
      stop: () => false,
      knownIds: () => [],
    } as never).map(fields),
  };
}
