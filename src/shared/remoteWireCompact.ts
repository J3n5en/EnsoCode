import { IPC_CHANNELS } from './types/ipc';

/**
 * 远程隧道只读缓存大包的线上无损压缩（不改落盘 schema，也不影响本地 Electron）：
 * - conversations:read：剥离 `persistSnapshot` 统一写进每条会话的常量运行态空默认值（[] / {} / false / 0 / 'idle'），
 *   并在 shim 还原，既把首屏与 `__reads.json` 缩小 ~40-50%，又保持 RemoteWriteBases/Client 基线全等。
 * - source-authority:read：远端只读/选择仅使用 active 项目与 root 会话，线上过滤非 active 与 child 并省略固定字段后在 shim 还原。
 */

const CONV_COMPACT_MARK = '__ensoConvCompact';
const AUTH_COMPACT_MARK = '__ensoAuthCompact';

const EMPTY_ARRAY_KEYS = [
  'messages',
  'commands',
  'customEntries',
  'pendingApprovals',
  'pendingAsks',
  'backgroundTasks',
  'subagents',
] as const;

const EMPTY_OBJECT_KEYS = [
  'dispatchMainEvents',
  'toolOutputs',
  'toolStartedAt',
  'toolDeadlineAt',
  'toolEnded',
  'toolTodos',
] as const;

const PRIMITIVE_DEFAULTS = {
  lastSeq: 0,
  spawning: false,
  started: false,
  status: 'idle',
} as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyRecord(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

function compactConversationRow(row: unknown): unknown {
  if (!isPlainRecord(row)) return row;
  const out: Record<string, unknown> = { ...row };
  for (const key of EMPTY_ARRAY_KEYS) {
    const value = out[key];
    if (Array.isArray(value) && value.length === 0) delete out[key];
  }
  for (const key of EMPTY_OBJECT_KEYS) {
    if (isEmptyRecord(out[key])) delete out[key];
  }
  for (const [key, def] of Object.entries(PRIMITIVE_DEFAULTS)) {
    if (out[key] === def) delete out[key];
  }
  return out;
}

function expandConversationRow(row: unknown): unknown {
  if (!isPlainRecord(row)) return row;
  const out: Record<string, unknown> = { ...row };
  for (const key of EMPTY_ARRAY_KEYS) {
    if (!(key in out)) out[key] = [];
  }
  for (const key of EMPTY_OBJECT_KEYS) {
    if (!(key in out)) out[key] = {};
  }
  for (const [key, def] of Object.entries(PRIMITIVE_DEFAULTS)) {
    if (!(key in out)) out[key] = def;
  }
  return out;
}

function compactConversationsResult(result: unknown): unknown {
  if (!isPlainRecord(result) || !isPlainRecord(result.value)) return result;
  const value = result.value;
  if (!isPlainRecord(value.state) || !isPlainRecord(value.state.conversations)) return result;
  const nextConversations: Record<string, unknown> = {};
  for (const [id, row] of Object.entries(value.state.conversations)) {
    if (id === '__proto__') continue;
    nextConversations[id] = compactConversationRow(row);
  }
  return {
    ...result,
    [CONV_COMPACT_MARK]: 1,
    value: {
      ...value,
      state: {
        ...value.state,
        conversations: nextConversations,
      },
    },
  };
}

function expandConversationsResult(result: unknown): unknown {
  if (!isPlainRecord(result) || result[CONV_COMPACT_MARK] !== 1) return result;
  const { [CONV_COMPACT_MARK]: _mark, ...rest } = result;
  if (!isPlainRecord(rest.value)) return rest;
  const value = rest.value;
  if (!isPlainRecord(value.state) || !isPlainRecord(value.state.conversations)) return rest;
  const nextConversations: Record<string, unknown> = {};
  for (const [id, row] of Object.entries(value.state.conversations)) {
    if (id === '__proto__') continue;
    nextConversations[id] = expandConversationRow(row);
  }
  return {
    ...rest,
    value: {
      ...value,
      state: {
        ...value.state,
        conversations: nextConversations,
      },
    },
  };
}

function compactAuthorityResult(result: unknown): unknown {
  if (
    !isPlainRecord(result) ||
    !Array.isArray(result.projects) ||
    !Array.isArray(result.conversations)
  ) {
    return result;
  }
  const projects = result.projects
    .filter((entry) => isPlainRecord(entry) && entry.state === 'active')
    .map((entry) => {
      const { state: _state, ...rest } = entry as Record<string, unknown>;
      return rest;
    });
  const conversations = result.conversations
    .filter((entry) => isPlainRecord(entry) && entry.kind === 'root')
    .map((entry) => {
      const out = { ...(entry as Record<string, unknown>) };
      delete out.kind;
      if (out.lifecycle === 'ready') delete out.lifecycle;
      return out;
    });
  return {
    ...result,
    [AUTH_COMPACT_MARK]: 1,
    projects,
    conversations,
  };
}

function expandAuthorityResult(result: unknown): unknown {
  if (!isPlainRecord(result) || result[AUTH_COMPACT_MARK] !== 1) return result;
  const { [AUTH_COMPACT_MARK]: _mark, ...rest } = result;
  const projects = Array.isArray(rest.projects)
    ? rest.projects.map((entry) => (isPlainRecord(entry) ? { state: 'active', ...entry } : entry))
    : rest.projects;
  const conversations = Array.isArray(rest.conversations)
    ? rest.conversations.map((entry) =>
        isPlainRecord(entry) ? { kind: 'root', lifecycle: 'ready', ...entry } : entry
      )
    : rest.conversations;
  return {
    ...rest,
    projects,
    conversations,
  };
}

/** 宿主准备远程 RPC 返回值前做线上瘦身 */
export function compactRemoteWireResult(channel: string, result: unknown): unknown {
  if (channel === IPC_CHANNELS.CONVERSATIONS_READ) return compactConversationsResult(result);
  if (channel === IPC_CHANNELS.SOURCE_AUTHORITY_READ) return compactAuthorityResult(result);
  return result;
}

/** 浏览器 shim 还原压缩后的只读包；无标记则原样返回 */
export function expandRemoteWireResult(channel: string, result: unknown): unknown {
  if (channel === IPC_CHANNELS.CONVERSATIONS_READ) return expandConversationsResult(result);
  if (channel === IPC_CHANNELS.SOURCE_AUTHORITY_READ) return expandAuthorityResult(result);
  return result;
}
