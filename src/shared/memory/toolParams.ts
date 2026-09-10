import type { UnitTypeSource } from './classify';
import {
  AGENT_CREATE_IMPORTANCE,
  CRYSTAL_MIN_SOURCES,
  DEFAULT_UNIT_TYPE,
  type EvolvesRelation,
  isEvolvesRelation,
  isUnitType,
  type UnitType,
} from './constants';

/** 模型侧只说 space 语义，不持有 Project.id；`project` 由 Main 按会话权威解析成 `proj:<id>`。 */
export const MEMORY_SEARCH_SPACES = ['all', 'global', 'project'] as const;
export const MEMORY_CAPTURE_SPACES = ['global', 'project'] as const;
export const MEMORY_SEARCH_MODES = ['fast', 'deep'] as const;
export type MemorySearchSpace = (typeof MEMORY_SEARCH_SPACES)[number];
export type MemoryCaptureSpace = (typeof MEMORY_CAPTURE_SPACES)[number];
export type MemorySearchMode = (typeof MEMORY_SEARCH_MODES)[number];

export const MEMORY_SEARCH_DEFAULT_LIMIT = 10;
export const MEMORY_SEARCH_MAX_LIMIT = 50;

/** 双时间：event* = 事件何时发生，recorded* = 何时写入；二者不能混用，由检索层报错 */
export const MEMORY_SEARCH_DATE_KEYS = [
  'eventDateFrom',
  'eventDateTo',
  'recordedDateFrom',
  'recordedDateTo',
] as const;
type MemorySearchDateKey = (typeof MEMORY_SEARCH_DATE_KEYS)[number];

export interface MemorySearchRequest extends Partial<Record<MemorySearchDateKey, string>> {
  query: string;
  limit: number;
  spaceId: MemorySearchSpace;
  /** fast = 等权三通道，不调 LLM；deep = 按查询意图换融合权重。缺省 fast */
  mode: MemorySearchMode;
}

/** Main 侧收窄后的结果：unitType 已落到闭集，unitTypeSource 是派生信息，不出现在工具参数里 */
export interface MemoryCaptureRequest {
  content: string;
  title?: string;
  unitType: UnitType;
  unitTypeSource: UnitTypeSource;
  importance: number;
  spaceId: MemoryCaptureSpace;
  eventStart?: string;
  eventEnd?: string;
  /** 看过候选后仍要写入 */
  force?: boolean;
  /** 与 evolvesRelation 成对：声明与已有记忆的版本关系 */
  evolvesFromId?: string;
  evolvesRelation?: EvolvesRelation;
}

/** 结晶：space 不由模型指定，Main 从源记忆推导（源必须同 space 且对本会话可见） */
export interface MemoryCrystallizeRequest {
  content: string;
  title: string;
  sourceIds: string[];
  force?: boolean;
}

// 部分模型把对象参数序列化成 JSON 字符串下发（同 ensoApp.ts normalizeCapabilityParams）；
// 只在能解析出对象时替换，其它原样透传给 schema 校验报错。
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeMemorySearchParams(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record) return raw;
  const limit = asNumber(record.limit);
  const space = typeof record.spaceId === 'string' ? record.spaceId.trim() : '';
  const mode = typeof record.mode === 'string' ? record.mode.trim().toLowerCase() : '';
  const dates: Partial<Record<MemorySearchDateKey, string>> = {};
  for (const key of MEMORY_SEARCH_DATE_KEYS) {
    const v = optionalText(record[key]);
    if (v) dates[key] = v;
  }
  return {
    query: typeof record.query === 'string' ? record.query : record.query,
    limit:
      limit === null
        ? MEMORY_SEARCH_DEFAULT_LIMIT
        : Math.min(MEMORY_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(limit))),
    spaceId: (MEMORY_SEARCH_SPACES as readonly string[]).includes(space) ? space : 'all',
    mode: (MEMORY_SEARCH_MODES as readonly string[]).includes(mode)
      ? (mode as MemorySearchMode)
      : 'fast',
    ...dates,
  };
}

