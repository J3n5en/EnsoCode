import {
  createEditToolDefinition,
  type EditToolOptions,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

/**
 * 宽容版 edit 工具：部分 OpenAI 兼容模型（grok 等）会把 edits 数组双重编码成
 * JSON 字符串，pi 原版 schema 校验直接失败（"edits.0: must be object"）。
 * 这里放宽 schema 允许 string，执行前 JSON.parse 归一化后走原实现。
 */
export function createLenientEditTool(cwd: string, options?: EditToolOptions): ToolDefinition {
  const base = createEditToolDefinition(cwd, options) as unknown as ToolDefinition;
  const baseParams = base.parameters as unknown as {
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  const editsSchema = baseParams.properties?.edits;
  const parameters = {
    ...baseParams,
    properties: {
      ...baseParams.properties,
      edits: { anyOf: [editsSchema, { type: 'string' }] },
    },
  } as ToolDefinition['parameters'];

  return {
    ...base,
    parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const record = params as { edits?: unknown };
      if (typeof record.edits === 'string') {
        try {
          record.edits = JSON.parse(record.edits);
        } catch {
          // 解析失败原样传递，让底层报出可读错误
        }
      }
      return base.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
