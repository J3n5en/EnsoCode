import { parseRtkToolStats } from '@shared/rtk';
import type { ProjectedMessage, ProjectedPart, TodoItem } from '@shared/types/agent';
import {
  PROJECTED_APPLY_PATCH_PATH_COUNT_LIMIT,
  PROJECTED_APPLY_PATCH_PATH_TEXT_LIMIT,
  PROJECTED_FILE_CHANGE_LIMIT,
  PROJECTED_FILE_TEXT_LIMIT,
  type ProjectedApplyPatchOutcome,
  type ProjectedFileChange,
} from '@shared/types/fileChanges';

/** 渲染层单段文本上限。worker 里模型上下文仍是全文，只截投影。 */
export const PROJECTED_TEXT_LIMIT = PROJECTED_FILE_TEXT_LIMIT;
export { PROJECTED_FILE_CHANGE_LIMIT } from '@shared/types/fileChanges';

const TODO_STATUSES = ['pending', 'in_progress', 'completed'];

/** Hashline edit toolResult.details 的前后全文（白名单校验，脏数据丢弃） */
function projectEditDiff(value: unknown): { oldText: string; newText: string } | null {
  if (!isRecord(value) || typeof value.oldText !== 'string' || typeof value.diff !== 'string') {
    return null;
  }
  return { oldText: capText(value.oldText), newText: capText(value.diff) };
}

/** apply_patch details 的实际落盘操作；截断文本明确标记，禁止下游当完整快照。 */
function projectFileChanges(value: unknown): ProjectedFileChange[] | null {
  if (
    !isRecord(value) ||
    value.kind !== 'apply_patch' ||
    (value.status !== 'success' && value.status !== 'partial' && value.status !== 'failed') ||
    !Array.isArray(value.fileChanges)
  ) {
    return null;
  }
  return value.fileChanges.slice(0, PROJECTED_FILE_CHANGE_LIMIT).flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.path !== 'string' ||
      item.path.length === 0 ||
      item.path.length > PROJECTED_APPLY_PATCH_PATH_TEXT_LIMIT ||
      typeof item.oldText !== 'string' ||
      typeof item.newText !== 'string' ||
      (item.type !== 'add' && item.type !== 'update' && item.type !== 'delete')
    ) {
      return [];
    }
    const truncated =
      item.oldText.length > PROJECTED_TEXT_LIMIT || item.newText.length > PROJECTED_TEXT_LIMIT;
    return [
      {
        path: item.path,
        oldText: capText(item.oldText),
        newText: capText(item.newText),
        type: item.type,
        ...(truncated ? { truncated: true as const } : {}),
      },
    ];
  });
}

function projectApplyPatchOutcome(
  value: unknown,
  fileChanges: ProjectedFileChange[]
): ProjectedApplyPatchOutcome | null {
  if (
    !isRecord(value) ||
    value.kind !== 'apply_patch' ||
    (value.status !== 'success' && value.status !== 'partial' && value.status !== 'failed')
  ) {
    return null;
  }
  const lists = [value.applied, value.failed, value.unattempted, value.uncertain];
  if (
    lists.some(
      (list) =>
        !Array.isArray(list) ||
        list.some(
          (path) =>
            typeof path !== 'string' ||
            path.length === 0 ||
            path.length > PROJECTED_APPLY_PATCH_PATH_TEXT_LIMIT
        )
    )
  ) {
    return null;
  }
  const [applied, failed, unattempted, uncertain] = lists as string[][];
  const allPaths = [...applied, ...failed, ...unattempted, ...uncertain];
  if (
    allPaths.length > PROJECTED_APPLY_PATCH_PATH_COUNT_LIMIT ||
    new Set(allPaths).size !== allPaths.length ||
    applied.length !== fileChanges.length ||
    applied.some((path, index) => path !== fileChanges[index]?.path)
  ) {
    return null;
  }
  const error = typeof value.error === 'string' && value.error.length > 0 ? value.error : null;
  const input = typeof value.input === 'string' && value.input.length > 0 ? value.input : null;
  if (
    (value.status === 'success' &&
      (error !== null ||
        input !== null ||
        failed.length > 0 ||
        unattempted.length > 0 ||
        uncertain.length > 0)) ||
    (value.status === 'partial' && (applied.length === 0 || error === null)) ||
    (value.status === 'failed' && (applied.length > 0 || error === null))
  ) {
    return null;
  }
  const errorTruncated = error !== null && error.length > PROJECTED_TEXT_LIMIT;
  const inputTruncated = input !== null && input.length > PROJECTED_TEXT_LIMIT;
  return {
    status: value.status,
    applied: [...applied],
    failed: [...failed],
    unattempted: [...unattempted],
    uncertain: [...uncertain],
    ...(error !== null ? { error: capText(error) } : {}),
    ...(errorTruncated ? { errorTruncated: true as const } : {}),
    ...(input !== null ? { input: capText(input) } : {}),
    ...(inputTruncated ? { inputTruncated: true as const } : {}),
  };
}

/** todo 工具 toolResult.details 的清单快照（白名单校验，脏数据丢弃） */
function projectTodos(value: unknown): TodoItem[] | null {
  if (!isRecord(value) || !Array.isArray(value.todos)) return null;
  const todos = value.todos.filter(
    (item): item is TodoItem =>
      isRecord(item) &&
      typeof item.content === 'string' &&
      TODO_STATUSES.includes(item.status as string)
  );
  return todos.map((item) => ({ content: item.content, status: item.status }));
}

/**
 * 把 pi 的 AgentMessage 投影为渲染层可见的白名单结构。
 * 白名单克隆同时承担脱敏：未列出的字段（provider 原始数据等）不会出 worker。
 * 脏输入返回 null，不抛。
 */
