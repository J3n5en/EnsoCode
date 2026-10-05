import type {
  CatalogEntry,
  PairSyncCursor,
  ProjectEntry,
  ProjectGroupEntry,
  ProviderEntry,
} from '@enso/pair';
import type { GuestSessionView } from '@shared/pair/guestProjection';
import {
  type ProjectedMessage,
  type ProjectedPart,
  parseSessionUsageTotals,
} from '@shared/types/agent';

const CACHE_SCHEMA = 1;
const DB_NAME = 'enso-phone-session-cache';
const STORE_NAME = 'pairs';
const DB_VERSION = 2;
const DEFAULT_OPEN_TIMEOUT_MS = 8_000;

const DEFAULT_LIMITS: PhoneCacheLimits = {
  ttlMs: 7 * 24 * 60 * 60 * 1_000,
  maxSessions: 5,
  maxMessages: 200,
  maxDeviceBytes: 4 * 1024 * 1024,
  maxRecords: 8,
  maxTotalBytes: 16 * 1024 * 1024,
};

export interface PhoneCacheData {
  catalog: CatalogEntry[];
  pinnedOrder: string[];
  projects: ProjectEntry[];
  projectGroups: ProjectGroupEntry[];
  providers: ProviderEntry[];
  sessions: Array<{ id: string; view: GuestSessionView; cursor?: PairSyncCursor }>;
}

export interface PhoneCacheStore {
  load(pairId: string): Promise<PhoneCacheData | null>;
  save(pairId: string, data: PhoneCacheData): Promise<void>;
  clear(pairId: string): Promise<void>;
}

export interface PhoneCacheBackendEntry {
  key: string;
  value: unknown;
}

export interface PhoneCacheBackend {
  read(key: string): Promise<unknown>;
  write(
    key: string,
    value: unknown,
    prune: (entries: readonly PhoneCacheBackendEntry[]) => readonly string[]
  ): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PhoneCacheLimits {
  ttlMs: number;
  maxSessions: number;
  maxMessages: number;
  maxDeviceBytes: number;
  maxRecords: number;
  maxTotalBytes: number;
}

export interface PhoneCacheOptions {
  backend?: PhoneCacheBackend;
  indexedDB?: IDBFactory;
  limits?: Partial<PhoneCacheLimits>;
  now?: () => number;
  openTimeoutMs?: number;
}

interface EncodedView extends Omit<GuestSessionView, 'messages'> {
  messages: Array<[number, ProjectedMessage]>;
}

interface EncodedSession {
  id: string;
  view: EncodedView;
  cursor?: PairSyncCursor;
}

interface EncodedData extends Omit<PhoneCacheData, 'sessions'> {
  sessions: EncodedSession[];
}

interface CacheRecord {
  pairId: string;
  schema: number;
  updatedAt: number;
  accessedAt: number;
  bytes: number;
  data: EncodedData;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const isUint = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
const optional = (
  value: Record<string, unknown>,
  key: string,
  check: (nested: unknown) => boolean
): boolean => value[key] === undefined || check(value[key]);

function parseArray<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function parseArrayKeep<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function keepUniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function unique(items: readonly string[]): boolean {
  return new Set(items).size === items.length;
}

function parseCatalogEntry(value: unknown): CatalogEntry | null {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.title) ||
    !isString(value.projectId) ||
    !isString(value.status) ||
    !optional(value, 'projectName', isString) ||
    !optional(value, 'cwd', isString) ||
    !optional(value, 'unread', isBoolean) ||
    !optional(value, 'pendingAskCount', isUint) ||
    !optional(value, 'pendingApprovalCount', isUint) ||
    !optional(value, 'parentId', isString) ||
    !optional(value, 'updatedAt', isUint) ||
    !optional(value, 'pinned', isBoolean) ||
    !optional(value, 'archived', isBoolean) ||
    !optional(value, 'providerId', isString) ||
    !optional(value, 'modelId', isString) ||
    !optional(value, 'reasoningEnabled', isBoolean)
  ) {
    return null;
  }
  const queued =
    value.queued === undefined
      ? undefined
      : parseArrayKeep(value.queued, (item): NonNullable<CatalogEntry['queued']>[number] | null => {
          if (
            !isRecord(item) ||
            !isString(item.id) ||
            !isString(item.text) ||
            !optional(item, 'hasImages', isBoolean)
          ) {
            return null;
          }
          return {
            id: item.id,
            text: item.text,
            ...(typeof item.hasImages === 'boolean' ? { hasImages: item.hasImages } : {}),
          };
        });

  let goal: CatalogEntry['goal'];
  if (value.goal !== undefined) {
    if (
      !isRecord(value.goal) ||
      !isString(value.goal.text) ||
      !isUint(value.goal.autoTurns) ||
      !optional(value.goal, 'note', isString)
    ) {
      return null;
    }
    const status = value.goal.status;
    if (
      status !== 'active' &&
      status !== 'paused' &&
      status !== 'completed' &&
      status !== 'blocked' &&
      status !== 'waiting'
    ) {
      return null;
    }
    goal = {
      text: value.goal.text,
      status,
      autoTurns: value.goal.autoTurns,
      ...(typeof value.goal.note === 'string' ? { note: value.goal.note } : {}),
    };
  }
  const slashCommands =
    value.slashCommands === undefined
      ? undefined
      : parseArrayKeep(
          value.slashCommands,
          (item): NonNullable<CatalogEntry['slashCommands']>[number] | null =>
            isRecord(item) && isString(item.name) && isString(item.description)
              ? { name: item.name, description: item.description }
              : null
        );