// 归一产物必须满足工具自己声明的 schema（pi 在 prepareArguments 之后才校验，additionalProperties=false）：
// 这里只能产出 schema 里有的键。unitType 原文透传，回退与来源判定在 Main 侧 parseMemoryCaptureRequest 做。
export function normalizeMemoryCaptureParams(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record) return raw;
  const unitType = optionalText(record.unitType)?.toLowerCase();
  // agent 写入缺省 AGENT_CREATE_IMPORTANCE=0.6，与 API 缺省 0.5 不同
  const importance = asNumber(record.importance);
  const space = typeof record.spaceId === 'string' ? record.spaceId.trim() : '';
  const title = optionalText(record.title);
  const eventStart = optionalText(record.eventStart);
  const eventEnd = optionalText(record.eventEnd);
  const force = record.force === true || record.force === 'true';
  const evolvesFromId = optionalText(record.evolvesFromId);
  const evolvesRelation = optionalText(record.evolvesRelation)?.toLowerCase();
  // 部分调用端会填齐可选字段：空目标旁的合法关系枚举只是占位，须一起去掉。
  const emptyEvolutionTarget =
    typeof record.evolvesFromId === 'string' &&
    !evolvesFromId &&
    isEvolvesRelation(evolvesRelation);
  return {
    content: record.content,
    ...(title ? { title } : {}),
    ...(unitType ? { unitType } : {}),
    importance:
      importance !== null && importance >= 0 && importance <= 1
        ? importance
        : AGENT_CREATE_IMPORTANCE,
    spaceId: (MEMORY_CAPTURE_SPACES as readonly string[]).includes(space) ? space : 'project',
    ...(eventStart ? { eventStart } : {}),
    ...(eventEnd ? { eventEnd } : {}),
    ...(force ? { force } : {}),
    ...(evolvesFromId ? { evolvesFromId } : {}),
    ...(evolvesRelation && !emptyEvolutionTarget ? { evolvesRelation } : {}),
  };
}

// 模型常把数组参数写成 JSON 字串或逗号分隔；解析不出就原样透传让 schema 报错
function asIdList(value: unknown): unknown {
  let list: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        list = JSON.parse(trimmed);
      } catch {
        return value;
      }
    } else {
      list = trimmed.split(',');
    }
  }
  if (!Array.isArray(list)) return value;
  return [
    ...new Set(
      list
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean)
    ),
  ];
}

export function normalizeMemoryCrystallizeParams(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record) return raw;
  const title = optionalText(record.title);
  const force = record.force === true || record.force === 'true';
  return {
    content: record.content,
    title: title ?? record.title,
    sourceIds: asIdList(record.sourceIds),
    ...(force ? { force } : {}),
  };
}

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

/** Main 侧收窄：桥上来的载荷必须已是归一后的完整形状，否则拒绝。 */
export function parseMemorySearchRequest(value: unknown): MemorySearchRequest | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof value === 'string' ||
    !hasOnlyKeys(record, ['query', 'limit', 'spaceId', 'mode', ...MEMORY_SEARCH_DATE_KEYS]) ||
    typeof record.query !== 'string' ||
    !record.query.trim() ||
    typeof record.limit !== 'number' ||
    !Number.isInteger(record.limit) ||
    record.limit < 1 ||
    record.limit > MEMORY_SEARCH_MAX_LIMIT ||
    !(MEMORY_SEARCH_SPACES as readonly unknown[]).includes(record.spaceId) ||
    (record.mode !== undefined &&
      !(MEMORY_SEARCH_MODES as readonly unknown[]).includes(record.mode)) ||
    MEMORY_SEARCH_DATE_KEYS.some(
      (k) => record[k] !== undefined && (typeof record[k] !== 'string' || !record[k].trim())
    )
  ) {
    return null;
  }
  const out: MemorySearchRequest = {
    query: record.query,
    limit: record.limit,
    spaceId: record.spaceId as MemorySearchSpace,
    mode: record.mode === 'deep' ? 'deep' : 'fast',
  };
  for (const k of MEMORY_SEARCH_DATE_KEYS) if (typeof record[k] === 'string') out[k] = record[k];
  return out;
}

