import {
  createEditToolDefinition,
  type EditToolOptions,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

export const EDIT_REPLACE_GUIDELINE =
  'For a single replacement, send path + oldText + newText and omit edits. ' +
  'For multiple replacements, send path + edits as an actual array of objects, each with oldText and newText strings; omit top-level oldText/newText. ' +
  'Use the literal keys "oldText" and "newText"; put code in their string values, not in object keys. ' +
  'Do not encode edits as a JSON string or mix the single and batch forms. ' +
  'If a batch call fails argument validation, rebuild the arguments using the single-replacement form; do not resend or complete the broken edits string.';

export const EDIT_REPLACE_EXAMPLES =
  '\nSingle replacement example: ' +
  JSON.stringify({
    path: 'src/a.ts',
    oldText: 'const label = "old";\n',
    newText: 'const label = "new";\n',
  }) +
  '\nBatch replacement example: ' +
  JSON.stringify({
    path: 'src/a.ts',
    edits: [
      { oldText: 'const a = 1;', newText: 'const a = 2;' },
      { oldText: 'const b = 3;', newText: 'const b = 4;' },
    ],
  });

export const EDIT_REPLACE_PROPERTIES = {
  path: { type: 'string', description: 'Path to the file to edit (relative or absolute)' },
  edits: {
    type: 'array',
    description:
      'Batch replacements: an actual array of objects, not a JSON string. Use the literal keys "oldText" and "newText" in every item. Each oldText must be exact, unique and non-overlapping in the original file. Keep newText inside its item; omit top-level oldText/newText.',
    items: {
      type: 'object',
      properties: {
        oldText: {
          type: 'string',
          description: 'Exact, unique text to replace in the original file',
        },
        newText: {
          type: 'string',
          description: 'Replacement text; empty string deletes the old text',
        },
      },
      required: ['oldText', 'newText'],
    },
  },
  oldText: {
    type: 'string',
    description: 'Single replacement: exact old text; pair with newText and omit edits',
  },
  newText: {
    type: 'string',
    description: 'Single replacement: new text; pair with oldText and omit edits',
  },
};

function isSingleEdit(value: unknown): value is { oldText: string; newText: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.oldText === 'string' && typeof edit.newText === 'string';
}

function looksLikeJsonContainer(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('[') || trimmed.startsWith('{') || trimmed.startsWith('"');
}

/** 数字键对象（{"0": edit}）当数组；JSON 工具调用里常见 */
function arrayLikeValues(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0 || keys.some((key) => !/^\d+$/.test(key))) return undefined;
  return keys
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => (value as Record<string, unknown>)[key]);
}

// 只转义 JSON 字符串内裸控制字符；已有转义与结构原样保留，最终仍须完整 JSON.parse。
function escapeJsonControlCharacters(value: string): string {
  let inString = false;
  let escaped = false;
  let result = '';
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (character === '"') {
      inString = !inString;
    } else if (inString && character === '\\') {
      escaped = true;
    } else if (inString && character.charCodeAt(0) < 0x20) {
      result += `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    result += character;
  }
  return result;
}

/** 递归 unwrap 看起来像 JSON 的字符串；截断或非法则原样返回 */
function unwrapJson(value: unknown, depth = 0): unknown {
  if (typeof value !== 'string' || depth > 3) return value;
  if (!looksLikeJsonContainer(value)) return value;
  try {
    return unwrapJson(JSON.parse(value), depth + 1);
  } catch {
    try {
      return unwrapJson(JSON.parse(escapeJsonControlCharacters(value)), depth + 1);
    } catch {
      return value;
    }
  }
}

function flattenEditItems(items: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of items) {
    const unwrapped = unwrapJson(item);
    if (isSingleEdit(unwrapped)) {
      out.push(unwrapped);
      continue;
    }
    const nested = Array.isArray(unwrapped) ? unwrapped : arrayLikeValues(unwrapped);
    if (nested) {
      out.push(...flattenEditItems(nested));
      continue;
    }
    out.push(unwrapped);
  }
  return out;
}

function rejectUnparsedEditsJson(edits: unknown): void {
  const leftover =
    typeof edits === 'string'
      ? [edits]
      : Array.isArray(edits)
        ? edits.filter((item): item is string => typeof item === 'string')
        : [];
  if (leftover.some(looksLikeJsonContainer)) {
    throw new Error(
      'Invalid edits: the JSON string is incomplete or malformed. No files were changed by this call. ' +
        'Resend complete arguments. ' +
        EDIT_REPLACE_GUIDELINE
    );
  }
}

function normalizeEditsValue(edits: unknown): unknown {
  const unwrapped = unwrapJson(edits);
  if (isSingleEdit(unwrapped)) return [unwrapped];
  const asArray = Array.isArray(unwrapped) ? unwrapped : arrayLikeValues(unwrapped);
  return asArray ? flattenEditItems(asArray) : unwrapped;
}

/** schema 校验前把模型常见的畸形 edits 还原成对象数组；截断 JSON 字符串抛明确错误 */
export function normalizeEditArguments(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const args = { ...(input as Record<string, unknown>) };
  if (!('edits' in args)) return args;
  const next = normalizeEditsValue(args.edits);
  rejectUnparsedEditsJson(next);
  return next === args.edits ? args : { ...args, edits: next };
}

/** 保留 stock 执行语义，公开它已支持的单次替换参数。 */
export function createNormalizedEditTool(cwd: string, options?: EditToolOptions): ToolDefinition {
  const base = createEditToolDefinition(cwd, options) as unknown as ToolDefinition;
  const prepareBase = base.prepareArguments;
  return {
    ...base,
    description: `${base.description} ${EDIT_REPLACE_GUIDELINE}${EDIT_REPLACE_EXAMPLES}`,
    promptGuidelines: [...(base.promptGuidelines ?? []), EDIT_REPLACE_GUIDELINE],
    parameters: {
      type: 'object',
      properties: EDIT_REPLACE_PROPERTIES,
      required: ['path'],
    } as unknown as ToolDefinition['parameters'],
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