  const out: CatalogEntry = {
    id: value.id,
    title: value.title,
    projectName: isString(value.projectName) ? value.projectName : '',
    projectId: value.projectId,
    status: value.status,
  };
  if (typeof value.cwd === 'string') out.cwd = value.cwd;
  if (typeof value.unread === 'boolean') out.unread = value.unread;
  if (typeof value.pendingAskCount === 'number') out.pendingAskCount = value.pendingAskCount;
  if (typeof value.pendingApprovalCount === 'number')
    out.pendingApprovalCount = value.pendingApprovalCount;
  if (typeof value.parentId === 'string') out.parentId = value.parentId;
  if (typeof value.updatedAt === 'number') out.updatedAt = value.updatedAt;
  if (typeof value.pinned === 'boolean') out.pinned = value.pinned;
  if (typeof value.archived === 'boolean') out.archived = value.archived;
  if (typeof value.providerId === 'string') out.providerId = value.providerId;
  if (typeof value.modelId === 'string') out.modelId = value.modelId;
  if (typeof value.reasoningEnabled === 'boolean') out.reasoningEnabled = value.reasoningEnabled;
  if (
    value.thinkingLevel === 'minimal' ||
    value.thinkingLevel === 'low' ||
    value.thinkingLevel === 'medium' ||
    value.thinkingLevel === 'high' ||
    value.thinkingLevel === 'xhigh' ||
    value.thinkingLevel === 'max'
  ) {
    out.thinkingLevel = value.thinkingLevel;
  }
  if (queued) out.queued = queued;
  if (goal) out.goal = goal;
  if (slashCommands) out.slashCommands = slashCommands;
  const context = parseContext(value.context);
  if (context) out.context = context;
  const usageTotals = parseSessionUsageTotals(value.usageTotals);
  if (usageTotals) out.usageTotals = usageTotals;
  return out;
}

/** 占用只是展示用：脏值丢占用本身，不连累目录条目 */
function parseContext(value: unknown): CatalogEntry['context'] {
  if (!isRecord(value) || !isUint(value.used) || !optional(value, 'window', isUint)) {
    return undefined;
  }
  return typeof value.window === 'number'
    ? { used: value.used, window: value.window }
    : { used: value.used };
}

function parseProject(value: unknown): ProjectEntry | null {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.name) ||
    !optional(value, 'path', isString) ||
    !optional(value, 'alias', isString) ||
    !optional(value, 'sshConnectionName', isString) ||
    !optional(value, 'sshHost', isString) ||
    !optional(value, 'groupId', isString) ||
    (value.kind !== undefined && value.kind !== 'local' && value.kind !== 'ssh') ||
    (value.archived !== undefined && value.archived !== true)
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    path: isString(value.path) ? value.path : '',
    ...(typeof value.alias === 'string' ? { alias: value.alias } : {}),
    ...(value.kind === 'local' || value.kind === 'ssh' ? { kind: value.kind } : {}),
    ...(typeof value.sshConnectionName === 'string'
      ? { sshConnectionName: value.sshConnectionName }
      : {}),
    ...(typeof value.sshHost === 'string' ? { sshHost: value.sshHost } : {}),
    ...(value.archived === true ? { archived: true as const } : {}),
    ...(typeof value.groupId === 'string' ? { groupId: value.groupId } : {}),
  };
}

function parseProjectGroup(value: unknown): ProjectGroupEntry | null {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.name) ||
    !isFiniteNumber(value.order) ||
    !optional(value, 'emoji', isString) ||
    !optional(value, 'color', isString)
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    order: value.order,
    ...(typeof value.emoji === 'string' ? { emoji: value.emoji } : {}),
    ...(typeof value.color === 'string' ? { color: value.color } : {}),
  };
}

function parseProvider(value: unknown): ProviderEntry | null {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name)) return null;
  const models = parseArrayKeep(value.models, (model): ProviderEntry['models'][number] | null => {
    if (!isRecord(model) || !isString(model.id) || !optional(model, 'label', isString)) return null;
    return {
      id: model.id,
      ...(typeof model.label === 'string' ? { label: model.label } : {}),
    };
  });
  if (!models) return null;
  return { id: value.id, name: value.name, models: keepUniqueById(models) };
}

interface JsonState {
  nodes: number;
  seen: WeakSet<object>;
}

type JsonResult = { ok: true; value: unknown } | { ok: false };
const badJson: JsonResult = { ok: false };

