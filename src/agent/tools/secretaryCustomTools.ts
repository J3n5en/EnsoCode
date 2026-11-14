import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { TOOL_RUN_TIMEOUT_MS } from '@shared/secretary/customTools';
import type { SecretaryInternalOp } from '@shared/secretary/tools';
import type { SecretaryToolDescriptor } from '@shared/types/secretary';
import type { MemoryInvoker } from './memory';

/** 描述符名字是 my_<slug>，执行时换回目录名 */
function slugOf(toolName: string): string {
  return toolName.slice(3).replace(/_/gu, '-');
}

/**
 * 秘书自造工具：名字、描述与参数结构全部由 Main 在 spawn 时下发，
 * 这里只负责把调用转给 Main，代码与执行都在 Main。
 */
export function createSecretaryCustomTools(
  invoker: MemoryInvoker<SecretaryInternalOp>,
  descriptors: readonly SecretaryToolDescriptor[]
): ToolDefinition[] {
  return descriptors.map((descriptor) => {
    const name = descriptor.name;
    return {
      name,
      label: name,
      description: descriptor.description,
      parameters: descriptor.parameters as ToolDefinition['parameters'],
      ...(descriptor.readOnly ? { annotations: { readOnlyHint: true } } : {}),
      async execute(_toolCallId, params, signal) {
        try {
          const result = await invoker.invoke(
            'tool_run',
            { name: slugOf(name), arguments: params, readOnly: descriptor.readOnly },
            signal,
            TOOL_RUN_TIMEOUT_MS
          );
          const output = (result as { output?: unknown } | null)?.output;
          return {
            content: [
              { type: 'text', text: typeof output === 'string' ? output : JSON.stringify(result) },
            ],
            details: undefined,
          };
        } catch (error) {
          return {
            content: [
              { type: 'text', text: error instanceof Error ? error.message : String(error) },
            ],
            details: undefined,
            isError: true,
          };
        }
      },
    } as ToolDefinition;
  });
}
