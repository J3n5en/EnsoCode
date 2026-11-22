import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
type Scalar = string | number | boolean | null;

type SchemaFields = {
  description?: string;
  title?: string;
  enum?: readonly Scalar[];
  const?: Scalar;
  default?: unknown;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  properties?: Readonly<Record<string, PortableSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: PortableSchema;
};

/** Claude 与 Gemini 都接受的 JSON Schema 子集；写不进来的约束放 description，并在 prepareArguments / execute 里校验 */
export type PortableSchema = SchemaFields &
  ({ type: SchemaType; anyOf?: never } | { anyOf: readonly PortableSchema[]; type?: never });

export function toolParameters(
  schema: PortableSchema & { type: 'object' }
): ToolDefinition['parameters'] {
  return schema as unknown as ToolDefinition['parameters'];
}

const PORTABLE_KEYS = new Set([
  'type',
  'anyOf',
  'description',
  'title',
  'enum',
  'const',
  'default',
  'nullable',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
  'properties',
  'required',
  'additionalProperties',
  'items',
]);
const GEMINI_KEYS = new Set(
  [...PORTABLE_KEYS].filter((key) => key !== 'additionalProperties' && key !== 'const')
);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

type Rules = { keys: Set<string>; typed: boolean; fix: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function walk(schema: unknown, path: string, rules: Rules, issues: string[]): void {
  if (!isRecord(schema)) {
    issues.push(`${path} 不是 schema 对象`);
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!rules.keys.has(key)) issues.push(`${path}.${key} ${rules.fix}`);
  }
  const { type, properties, required, items, anyOf } = schema;
  if (Array.isArray(type)) {
    issues.push(
      `${path}.type 是数组 ${JSON.stringify(type)}，Gemini 回 invalid_argument：改成单个 type，可空写 nullable: true，联合写 anyOf`
    );
  } else if (type === undefined ? rules.typed && !Array.isArray(anyOf) : !TYPES.has(String(type))) {
    issues.push(`${path} 缺少合法 type：每个节点写单个 type，联合写 anyOf 且每支各带 type`);
  }
  if (isRecord(properties)) {
    for (const [name, prop] of Object.entries(properties)) {
      walk(prop, `${path}.properties.${name}`, rules, issues);
    }
    for (const name of Array.isArray(required) ? required : []) {
      if (!Object.hasOwn(properties, String(name))) {
        issues.push(
          `${path}.required 点名了未声明的 ${name}：在 properties 里声明它或从 required 删掉`
        );
      }
    }
  }
  if (items !== undefined) walk(items, `${path}.items`, rules, issues);
  for (const [i, branch] of (Array.isArray(anyOf) ? anyOf : []).entries()) {
    walk(branch, `${path}.anyOf[${i}]`, rules, issues);
  }
}

/** 工具自己声明的参数 schema 必须落在 PortableSchema 子集里 */
export function portableSchemaIssues(schema: unknown, toolName: string): string[] {
  const issues: string[] = [];
  if (!isRecord(schema) || schema.type !== 'object') {
    issues.push('$ 根节点必须是 type: "object"：Claude 拒绝根上的 anyOf/oneOf/allOf');
  }
  walk(
    schema,
    '$',
    {
      keys: PORTABLE_KEYS,
      typed: true,
      fix: '是 Claude 或 Gemini 会整单拒绝的关键字：删掉它，把约束写进 description 并在 prepareArguments / execute 里校验；用 toolParameters() 声明 schema，不要 as unknown as',
    },
    issues
  );
  return issues.map((issue) => `${toolName}: ${issue}`);
}

/** 发往 Gemini 的线上 schema（清洗之后）不能再带 Google 不认的写法 */
export function geminiSchemaIssues(schema: unknown, toolName: string): string[] {
  const issues: string[] = [];
  walk(
    schema,
    '$',
    {
      keys: GEMINI_KEYS,
      typed: false,
      fix: '没被清洗，Gemini 会整单 400 / invalid_argument：发往 Gemini 的 schema 必须经 toolSchemaForModel()（expandSchemaRefs + normalizeToolSchema），新关键字加进 DROPPED_SCHEMA_KEYS',
    },
    issues
  );
  return issues.map((issue) => `${toolName}: ${issue}`);
}