function cloneJson(
  value: unknown,
  state: JsonState = { nodes: 0, seen: new WeakSet() },
  depth = 0
): JsonResult {
  state.nodes += 1;
  if (state.nodes > 200_000 || depth > 32) return badJson;
  if (value === null || isString(value) || isBoolean(value)) return { ok: true, value };
  if (isFiniteNumber(value)) return { ok: true, value };
  if (Array.isArray(value)) {
    if (state.seen.has(value)) return badJson;
    state.seen.add(value);
    const out: unknown[] = [];
    for (const item of value) {
      const parsed = cloneJson(item, state, depth + 1);
      if (!parsed.ok) return badJson;
      out.push(parsed.value);
    }
    state.seen.delete(value);
    return { ok: true, value: out };
  }
  if (!isRecord(value)) return badJson;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return badJson;
  if (state.seen.has(value)) return badJson;
  state.seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (nested === undefined) continue;
    const parsed = cloneJson(nested, state, depth + 1);
    if (!parsed.ok) return badJson;
    Object.defineProperty(out, key, {
      value: parsed.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  state.seen.delete(value);
  return { ok: true, value: out };
}

function parsePart(value: unknown): ProjectedPart | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'text':
      return isString(value.text) ? { type: 'text', text: value.text } : null;
    case 'thinking':
      return isString(value.text) ? { type: 'thinking', text: value.text } : null;
    case 'toolCall': {
      if (!isString(value.id) || !isString(value.name)) return null;
      if (value.arguments === undefined)
        return { type: 'toolCall', id: value.id, name: value.name };
      const args = cloneJson(value.arguments);
      return args.ok
        ? { type: 'toolCall', id: value.id, name: value.name, arguments: args.value }
        : null;
    }
    case 'image':
      return isString(value.data) && isString(value.mimeType)
        ? { type: 'image', data: value.data, mimeType: value.mimeType }
        : null;
    case 'unknown':
      return { type: 'unknown' };
    default:
      return null;
  }
}

function parseUsage(value: unknown): NonNullable<ProjectedMessage['usage']> | null {
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.input) ||
    !isFiniteNumber(value.output) ||
    !isFiniteNumber(value.cacheRead) ||
    !isFiniteNumber(value.cacheWrite)
  ) {
    return null;
  }
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
  };
}

function parseTiming(value: unknown): NonNullable<ProjectedMessage['timing']> | null {
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.stepStartMs) ||
    !optional(value, 'firstTokenMs', isFiniteNumber) ||
    !optional(value, 'thinkingEndMs', isFiniteNumber) ||
    !optional(value, 'completedMs', isFiniteNumber)
  ) {
    return null;
  }
  return {
    stepStartMs: value.stepStartMs,
    ...(typeof value.firstTokenMs === 'number' ? { firstTokenMs: value.firstTokenMs } : {}),
    ...(typeof value.thinkingEndMs === 'number' ? { thinkingEndMs: value.thinkingEndMs } : {}),
    ...(typeof value.completedMs === 'number' ? { completedMs: value.completedMs } : {}),
  };
}

