import { AGY_HOST_MCP_BUDGET_BYTES, agyHostTools, hostMcpToolBytes } from '@shared/agy/hostTools';
import { describe, expect, it } from 'vitest';
import { AskManager, createAskTool } from '../ask';
import { createMemoryTools, MemoryInvoker } from '../tools/memory';
import { createSecretaryTools } from '../tools/secretary';
import { createSilenceTurnTool } from '../tools/silenceTurn';

/** 秘书会话在 agy 上的 Enso 工具表，用真实 schema，量出来的就是 tools/list 发出去的 */
function secretaryTools() {
  const identity = { sessionId: 's', generation: 'g' };
  return [
    createAskTool(
      new AskManager(
        () => {},
        () => {}
      )
    ),
    ...createSecretaryTools({ invoke: async () => ({}) } as never),
    createSilenceTurnTool(),
    ...createMemoryTools(new MemoryInvoker(identity, () => {}), { secretary: true }),
  ].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

describe('secretary tools on agy', () => {
  it('lists its frequent ops directly without pushing the other core tools behind search', () => {
    const { eager } = agyHostTools(secretaryTools());
    expect(eager.map((tool) => tool.name)).toEqual([
      'ask_user',
      'silence_turn',
      'cleanup_apply',
      'cleanup_list',
      'session_list',
      'session_archive',
      'session_read',
      'result_mark_done',
      'memory_search',
      'memory_capture',
      'memory_crystallize',
      'memory_delete',
      'image_view',
      'enso_tool_search',
      'enso_tool_call',
    ]);
    // agy 的工具预算和用户自己配的 MCP 服务器共用：留出四分之一以上
    const used = eager.reduce((sum, tool) => sum + hostMcpToolBytes(tool), 0);
    expect(used).toBeLessThan(AGY_HOST_MCP_BUDGET_BYTES * 0.75);
  });
});