export function parseMemoryCrystallizeRequest(value: unknown): MemoryCrystallizeRequest | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof value === 'string' ||
    !hasOnlyKeys(record, ['content', 'title', 'sourceIds', 'force']) ||
    typeof record.content !== 'string' ||
    !record.content.trim() ||
    typeof record.title !== 'string' ||
    !record.title.trim() ||
    !Array.isArray(record.sourceIds) ||
    record.sourceIds.length < CRYSTAL_MIN_SOURCES ||
    !record.sourceIds.every((id) => typeof id === 'string' && id.trim()) ||
    (record.force !== undefined && typeof record.force !== 'boolean')
  ) {
    return null;
  }
  return {
    content: record.content,
    title: record.title,
    sourceIds: record.sourceIds as string[],
    ...(record.force !== undefined ? { force: record.force } : {}),
  };
}

export function parseMemoryCaptureRequest(value: unknown): MemoryCaptureRequest | null {
  const record = asRecord(value);
  if (
    !record ||
    typeof value === 'string' ||
    !hasOnlyKeys(record, [
      'content',
      'title',
      'unitType',
      'importance',
      'spaceId',
      'eventStart',
      'eventEnd',
      'force',
      'evolvesFromId',
      'evolvesRelation',
    ]) ||
    typeof record.content !== 'string' ||
    !record.content.trim() ||
    (record.title !== undefined && typeof record.title !== 'string') ||
    (record.unitType !== undefined && typeof record.unitType !== 'string') ||
    typeof record.importance !== 'number' ||
    record.importance < 0 ||
    record.importance > 1 ||
    !(MEMORY_CAPTURE_SPACES as readonly unknown[]).includes(record.spaceId) ||
    (record.eventStart !== undefined && typeof record.eventStart !== 'string') ||
    (record.eventEnd !== undefined && typeof record.eventEnd !== 'string') ||
    (record.force !== undefined && typeof record.force !== 'boolean') ||
    // 关系与目标必须成对，关系限闭集
    (record.evolvesFromId === undefined) !== (record.evolvesRelation === undefined) ||
    (record.evolvesFromId !== undefined &&
      (typeof record.evolvesFromId !== 'string' ||
        !record.evolvesFromId.trim() ||
        !isEvolvesRelation(record.evolvesRelation)))
  ) {
    return null;
  }
  // 非法 unit_type 回退 fact 记 fallback；缺省走规则默认 fact 记 default
  const rawUnit = record.unitType?.trim().toLowerCase() ?? '';
  const unitType: UnitType = isUnitType(rawUnit) ? rawUnit : DEFAULT_UNIT_TYPE;
  const unitTypeSource: UnitTypeSource = !rawUnit
    ? 'default'
    : isUnitType(rawUnit)
      ? 'explicit'
      : 'fallback';
  return {
    content: record.content,
    ...(record.title !== undefined ? { title: record.title } : {}),
    unitType,
    unitTypeSource,
    importance: record.importance,
    spaceId: record.spaceId as MemoryCaptureSpace,
    ...(record.eventStart !== undefined ? { eventStart: record.eventStart } : {}),
    ...(record.eventEnd !== undefined ? { eventEnd: record.eventEnd } : {}),
    ...(record.force !== undefined ? { force: record.force } : {}),
    ...(typeof record.evolvesFromId === 'string' && isEvolvesRelation(record.evolvesRelation)
      ? { evolvesFromId: record.evolvesFromId, evolvesRelation: record.evolvesRelation }
      : {}),
  };
}