function parseMessage(value: unknown): ProjectedMessage | null {
  if (!isRecord(value) || !isString(value.role)) return null;
  const content = parseArray(value.content, parsePart);
  if (
    !content ||
    !optional(value, 'toolName', isString) ||
    !optional(value, 'toolCallId', isString) ||
    !optional(value, 'isError', isBoolean) ||
    !optional(value, 'stopReason', isString) ||
    !optional(value, 'errorMessage', isString) ||
    !optional(value, 'timestamp', isFiniteNumber) ||
    !optional(value, 'ttft', isFiniteNumber) ||
    !optional(value, 'duration', isFiniteNumber) ||
    !optional(value, 'toolDurationMs', isFiniteNumber) ||
    !optional(value, 'tokensBefore', isFiniteNumber) ||
    !optional(value, 'verified', isBoolean) ||
    !optional(value, 'memory', isBoolean)
  ) {
    return null;
  }
  const usage = value.usage === undefined ? undefined : parseUsage(value.usage);
  const timing = value.timing === undefined ? undefined : parseTiming(value.timing);
  if ((value.usage !== undefined && !usage) || (value.timing !== undefined && !timing)) return null;

  const todos =
    value.todos === undefined
      ? undefined
      : parseArray(value.todos, (item): NonNullable<ProjectedMessage['todos']>[number] | null => {
          if (
            !isRecord(item) ||
            !isString(item.content) ||
            (item.status !== 'pending' &&
              item.status !== 'in_progress' &&
              item.status !== 'completed')
          ) {
            return null;
          }
          return { content: item.content, status: item.status };
        });
  if (value.todos !== undefined && !todos) return null;

  let subagentMeta: ProjectedMessage['subagentMeta'];
  if (value.subagentMeta !== undefined) {
    if (
      !isRecord(value.subagentMeta) ||
      !optional(value.subagentMeta, 'modelId', isString) ||
      !optional(value.subagentMeta, 'outputTokens', isFiniteNumber) ||
      !optional(value.subagentMeta, 'steps', isFiniteNumber)
    ) {
      return null;
    }
    subagentMeta = {
      ...(typeof value.subagentMeta.modelId === 'string'
        ? { modelId: value.subagentMeta.modelId }
        : {}),
      ...(typeof value.subagentMeta.outputTokens === 'number'
        ? { outputTokens: value.subagentMeta.outputTokens }
        : {}),
      ...(typeof value.subagentMeta.steps === 'number' ? { steps: value.subagentMeta.steps } : {}),
    };
  }

  let editDiff: ProjectedMessage['editDiff'];
  if (value.editDiff !== undefined) {
    if (
      !isRecord(value.editDiff) ||
      !isString(value.editDiff.oldText) ||
      !isString(value.editDiff.newText)
    ) {
      return null;
    }
    editDiff = { oldText: value.editDiff.oldText, newText: value.editDiff.newText };
  }

  const fileChanges =
    value.fileChanges === undefined
      ? undefined
      : parseArray(
          value.fileChanges,
          (item): NonNullable<ProjectedMessage['fileChanges']>[number] | null => {
            if (
              !isRecord(item) ||
              !isString(item.path) ||
              !isString(item.oldText) ||
              !isString(item.newText) ||
              (item.type !== 'add' && item.type !== 'update' && item.type !== 'delete') ||
              (item.truncated !== undefined && item.truncated !== true)
            ) {
              return null;
            }
            return {
              path: item.path,
              oldText: item.oldText,
              newText: item.newText,
              type: item.type,
              ...(item.truncated === true ? { truncated: true as const } : {}),
            };
          }
        );
  if (value.fileChanges !== undefined && !fileChanges) return null;

  let applyPatchOutcome: ProjectedMessage['applyPatchOutcome'];
  if (value.applyPatchOutcome !== undefined) {
    const outcome = value.applyPatchOutcome;
    if (
      !isRecord(outcome) ||
      (outcome.status !== 'success' &&
        outcome.status !== 'partial' &&
        outcome.status !== 'failed') ||
      !optional(outcome, 'error', isString) ||
      !optional(outcome, 'input', isString) ||
      (outcome.errorTruncated !== undefined && outcome.errorTruncated !== true) ||
      (outcome.inputTruncated !== undefined && outcome.inputTruncated !== true)
    ) {
      return null;
    }
    const applied = parseArray(outcome.applied, (item) => (isString(item) ? item : null));
    const failed = parseArray(outcome.failed, (item) => (isString(item) ? item : null));
    const unattempted = parseArray(outcome.unattempted, (item) => (isString(item) ? item : null));
    const uncertain = parseArray(outcome.uncertain, (item) => (isString(item) ? item : null));
    if (!applied || !failed || !unattempted || !uncertain) return null;
    applyPatchOutcome = {
      status: outcome.status,
      applied,
      failed,
      unattempted,
      uncertain,
      ...(typeof outcome.error === 'string' ? { error: outcome.error } : {}),
      ...(outcome.errorTruncated === true ? { errorTruncated: true as const } : {}),
      ...(typeof outcome.input === 'string' ? { input: outcome.input } : {}),
      ...(outcome.inputTruncated === true ? { inputTruncated: true as const } : {}),
    };
  }

  const out: ProjectedMessage = { role: value.role, content };
  if (typeof value.toolName === 'string') out.toolName = value.toolName;
  if (typeof value.toolCallId === 'string') out.toolCallId = value.toolCallId;
  if (typeof value.isError === 'boolean') out.isError = value.isError;
  if (typeof value.stopReason === 'string') out.stopReason = value.stopReason;
  if (typeof value.errorMessage === 'string') out.errorMessage = value.errorMessage;
  if (typeof value.timestamp === 'number') out.timestamp = value.timestamp;
  if (usage) out.usage = usage;
  if (typeof value.ttft === 'number') out.ttft = value.ttft;
  if (typeof value.duration === 'number') out.duration = value.duration;
  if (timing) out.timing = timing;
  if (todos) out.todos = todos;
  if (typeof value.toolDurationMs === 'number') out.toolDurationMs = value.toolDurationMs;
  if (subagentMeta) out.subagentMeta = subagentMeta;
  if (editDiff) out.editDiff = editDiff;
  if (fileChanges) out.fileChanges = fileChanges;
  if (applyPatchOutcome) out.applyPatchOutcome = applyPatchOutcome;
  if (typeof value.tokensBefore === 'number') out.tokensBefore = value.tokensBefore;
  if (typeof value.verified === 'boolean') out.verified = value.verified;
  if (typeof value.memory === 'boolean') out.memory = value.memory;
  return out;
}

function parseApprovals(value: unknown): GuestSessionView['approvals'] | null {
  return parseArray(value, (item): GuestSessionView['approvals'][number] | null => {
    if (
      !isRecord(item) ||
      !isString(item.requestId) ||
      !isString(item.tool) ||
      !isString(item.summary) ||
      !optional(item, 'toolCallId', isString) ||
      (item.phase !== undefined && item.phase !== 'reviewing') ||
      (item.kind !== 'command' &&
        item.kind !== 'file-edit' &&
        item.kind !== 'file-write' &&
        item.kind !== 'mcp')
    ) {
      return null;
    }
    return {
      requestId: item.requestId,
      tool: item.tool,
      kind: item.kind,
      summary: item.summary,
      ...(typeof item.toolCallId === 'string' ? { toolCallId: item.toolCallId } : {}),
      ...(item.phase === 'reviewing' ? { phase: 'reviewing' as const } : {}),
      ...(typeof item.expiresAt === 'number' ? { expiresAt: item.expiresAt } : {}),
    };
  });
}

function parseAsks(value: unknown): GuestSessionView['asks'] | null {
  return parseArray(value, (item): GuestSessionView['asks'][number] | null => {
    if (!isRecord(item) || !isString(item.requestId) || !isString(item.question)) return null;
    const options =
      item.options === undefined
        ? undefined
        : parseArray(item.options, (option) => (isString(option) ? option : null));
    if (item.options !== undefined && !options) return null;
    return {
      requestId: item.requestId,
      question: item.question,
      ...(options ? { options } : {}),
      ...(typeof item.expiresAt === 'number' ? { expiresAt: item.expiresAt } : {}),
    };
  });
}

