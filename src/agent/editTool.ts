import {
  createEditToolDefinition,
  type EditToolOptions,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

function isSingleEdit(value: unknown): value is { oldText: string; newText: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.oldText === 'string' && typeof edit.newText === 'string';
}

/** 递归 unwrap 看起来像 JSON 的字符串；截断或非法则原样返回 */
function unwrapJson(value: unknown, depth = 0): unknown {
  if (typeof value !== 'string' || depth > 3) return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('[') || trimmed.startsWith('{') || trimmed.startsWith('"'))) {
    return value;
  }
  try {
    return unwrapJson(JSON.parse(value), depth + 1);
  } catch {
    return value;
  }
}

function normalizeEditsValue(edits: unknown): unknown {
  const unwrapped = unwrapJson(edits);
  if (isSingleEdit(unwrapped)) return [unwrapped];
  if (!Array.isArray(unwrapped)) return unwrapped;
  return unwrapped.map((item) => unwrapJson(item));
}

/** schema 校验前把模型常见的畸形 edits 还原成对象数组；截断字符串不改写 */
export function normalizeEditArguments(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const args = { ...(input as Record<string, unknown>) };
  if (!('edits' in args)) return args;
  const next = normalizeEditsValue(args.edits);
  return next === args.edits ? args : { ...args, edits: next };
}

/** 叠在 stock pi edit 上，不放宽 schema */
export function createNormalizedEditTool(cwd: string, options?: EditToolOptions): ToolDefinition {
  const base = createEditToolDefinition(cwd, options) as unknown as ToolDefinition;
  const prepareBase = base.prepareArguments;
  return {
    ...base,
    prepareArguments: ((args: unknown) => {
      const normalized = normalizeEditArguments(args);
      return prepareBase ? prepareBase(normalized) : normalized;
    }) as ToolDefinition['prepareArguments'],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const prepared = prepareBase
        ? prepareBase(normalizeEditArguments(params))
        : normalizeEditArguments(params);
      return base.execute(toolCallId, prepared as typeof params, signal, onUpdate, ctx);
    },
  };
}
