import type {
  SecretaryToolDescriptor,
  SecretaryToolDraft,
  SecretaryToolRuntime,
} from '../types/secretary';
import { isSecretarySlug } from './skills';

export const TOOL_DESCRIPTION_MAX = 1024;
export const TOOL_PARAMETERS_MAX = 8 * 1024;
export const TOOL_CODE_MAX = 50_000;
export const TOOL_TIMEOUT_DEFAULT = 60;
export const TOOL_TIMEOUT_MAX = 300;
export const TOOL_DESCRIPTOR_MAX = 50;
export const TOOL_OUTPUT_MAX = 20_000;
export const TOOL_STDERR_MAX = 2_000;
/** worker 等 Main 回结果的时长：比工具自身的最长超时再宽一点 */
export const TOOL_RUN_TIMEOUT_MS = (TOOL_TIMEOUT_MAX + 5) * 1000;

const TOOL_ID_RE = /^my_[a-z0-9]+(_[a-z0-9]+)*$/u;
const TOOL_ID_MAX = 60;
const DESCRIPTOR_KEYS = ['name', 'description', 'parameters', 'readOnly'] as const;

export type ToolDraftResult =
  | { ok: true; draft: SecretaryToolDraft }
  | { ok: false; error: string };

/** 脚本文件名由 runtime 决定：不接受任意 entry 路径 */
export function secretaryToolScriptFile(runtime: SecretaryToolRuntime): string {
  return runtime === 'python' ? 'main.py' : 'main.mjs';
}

/** worker 里的工具名：内置工具与插件工具都不会以 my_ 开头，白名单按确切名字放行 */
export function secretaryToolId(name: string): string {
  return `my_${name.replace(/-/gu, '_')}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 只查会让每轮请求都失败的结构：properties 是对象、每个属性值是对象、required 指向已声明的属性 */
function validToolParameters(parameters: Record<string, unknown>): boolean {
  const fields = parameters.properties === undefined ? {} : record(parameters.properties);
  if (!fields) return false;
  if (!Object.values(fields).every((value) => record(value) !== null)) return false;
  const required = parameters.required;
  if (required === undefined) return true;
  return (
    Array.isArray(required) &&
    required.every((name) => typeof name === 'string' && Object.hasOwn(fields, name))
  );
}

/** 提案参数、卡片草案与磁盘内容共用同一套收窄 */
export function parseSecretaryToolDraft(value: unknown): ToolDraftResult {
  const fields = record(value);
  if (!fields) return { ok: false, error: 'invalid tool' };
  const name = typeof fields.name === 'string' ? fields.name.trim() : '';
  if (!isSecretarySlug(name)) return { ok: false, error: 'invalid tool name' };
  const description = typeof fields.description === 'string' ? fields.description.trim() : '';
  if (!description || description.length > TOOL_DESCRIPTION_MAX || /[\r\n]/u.test(description)) {
    return { ok: false, error: 'invalid tool description' };
  }
  const runtime = fields.runtime;
  if (runtime !== 'python' && runtime !== 'node') {
    return { ok: false, error: 'invalid tool runtime' };
  }
  const parameters = record(fields.parameters);
  if (parameters?.type !== 'object' || !validToolParameters(parameters)) {
    return { ok: false, error: 'invalid tool parameters' };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(parameters);
  } catch {
    return { ok: false, error: 'invalid tool parameters' };
  }
  if (serialized.length > TOOL_PARAMETERS_MAX) {
    return { ok: false, error: 'invalid tool parameters' };
  }
  const readOnly = fields.readOnly === undefined ? false : fields.readOnly;
  if (typeof readOnly !== 'boolean') return { ok: false, error: 'invalid tool readOnly' };
  const timeout = fields.timeoutSec;
  if (
    timeout !== undefined &&
    timeout !== null &&
    (typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > TOOL_TIMEOUT_MAX)
  ) {
    return { ok: false, error: 'invalid tool timeout' };
  }
  const code = typeof fields.code === 'string' ? fields.code.trim() : '';
  if (!code || code.length > TOOL_CODE_MAX) return { ok: false, error: 'invalid tool code' };
  return {
    ok: true,
    draft: {
      name,
      description,
      runtime,
      parameters,
      readOnly,
      ...(typeof timeout === 'number' ? { timeoutSec: timeout } : {}),
      code,
    },
  };
}

/** tool.json 只存元数据，代码单独落盘，卡片与执行各自读自己需要的部分 */
export function renderSecretaryToolFile(draft: SecretaryToolDraft): string {
  const { code: _code, ...meta } = draft;
  return `${JSON.stringify(meta, null, 2)}\n`;
}

/** 只认本应用写出的格式；读不懂就当作没有，免得把坏文件当成工具挂上去 */
export function parseSecretaryToolFile(raw: string, code: string): SecretaryToolDraft | null {
  let fields: unknown;
  try {
    fields = JSON.parse(raw.replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
  const parsed = parseSecretaryToolDraft({ ...(record(fields) ?? {}), code });
  return parsed.ok ? parsed.draft : null;
}

export function secretaryToolDescriptor(draft: SecretaryToolDraft): SecretaryToolDescriptor {
  return {
    name: secretaryToolId(draft.name),
    description: draft.description,
    parameters: draft.parameters,
    readOnly: draft.readOnly,
  };
}

/** Main 下发的描述符是 worker 装配工具的唯一来源，形状不对就整批不认 */
export function parseSecretaryToolDescriptors(value: unknown): SecretaryToolDescriptor[] | null {
  if (!Array.isArray(value) || value.length > TOOL_DESCRIPTOR_MAX) return null;
  const out: SecretaryToolDescriptor[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const fields = record(entry);
    if (!fields || Object.keys(fields).length !== DESCRIPTOR_KEYS.length) return null;
    if (!DESCRIPTOR_KEYS.every((key) => key in fields)) return null;
    const name = fields.name;
    const description = fields.description;
    const parameters = record(fields.parameters);
    const readOnly = fields.readOnly;
    if (
      typeof name !== 'string' ||
      name.length > TOOL_ID_MAX ||
      !TOOL_ID_RE.test(name) ||
      seen.has(name) ||
      typeof description !== 'string' ||
      !description ||
      description.length > TOOL_DESCRIPTION_MAX ||
      !parameters ||
      parameters.type !== 'object' ||
      typeof readOnly !== 'boolean'
    ) {
      return null;
    }
    seen.add(name);
    out.push({ name, description, parameters, readOnly });
  }
  return out;
}