function parseTasks(value: unknown): GuestSessionView['tasks'] | null {
  return parseArray(value, (item): GuestSessionView['tasks'][number] | null => {
    if (
      !isRecord(item) ||
      !isString(item.taskId) ||
      !isString(item.command) ||
      !isString(item.tail) ||
      !isFiniteNumber(item.startedAt) ||
      !optional(item, 'exitCode', isFiniteNumber) ||
      (item.status !== 'running' && item.status !== 'done' && item.status !== 'failed')
    ) {
      return null;
    }
    return {
      taskId: item.taskId,
      command: item.command,
      status: item.status,
      tail: item.tail,
      startedAt: item.startedAt,
      ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
    };
  });
}

function parseSubagents(value: unknown): GuestSessionView['subagents'] | null {
  return parseArray(value, (item): GuestSessionView['subagents'][number] | null => {
    if (
      !isRecord(item) ||
      !isString(item.id) ||
      !isString(item.description) ||
      !isFiniteNumber(item.steps) ||
      !isString(item.currentActivity) ||
      !isFiniteNumber(item.startedAt) ||
      !optional(item, 'detailsPruned', isBoolean) ||
      !optional(item, 'resultText', isString) ||
      !optional(item, 'modelId', isString) ||
      !optional(item, 'agentType', isString) ||
      !optional(item, 'outputTokens', isFiniteNumber) ||
      (item.status !== 'running' && item.status !== 'done' && item.status !== 'failed')
    ) {
      return null;
    }
    const activityLog =
      item.activityLog === undefined
        ? undefined
        : parseArray(item.activityLog, (entry) => (isString(entry) ? entry : null));
    const activities =
      item.activities === undefined
        ? undefined
        : parseArray(
            item.activities,
            (
              activity
            ): NonNullable<GuestSessionView['subagents'][number]['activities']>[number] | null => {
              if (!isRecord(activity) || !isString(activity.id)) return null;
              if (
                activity.type === 'assistant' &&
                isString(activity.text) &&
                isBoolean(activity.streaming)
              ) {
                return {
                  id: activity.id,
                  type: 'assistant',
                  text: activity.text,
                  streaming: activity.streaming,
                };
              }
              if (
                activity.type === 'tool' &&
                isString(activity.toolName) &&
                isString(activity.argumentsText) &&
                optional(activity, 'outputText', isString) &&
                (activity.status === 'running' ||
                  activity.status === 'done' ||
                  activity.status === 'failed' ||
                  activity.status === 'aborted')
              ) {
                return {
                  id: activity.id,
                  type: 'tool',
                  toolName: activity.toolName,
                  argumentsText: activity.argumentsText,
                  status: activity.status,
                  ...(typeof activity.outputText === 'string'
                    ? { outputText: activity.outputText }
                    : {}),
                };
              }
              return null;
            }
          );
    if (
      (item.activityLog !== undefined && !activityLog) ||
      (item.activities !== undefined && !activities)
    ) {
      return null;
    }
    return {
      id: item.id,
      description: item.description,
      status: item.status,
      steps: item.steps,
      currentActivity: item.currentActivity,
      startedAt: item.startedAt,
      ...(activityLog ? { activityLog } : {}),
      ...(activities ? { activities } : {}),
      ...(typeof item.detailsPruned === 'boolean' ? { detailsPruned: item.detailsPruned } : {}),
      ...(typeof item.resultText === 'string' ? { resultText: item.resultText } : {}),
      ...(typeof item.modelId === 'string' ? { modelId: item.modelId } : {}),
      ...(typeof item.agentType === 'string' ? { agentType: item.agentType } : {}),
      ...(typeof item.outputTokens === 'number' ? { outputTokens: item.outputTokens } : {}),
    };
  });
}

function parseView(
  value: unknown,
  messages: Map<number, ProjectedMessage>
): GuestSessionView | null {
  if (!isRecord(value) || !isString(value.status)) return null;
  const approvals = parseApprovals(value.approvals);
  const asks = parseAsks(value.asks);
  const tasks = parseTasks(value.tasks);
  const subagents = parseSubagents(value.subagents);
  if (!approvals || !asks || !tasks || !subagents) return null;

  let retry: GuestSessionView['retry'];
  if (value.retry !== undefined) {
    if (
      !isRecord(value.retry) ||
      !isUint(value.retry.attempt) ||
      !isUint(value.retry.maxAttempts) ||
      !isUint(value.retry.delayMs) ||
      !isString(value.retry.error) ||
      !isFiniteNumber(value.retry.at)
    ) {
      return null;
    }
    retry = {
      attempt: value.retry.attempt,
      maxAttempts: value.retry.maxAttempts,
      delayMs: value.retry.delayMs,
      error: value.retry.error,
      at: value.retry.at,
    };
  }
  if (
    value.compaction !== undefined &&
    value.compaction !== 'queued' &&
    value.compaction !== 'running'
  ) {
    return null;
  }
  if (!optional(value, 'compactionNoticeAt', isUint)) return null;
  return {
    messages,
    status: value.status,
    approvals,
    asks,
    tasks,
    subagents,
    ...(retry ? { retry } : {}),
    ...(value.compaction === 'queued' || value.compaction === 'running'
      ? { compaction: value.compaction }
      : {}),
    ...(typeof value.compactionNoticeAt === 'number'
      ? { compactionNoticeAt: value.compactionNoticeAt }
      : {}),
  };
}

