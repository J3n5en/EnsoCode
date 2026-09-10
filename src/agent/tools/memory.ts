import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ChildSessionIdentity } from '@shared/builtinAgents';
import { CRYSTAL_MIN_SOURCES, EVOLVES_RELATIONS, UNIT_TYPES } from '@shared/memory/constants';
import {
  MEMORY_CAPTURE_SPACES,
  MEMORY_SEARCH_MAX_LIMIT,
  MEMORY_SEARCH_MODES,
  MEMORY_SEARCH_SPACES,
  normalizeMemoryCaptureParams,
  normalizeMemoryCrystallizeParams,
  normalizeMemorySearchParams,
} from '@shared/memory/toolParams';
import type { MemoryOp, SessionIdentity } from '@shared/types/agent';

export interface MemoryInvokeRequest {
  identity: SessionIdentity | ChildSessionIdentity;
  requestId: string;
  op: MemoryOp;
  params: unknown;
}

export interface MemoryInvokeResult {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

// 本地 SQLite 查询远快于浏览器动作，但 Main 可能正忙于首次建库 / WAL 恢复
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * worker ↔ Main 的记忆库挂起调用表（同 BrowserInvoker 范式）。请求经 `memory-invoke` 事件上抛，
 * 结果经 `memory-result` 命令回落；abort / 超时 / shutdown 全部 fail-closed。
 */
export class MemoryInvoker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly identity: SessionIdentity | ChildSessionIdentity,
    private readonly emit: (request: MemoryInvokeRequest) => void,
    private readonly options: { timeoutMs?: number } = {}
  ) {}

  invoke(op: MemoryOp, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('Memory action aborted'));
    const requestId = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(
      () => settle(new Error(`Memory action ${op} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    const onAbort = () => settle(new Error('Memory action aborted'));
    const settle = (outcome: unknown) => {
      if (!this.pending.delete(requestId)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    this.pending.set(requestId, { resolve: settle, reject: settle });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.emit({ identity: this.identity, requestId, op, params });
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  /** Main 回落；未知 requestId 返回 false（已超时 / 已取消）。 */
  resolve(result: MemoryInvokeResult): boolean {
    const entry = this.pending.get(result.requestId);
    if (!entry) return false;
    if (result.ok) entry.resolve(result.result);
    else entry.reject(new Error(result.error || 'Memory action failed'));
    return true;
  }

  cancelAll(reason = 'Memory action cancelled'): void {
    for (const entry of [...this.pending.values()]) entry.reject(new Error(reason));
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

const schema = (
  properties: Record<string, unknown>,
  required: string[]
): ToolDefinition['parameters'] =>
  ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }) as unknown as ToolDefinition['parameters'];

const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: undefined,
});

const requireText = (params: Record<string, unknown>, key: string): void => {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
};

/**
 * 记忆工具：库在 Main，这里只发请求收结果。schema 每个属性都声明 type（不同模型对未声明类型的
 * 猜测不一致）；归一在 prepareArguments 里、schema 校验之前完成，execute 再兜底一次给直接调用路径。
 */
/** 记忆存储语言 → 给模型的检索指引。存储语言与提问语言不一致时 FTS 通道会整条哑火，必须说清楚 */
function languageHint(language: string | undefined): string {
  const label =
    language === 'zh' ? 'Chinese' : language === 'auto' ? "the user's own language" : 'English';
  return (
    ` Memories are written in ${label}, which may differ from the conversation language: ` +
    'phrase the query the same way the memory would be written, and always keep proper nouns and ' +
    'technical terms verbatim (Postgres, Kubernetes, a file name) — those match across languages.'
  );
}

export function createMemoryTools(
  invoker: MemoryInvoker,
  opts: { language?: string } = {}
): ToolDefinition[] {
  const define = (
    name: string,
    label: string,
    description: string,
    parameters: ToolDefinition['parameters'],
    op: MemoryOp,
    normalize: (raw: unknown) => unknown,
    requiredKey: string
  ): ToolDefinition => ({
    name,
    label,
    description,
    parameters,
    prepareArguments: normalize as unknown as ToolDefinition['prepareArguments'],
    async execute(_toolCallId, params, signal) {
      const normalized = normalize(params ?? {});
      if (!normalized || typeof normalized !== 'object') throw new Error('invalid arguments');
      requireText(normalized as Record<string, unknown>, requiredKey);
      return textResult(await invoker.invoke(op, normalized, signal));
    },
  });

  return [
    define(
      'memory_search',
      'Memory search',
      'Search long-term memories (decisions, preferences, procedures, lessons, facts) captured in ' +
        'earlier sessions. Use it when the user refers to something decided or learned before, when ' +
        'starting work in a project to recall prior context, or before proposing an approach that ' +
        'may already have been settled. Implicit references count: "that approach", "like last time", ' +
        'or a problem that resembles one solved before. Skip it for genuinely new topics, generic ' +
        'language/syntax questions, or when the user explicitly wants a fresh take; a search that ' +
        'returns nothing relevant costs a round trip. Results are ranked by relevance and recency; only the latest ' +
        'version of each memory is returned. Two independent time filters exist: eventDate* filters by ' +
        'WHEN THE EVENT HAPPENED (e.g. "the 2020 migration"), recordedDate* filters by WHEN THE MEMORY ' +
        'WAS SAVED (e.g. "what did we note last month"). Use one family per call, never both. ' +
        'mode=fast (default) is vector + full-text + entity + 1-hop related-entity (community) with equal fusion weights and no extra LLM. ' +
        'mode=deep uses the same recall channels but reweights fusion by query intent (keyword vs conceptual vs relationship); ' +
        'it does not rewrite the query and does not use HyDE. Skip deep for named-thing lookups. ' +
        'Deep may also run a short-timeout LLM to classify intent and rerank up to 8 hits; failures fall back.' +
        languageHint(opts.language),
      schema(
        {
          query: { type: 'string', description: 'Natural-language query or keywords' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MEMORY_SEARCH_MAX_LIMIT,
            description: 'Max results (default 10)',
          },
          spaceId: {
            type: 'string',
            enum: [...MEMORY_SEARCH_SPACES],
            description:
              "'all' = global + current project (default); 'global' = cross-project only; 'project' = current project only",
          },
          eventDateFrom: {
            type: 'string',
            description:
              'Earliest date the remembered event happened: YYYY, YYYY-MM or YYYY-MM-DD. Cannot be combined with recordedDate*',
          },
          eventDateTo: {
            type: 'string',
            description:
              'Latest date the remembered event happened (inclusive; YYYY covers the whole year). Cannot be combined with recordedDate*',
          },
          recordedDateFrom: {
            type: 'string',
            description:
              'Earliest date the memory was saved: YYYY, YYYY-MM or YYYY-MM-DD. Cannot be combined with eventDate*',
          },
          recordedDateTo: {
            type: 'string',
            description:
              'Latest date the memory was saved (inclusive). Cannot be combined with eventDate*',
          },
          mode: {
            type: 'string',
            enum: [...MEMORY_SEARCH_MODES],
            description:
              "'fast' (default) = equal-weight vector/FTS/entity, no extra LLM; 'deep' = same recall, intent-weighted fusion",
          },
        },
        ['query']
      ),
      'search',
      normalizeMemorySearchParams,
      'query'
    ),
    define(
      'memory_capture',
      'Memory capture',
      'Save one durable, distilled memory for future sessions. Use it when the user states a ' +
        'standing preference or constraint, when a decision is made (including rejected ' +
        'alternatives and why), when a reusable procedure or a hard-won lesson emerges, or when the ' +
        'user asks you to remember something. The best moment is right after something resolves: a ' +
        'root cause is found, a trade-off is settled, an assumption turns out wrong. Write 1-3 ' +
        'sentences capturing WHAT and WHY, self-contained enough to be useful months later. Do NOT ' +
        'capture routine fixes, work still in progress, simple Q&A, or anything a search engine ' +
        'would answer; never store raw chat transcripts or transient task chatter. A typical ' +
        'session yields at most 1-3 memories. If the result is ' +
        "status='candidates_found', NOTHING was written: similar memories already exist. Either drop " +
        'the capture, resubmit with evolvesFromId + evolvesRelation to record how it relates to one ' +
        'of them, or resubmit with force=true to store it as a separate memory.',
      schema(
        {
          content: {
            type: 'string',
            description: 'The memory itself: specific, self-contained, with reasoning',
          },
          title: {
            type: 'string',
            description: 'Short title, max 80 chars (derived from content if omitted)',
          },
          unitType: {
            type: 'string',
            description:
              `One of ${UNIT_TYPES.join('|')}. fact=objective statement; preference=standing taste/constraint; ` +
              'decision=committed choice; plan=future intent; procedure=reusable how-to; learning=lesson ' +
              'without a runbook; context=background; event=time-bounded happening. Defaults to fact.',
          },
          importance: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description:
              '0.9+ critical decision/insight; 0.7-0.9 important; 0.5-0.7 useful (default 0.6)',
          },
          spaceId: {
            type: 'string',
            enum: [...MEMORY_CAPTURE_SPACES],
            description:
              "'project' = only relevant to the current project (default); 'global' = applies across all projects (e.g. user preferences)",
          },
          eventStart: {
            type: 'string',
            description: 'Only if the memory is about a dated event: YYYY, YYYY-MM or YYYY-MM-DD',
          },
          eventEnd: {
            type: 'string',
            description: 'End of the event range, same formats as eventStart',
          },
          force: {
            type: 'boolean',
            description:
              'Only after a candidates_found result: store anyway as a separate memory (default false)',
          },
          evolvesFromId: {
            type: 'string',
            description:
              'Id of an existing memory this one evolves from (from candidates_found or memory_search); requires evolvesRelation. ' +
              'Omit both evolves* fields for a new memory. An empty id means no evolution.',
          },
          evolvesRelation: {
            type: 'string',
            enum: [...EVOLVES_RELATIONS],
            description:
              'Only with a non-empty evolvesFromId; a valid relation paired with an empty id is ignored. ' +
              'replaces = supersedes the old memory (it stops being latest); enriches = adds detail; ' +
              'confirms = restates it; challenges = contradicts it (both stay latest, flagged for review)',
          },
        },
        ['content']
      ),
      'capture',
      normalizeMemoryCaptureParams,
      'content'
    ),
    define(
      'memory_crystallize',
      'Memory crystallize',
      `Consolidate ${CRYSTAL_MIN_SOURCES} or more related existing memories into one higher-level ` +
        'memory (a "crystal"). Use it only when a memory_search has returned several memories that ' +
        'clearly belong to the same topic AND a synthesis would say something none of them says alone ' +
        '(a pattern, a rule, a consolidated procedure). Do not use it to restate a single memory, to ' +
        'summarize the current conversation, or as a routine step after every search; most sessions ' +
        'never need it. The sources stay intact and searchable; the crystal is ranked above them. ' +
        "If the result is status='candidates_found', NOTHING was written: a similar memory already " +
        'exists. Drop it, or resubmit with force=true only if the crystal genuinely adds information.',
      schema(
        {
          sourceIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: CRYSTAL_MIN_SOURCES,
            description: `Ids of at least ${CRYSTAL_MIN_SOURCES} distinct existing memories (from memory_search) that the crystal is synthesized from; all must be in the same space (all global, or all current project)`,
          },
          title: {
            type: 'string',
            description: 'Short title of the synthesized knowledge, max 80 chars',
          },
          content: {
            type: 'string',
            description:
              'The synthesis itself: 2-5 sentences stating the higher-level conclusion and why it holds, more informative than any single source',
          },
          force: {
            type: 'boolean',
            description: 'Only after a candidates_found result: store anyway (default false)',
          },
        },
        ['sourceIds', 'title', 'content']
      ),
      'crystallize',
      normalizeMemoryCrystallizeParams,
      'content'
    ),
  ];
}