export function projectMessage(value: unknown): ProjectedMessage | null {
  if (!isRecord(value) || typeof value.role !== 'string') return null;

  const projected: ProjectedMessage = {
    role: value.role,
    content: projectContent(value.content),
  };
  if (typeof value.toolName === 'string') projected.toolName = value.toolName;
  if (typeof value.toolCallId === 'string') projected.toolCallId = value.toolCallId;
  if (typeof value.isError === 'boolean') projected.isError = value.isError;
  if (typeof value.stopReason === 'string') projected.stopReason = value.stopReason;
  if (typeof value.errorMessage === 'string') projected.errorMessage = value.errorMessage;
  if (typeof value.timestamp === 'number') projected.timestamp = value.timestamp;
  if (value.role === 'compactionSummary') {
    // pi 的 compaction 消息用 summary 字段而不是 content
    if (typeof value.summary === 'string') {
      projected.content = [{ type: 'text', text: capText(value.summary) }];
    }
    if (typeof value.tokensBefore === 'number') projected.tokensBefore = value.tokensBefore;
    if (value.fromHook === true) projected.verified = true;
    if (value.compactionSource === 'memory') projected.memory = true;
  }
  const usage = projectUsage(value.usage);
  if (usage) projected.usage = usage;
  if (typeof value.ttft === 'number') projected.ttft = value.ttft;
  if (typeof value.duration === 'number') projected.duration = value.duration;
  if (
    value.role === 'toolResult' &&
    ['bash', 'powershell', 'task_output'].includes(String(value.toolName)) &&
    isRecord(value.details)
  ) {
    const rtk = parseRtkToolStats(value.details.rtk);
    if (rtk) projected.rtk = rtk;
  }
  if (value.role === 'toolResult' && value.toolName === 'todo') {
    const todos = projectTodos(value.details);
    if (todos) projected.todos = todos;
  }
  if (value.role === 'toolResult' && value.toolName === 'edit') {
    const editDiff = projectEditDiff(value.details);
    if (editDiff) projected.editDiff = editDiff;
  }
  if (value.role === 'toolResult' && value.toolName === 'apply_patch') {
    const fileChanges = projectFileChanges(value.details);
    if (fileChanges) {
      projected.fileChanges = fileChanges;
      const applyPatchOutcome = projectApplyPatchOutcome(value.details, fileChanges);
      if (applyPatchOutcome) projected.applyPatchOutcome = applyPatchOutcome;
    }
  }
  if (value.role === 'toolResult' && value.toolName === 'subagent' && isRecord(value.details)) {
    const details = value.details as { modelId?: unknown; outputTokens?: unknown; steps?: unknown };
    projected.subagentMeta = {
      ...(typeof details.modelId === 'string' ? { modelId: details.modelId } : {}),
      ...(typeof details.outputTokens === 'number' ? { outputTokens: details.outputTokens } : {}),
      ...(typeof details.steps === 'number' ? { steps: details.steps } : {}),
    };
  }
  return projected;
}

/** 只保留四个 token 计数，cost 等其余字段不出 worker */
function projectUsage(value: unknown): ProjectedMessage['usage'] | null {
  if (!isRecord(value)) return null;
  const num = (key: string): number =>
    typeof value[key] === 'number' ? (value[key] as number) : 0;
  return {
    input: num('input'),
    output: num('output'),
    cacheRead: num('cacheRead'),
    cacheWrite: num('cacheWrite'),
  };
}

function projectContent(content: unknown): ProjectedPart[] {
  // user 消息的 content 可以是纯字符串
  if (typeof content === 'string') return [{ type: 'text', text: capText(content) }];
  if (!Array.isArray(content)) return [];
  return content.map(projectPart);
}

function projectPart(part: unknown): ProjectedPart {
  if (!isRecord(part)) return { type: 'unknown' };
  switch (part.type) {
    case 'text':
      return { type: 'text', text: capText(typeof part.text === 'string' ? part.text : '') };
    case 'thinking':
      return {
        type: 'thinking',
        text: capText(typeof part.thinking === 'string' ? part.thinking : ''),
      };
    case 'toolCall': {
      const projected: ProjectedPart = {
        type: 'toolCall',
        id: typeof part.id === 'string' ? part.id : '',
        name: typeof part.name === 'string' ? part.name : '',
      };
      if ('arguments' in part) {
        projected.arguments =
          projected.name === 'enso_app'
            ? projectEnsoAppReference(part.arguments)
            : capJson(structuredCloneSafe(part.arguments));
      }
      return projected;
    }
    case 'image':
      if (typeof part.data === 'string' && typeof part.mimeType === 'string') {
        return { type: 'image', data: part.data, mimeType: part.mimeType };
      }
      return { type: 'unknown' };
    default:
      return { type: 'unknown' };
  }
}

/** enso_app raw params 只活在执行内存；jsonl/live 投影仅保留无秘密的 capability id。 */
function projectEnsoAppReference(value: unknown): unknown {
  if (!isRecord(value) || typeof value.capability_id !== 'string') return undefined;
  return { capability_id: value.capability_id };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function capText(text: string): string {
  return text.length <= PROJECTED_TEXT_LIMIT ? text : `${text.slice(0, PROJECTED_TEXT_LIMIT)}\n…`;
}

function capJson(value: unknown): unknown {
  if (typeof value === 'string') return capText(value);
  if (Array.isArray(value)) return value.map(capJson);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = capJson(nested);
    return out;
  }
  return value;
}

/** 断开与源对象的引用；不可序列化的参数收敛为 undefined */
function structuredCloneSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}