function parseCursor(value: unknown): PairSyncCursor | null {
  return isRecord(value) && isString(value.epoch) && value.epoch.length > 0 && isUint(value.seq)
    ? { epoch: value.epoch, seq: value.seq }
    : null;
}

function encodeSession(value: unknown, maxMessages: number): EncodedSession | null {
  if (!isRecord(value) || !isString(value.id) || !isRecord(value.view)) return null;
  if (!(value.view.messages instanceof Map)) return null;
  const entries = [...value.view.messages.entries()];
  if (entries.some(([index]) => !isUint(index))) return null;
  entries.sort((a, b) => a[0] - b[0]);
  let contiguousStart = Math.max(0, entries.length - 1);
  while (
    contiguousStart > 0 &&
    entries[contiguousStart - 1][0] === entries[contiguousStart][0] - 1
  ) {
    contiguousStart -= 1;
  }
  const tail = entries.slice(Math.max(contiguousStart, entries.length - maxMessages));
  if (entries.length > 0 && tail.length === 0) return null;
  const messages: Array<[number, ProjectedMessage]> = [];
  for (const [index, message] of tail) {
    const parsed = parseMessage(message);
    if (!parsed) continue;
    messages.push([index, parsed]);
  }
  const parsedView = parseView(value.view, new Map(messages));
  if (!parsedView) return null;
  const cursor = value.cursor === undefined ? undefined : parseCursor(value.cursor);
  if (value.cursor !== undefined && !cursor) return null;
  return {
    id: value.id,
    view: { ...parsedView, messages },
    ...(cursor ? { cursor } : {}),
  };
}

function decodeSession(
  value: unknown,
  limits: PhoneCacheLimits
): PhoneCacheData['sessions'][number] | null {
  if (!isRecord(value) || !isString(value.id) || !isRecord(value.view)) return null;
  const rawMessages = value.view.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length > limits.maxMessages) return null;
  const messages = new Map<number, ProjectedMessage>();
  let previous: number | undefined;
  for (const entry of rawMessages) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isUint(entry[0])) return null;
    if (previous !== undefined && entry[0] <= previous) return null;
    const message = parseMessage(entry[1]);
    if (!message || messages.has(entry[0])) return null;
    messages.set(entry[0], message);
    previous = entry[0];
  }
  const parsedView = parseView(value.view, messages);
  if (!parsedView) return null;
  const cursor = value.cursor === undefined ? undefined : parseCursor(value.cursor);
  if (value.cursor !== undefined && !cursor) return null;
  return { id: value.id, view: parsedView, ...(cursor ? { cursor } : {}) };
}

function parseMetadata(value: unknown): Omit<PhoneCacheData, 'sessions'> | null {
  if (!isRecord(value)) return null;
  const catalog = parseArrayKeep(value.catalog, parseCatalogEntry) ?? [];
  const pinnedOrder =
    parseArrayKeep(value.pinnedOrder, (item) => (isString(item) ? item : null)) ?? [];
  const projects = parseArrayKeep(value.projects, parseProject) ?? [];
  const projectGroups = parseArrayKeep(value.projectGroups, parseProjectGroup) ?? [];
  const providers = parseArrayKeep(value.providers, parseProvider) ?? [];
  const pinned = [...new Set(pinnedOrder)];
  return {
    catalog: keepUniqueById(catalog),
    pinnedOrder: pinned,
    projects: keepUniqueById(projects),
    projectGroups: keepUniqueById(projectGroups),
    providers: keepUniqueById(providers),
  };
}

function jsonBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : new TextEncoder().encode(json).byteLength;
  } catch {
    return null;
  }
}

function encodeData(value: unknown, limits: PhoneCacheLimits): EncodedData | null {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    console.warn('[pair] cache encode skipped');
    return null;
  }
  const metadata = parseMetadata(value) ?? {
    catalog: [],
    pinnedOrder: [],
    projects: [],
    projectGroups: [],
    providers: [],
  };
  const sessions: EncodedSession[] = [];
  const recent = limits.maxSessions === 0 ? [] : value.sessions.slice(-limits.maxSessions);
  for (const session of recent) {
    const parsed = encodeSession(session, limits.maxMessages);
    if (parsed) sessions.push(parsed);
  }
  if (!unique(sessions.map((session) => session.id))) return null;
  const data: EncodedData = { ...metadata, sessions };
  let bytes = jsonBytes(data);
  if (bytes === null) return null;

  while (bytes > limits.maxDeviceBytes && data.sessions.length > 1) {
    data.sessions.shift();
    bytes = jsonBytes(data);
    if (bytes === null) return null;
  }
  if (bytes <= limits.maxDeviceBytes) return data;
  const latest = data.sessions[0];
  if (latest?.view.messages.length) {
    const original = latest.view.messages;
    let low = 1;
    let high = original.length - 1;
    let best = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      latest.view.messages = original.slice(middle);
      const candidateBytes = jsonBytes(data);
      if (candidateBytes !== null && candidateBytes <= limits.maxDeviceBytes) {
        best = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    if (best >= 0) {
      latest.view.messages = original.slice(best);
      return data;
    }
  }
  data.sessions = [];
  bytes = jsonBytes(data);
  return bytes !== null && bytes <= limits.maxDeviceBytes ? data : null;
}

function decodeData(value: unknown, limits: PhoneCacheLimits): PhoneCacheData | null {
  const metadata = parseMetadata(value);
  if (!metadata || !isRecord(value) || !Array.isArray(value.sessions)) return null;
  if (value.sessions.length > limits.maxSessions) return null;
  const sessions = parseArray(value.sessions, (session) => decodeSession(session, limits));
  if (!sessions || !unique(sessions.map((session) => session.id))) return null;
  return { ...metadata, sessions };
}

function decodeRecord(
  value: unknown,
  pairId: string,
  limits: PhoneCacheLimits,
  now: number
): { data: PhoneCacheData; record: CacheRecord } | null {
  if (
    !isRecord(value) ||
    !isUint(now) ||
    value.schema !== CACHE_SCHEMA ||
    value.pairId !== pairId ||
    !isUint(value.updatedAt) ||
    !isUint(value.accessedAt) ||
    !isUint(value.bytes) ||
    now - value.updatedAt > limits.ttlMs
  ) {
    return null;
  }
  const bytes = jsonBytes(value.data);
  const recordBytes = jsonBytes(value);
  if (
    bytes === null ||
    bytes !== value.bytes ||
    bytes > limits.maxDeviceBytes ||
    recordBytes === null ||
    recordBytes > limits.maxDeviceBytes
  ) {
    return null;
  }
  const data = decodeData(value.data, limits);
  if (!data) return null;
  const payloadLimit = payloadBudget(pairId, value.updatedAt, limits.maxDeviceBytes);
  const canonical = encodeData(data, { ...limits, maxDeviceBytes: payloadLimit });
  const canonicalBytes = canonical ? jsonBytes(canonical) : null;
  if (!canonical || canonicalBytes === null) return null;
  return {
    data,
    record: {
      pairId,
      schema: CACHE_SCHEMA,
      updatedAt: value.updatedAt,
      accessedAt: value.accessedAt,
      bytes: canonicalBytes,
      data: canonical,
    },
  };
}

function payloadBudget(pairId: string, updatedAt: number, maxDeviceBytes: number): number {
  const envelope = jsonBytes({
    pairId,
    schema: CACHE_SCHEMA,
    updatedAt,
    accessedAt: updatedAt,
    bytes: maxDeviceBytes,
    data: null,
  });
  return envelope === null ? 0 : Math.max(0, maxDeviceBytes - (envelope - 4));
}

function pruneRecords(
  entries: readonly PhoneCacheBackendEntry[],
  limits: PhoneCacheLimits,
  preferredKey: string
): string[] {
  const invalid: string[] = [];
  const candidates: Array<{ key: string; accessedAt: number; bytes: number }> = [];
  for (const entry of entries) {
    const value = entry.value;
    const bytes = jsonBytes(value);
    if (
      !isRecord(value) ||
      value.schema !== CACHE_SCHEMA ||
      value.pairId !== entry.key ||
      !isUint(value.accessedAt) ||
      bytes === null
    ) {
      invalid.push(entry.key);
      continue;
    }
    candidates.push({ key: entry.key, accessedAt: value.accessedAt, bytes });
  }
  candidates.sort(
    (a, b) =>
      b.accessedAt - a.accessedAt ||
      Number(b.key === preferredKey) - Number(a.key === preferredKey) ||
      a.key.localeCompare(b.key)
  );
  let total = 0;
  let count = 0;
  for (const candidate of candidates) {
    if (count >= limits.maxRecords || total + candidate.bytes > limits.maxTotalBytes) {
      invalid.push(candidate.key);
    } else {
      count += 1;
      total += candidate.bytes;
    }
  }
  return [...new Set(invalid)];
}

class IndexedDbBackend implements PhoneCacheBackend {
  private opening: Promise<IDBDatabase> | null = null;

  constructor(
    private factory: IDBFactory,
    private timeoutMs: number
  ) {}

  private database(): Promise<IDBDatabase> {
    if (!this.opening) {
      const opening = this.open();
      this.opening = opening;
      void opening.catch(() => {
        if (this.opening === opening) this.opening = null;
      });
    }
    return this.opening;
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      const finish = (database: IDBDatabase | null, error?: unknown): void => {
        if (settled) {
          database?.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (database) resolve(database);
        else reject(error ?? new Error('IndexedDB unavailable'));
      };
      const timer = setTimeout(
        () => finish(null, new Error('IndexedDB open timeout')),
        this.timeoutMs
      );
      request.onupgradeneeded = () => {
        try {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME);
          }
        } catch (error) {
          try {
            request.transaction?.abort();
          } catch {}
          finish(null, error);
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        finish(request.result);
      };
      request.onerror = () => finish(null, request.error);
      request.onblocked = () => {};
    });
  }

  async read(key: string): Promise<unknown> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(STORE_NAME, 'readonly');
      } catch (error) {
        reject(error);
        return;
      }
      let result: unknown;
      let settled = false;
      const finish = (value: unknown, error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          transaction.abort();
        } catch {}
        finish(null, new Error('IndexedDB transaction timeout'));
      }, this.timeoutMs);
      const request = transaction.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => finish(result);
      transaction.onabort = () => finish(null, transaction.error ?? new Error('IndexedDB aborted'));
      transaction.onerror = () => {};
    });
  }

  async write(
    key: string,
    value: unknown,
    prune: (entries: readonly PhoneCacheBackendEntry[]) => readonly string[]
  ): Promise<void> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(STORE_NAME, 'readwrite');
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        try {
          transaction.abort();
        } catch {}
        finish(new Error('IndexedDB transaction timeout'));
      }, this.timeoutMs);
      const store = transaction.objectStore(STORE_NAME);
      const values = store.getAll();
      const keys = store.getAllKeys();
      let valuesReady = false;
      let keysReady = false;
      const apply = (): void => {
        if (!valuesReady || !keysReady) return;
        try {
          const entries: PhoneCacheBackendEntry[] = [];
          for (let index = 0; index < keys.result.length; index += 1) {
            const entryKey = keys.result[index];
            if (typeof entryKey === 'string' && entryKey !== key) {
              entries.push({ key: entryKey, value: values.result[index] });
            }
          }
          entries.push({ key, value });
          store.put(value, key);
          for (const stale of prune(entries)) store.delete(stale);
        } catch (error) {
          try {
            transaction.abort();
          } catch {}
          finish(error);
        }
      };
      values.onsuccess = () => {
        valuesReady = true;
        apply();
      };
      keys.onsuccess = () => {
        keysReady = true;
        apply();
      };
      transaction.oncomplete = () => finish();
      transaction.onabort = () => finish(transaction.error ?? new Error('IndexedDB aborted'));
      transaction.onerror = () => {};
    });
  }

  async remove(key: string): Promise<void> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(key);
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        try {
          transaction.abort();
        } catch {}
        finish(new Error('IndexedDB transaction timeout'));
      }, this.timeoutMs);
      transaction.oncomplete = () => finish();
      transaction.onabort = () => finish(transaction.error ?? new Error('IndexedDB aborted'));
      transaction.onerror = () => {};
    });
  }
}

function normalizedLimits(value: Partial<PhoneCacheLimits> | undefined): PhoneCacheLimits {
  const out = { ...DEFAULT_LIMITS };
  if (!value) return out;
  for (const key of Object.keys(out) as Array<keyof PhoneCacheLimits>) {
    const next = value[key];
    if (typeof next === 'number' && Number.isSafeInteger(next) && next >= 0) out[key] = next;
  }
  return out;
}

export function createPhoneCacheStore(options: PhoneCacheOptions = {}): PhoneCacheStore {
  const limits = normalizedLimits(options.limits);
  const timeoutMs =
    typeof options.openTimeoutMs === 'number' && options.openTimeoutMs > 0
      ? options.openTimeoutMs
      : DEFAULT_OPEN_TIMEOUT_MS;
  const nativeFactory =
    'indexedDB' in options
      ? options.indexedDB
      : 'indexedDB' in globalThis
        ? globalThis.indexedDB
        : undefined;
  const backend =
    options.backend ?? (nativeFactory ? new IndexedDbBackend(nativeFactory, timeoutMs) : null);
  const now = options.now ?? Date.now;
  const queues = new Map<string, Promise<void>>();

  const run = <T>(pairId: string, fallback: T, operation: () => Promise<T>): Promise<T> => {
    if (!pairId || pairId.length > 512) return Promise.resolve(fallback);
    const previous = queues.get(pairId) ?? Promise.resolve();
    const result = previous.then(operation).catch(() => fallback);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    queues.set(pairId, tail);
    void tail.then(() => {
      if (queues.get(pairId) === tail) queues.delete(pairId);
    });
    return result;
  };

  return {
    load(pairId) {
      return run(pairId, null, async () => {
        if (!backend) return null;
        const current = now();
        const raw = await backend.read(pairId);
        if (raw === undefined) return null;
        const decoded = decodeRecord(raw, pairId, limits, current);
        if (!decoded) {
          try {
            await backend.remove(pairId);
          } catch {}
          return null;
        }
        if (decoded.record.accessedAt !== current && isUint(current)) {
          const touchedData = encodeData(decoded.data, {
            ...limits,
            maxDeviceBytes: payloadBudget(pairId, current, limits.maxDeviceBytes),
          });
          const touchedBytes = touchedData ? jsonBytes(touchedData) : null;
          if (touchedData && touchedBytes !== null) {
            const touched: CacheRecord = {
              ...decoded.record,
              accessedAt: current,
              bytes: touchedBytes,
              data: touchedData,
            };
            try {
              await backend.write(pairId, touched, (entries) =>
                pruneRecords(entries, limits, pairId)
              );
            } catch {}
          }
        }
        return decoded.data;
      });
    },
    save(pairId, value) {
      return run(pairId, undefined, async () => {
        if (!backend) return;
        const updatedAt = now();
        const data = isUint(updatedAt)
          ? encodeData(value, {
              ...limits,
              maxDeviceBytes: payloadBudget(pairId, updatedAt, limits.maxDeviceBytes),
            })
          : null;
        if (!data || !isUint(updatedAt)) {
          return;
        }
        const bytes = jsonBytes(data);
        if (bytes === null) return;
        const record: CacheRecord = {
          pairId,
          schema: CACHE_SCHEMA,
          updatedAt,
          accessedAt: updatedAt,
          bytes,
          data,
        };
        try {
          await backend.write(pairId, record, (entries) => pruneRecords(entries, limits, pairId));
        } catch (error) {
          console.warn('[pair] cache write failed', error);
        }
      });
    },
    clear(pairId) {
      return run(pairId, undefined, async () => {
        if (backend) await backend.remove(pairId);
      });
    },
  };
}

export const phoneCache: PhoneCacheStore = createPhoneCacheStore();
