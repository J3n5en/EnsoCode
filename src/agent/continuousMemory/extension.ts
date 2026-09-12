import { createHash } from 'node:crypto';
import type {
  ExtensionAPI,
  InlineExtension,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { SmartCompactMode } from '@shared/smartCompactMode';
import type { SpawnModelConfig } from '@shared/types/agent';
import { createEnsoCompactFallback } from '../ensoCompact/extension';
import { formatSmartCompactSummaryModel, parseSmartCompactSummaryRef } from '../smartCompact';
import {
  buildCompactionProjection,
  buildObservationsDroppedData,
  buildObservationsRecordedData,
  buildReflectionsRecordedData,
  CARRIED_BOUNDARY_ID,
  type Entry,
  foldLedger,
  fullProjection,
  isMemoryDetails,
  isSourceEntry,
  latestCoverageIndex,
  type Observation,
  OM_OBSERVATIONS_DROPPED,
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  type Reflection,
  rawTokensSinceObservationCoverage,
  recallMemorySources,
  renderSummary,
} from './session-ledger';
import { estimateStringTokens } from './tokens';

const OBSERVE_AFTER_TOKENS = 10_000;
const REFLECT_AFTER_OBSERVATIONS = 20;
const ACTIVE_MEMORY_MAX_TOKENS = 20_000;
const ACTIVE_MEMORY_TARGET_TOKENS = 12_000;
const PRIOR_SUMMARY_MAX_TOKENS = 4_000;
const PRIOR_SUMMARY_TRUNCATED = '\n[prior history truncated]';
const MEMORY_ID = /^[a-f0-9]{12}$/;
const OBSERVER_OUTPUT_TOKENS = 4096;
const OBSERVER_PROMPT_RESERVE = 1024;
const OBSERVER_MIN_INPUT_TOKENS = 512;
const OBSERVER_BACKOFF_MS = 30_000;
const controllers = new WeakMap<object, AbortController>();
const retryAfter = new WeakMap<object, number>();

export function cancelContinuousMemory(manager: object): void {
  controllers.get(manager)?.abort();
  controllers.delete(manager);
}

export interface ContinuousMemoryOptions {
  model?: SpawnModelConfig;
  mode?: SmartCompactMode;
}

export function compactionBoundaryStart(branch: Entry[]): number {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== 'compaction') continue;
    const kept = entry.firstKeptEntryId
      ? branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId)
      : -1;
    return kept >= 0 ? kept : index + 1;
  }
  return 0;
}

/**
 * 前向携带 [0, boundaryStart) 的非 memory 压缩历史：上一压缩为 memory 时沿用其 priorSummary，
 * 否则 previousSummary 就是该历史的唯一持有者，截断到常数预算后写入 details。
 */
export function carriedPriorSummary(
  branch: Entry[],
  firstKeptEntryId: string,
  previousSummary: string | undefined
): string | undefined {
  const keptIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  const scope = keptIndex >= 0 ? branch.slice(0, keptIndex) : branch;
  for (let index = scope.length - 1; index >= 0; index--) {
    const entry = scope[index];
    if (entry.type !== 'compaction') continue;
    if (isMemoryDetails(entry.details)) return entry.details.priorSummary;
    break;
  }
  const text = previousSummary?.trim();
  if (!text) return undefined;
  if (estimateStringTokens(text) <= PRIOR_SUMMARY_MAX_TOKENS) return text;
  const limit = PRIOR_SUMMARY_MAX_TOKENS * 4 - PRIOR_SUMMARY_TRUNCATED.length;
  return `${text.slice(0, limit)}${PRIOR_SUMMARY_TRUNCATED}`;
}

export function continuousMemoryProjection(branch: Entry[], firstKeptEntryId: string) {
  const keptIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  if (keptIndex < 0) return undefined;
  const start = compactionBoundaryStart(branch);
  const projection = buildCompactionProjection(branch, firstKeptEntryId, {
    observationsPoolMaxTokens: ACTIVE_MEMORY_MAX_TOKENS,
  });
  const covered = new Set(projection.observations.flatMap((item) => item.sourceEntryIds));
  const coveredThrough = projection.details.coveredThroughEntryId;
  const coveredThroughIndex = coveredThrough
    ? branch.findIndex((entry) => entry.id === coveredThrough)
    : -1;
  const complete = branch
    .slice(start, keptIndex)
    .every(
      (entry, offset) =>
        !isSourceEntry(entry) || covered.has(entry.id) || start + offset <= coveredThroughIndex
    );
  return complete ? projection : undefined;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const item = part as { type?: string; text?: string; thinking?: string };
      return item.type === 'text'
        ? (item.text ?? '')
        : item.type === 'thinking'
          ? (item.thinking ?? '')
          : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** 模型回复只取 text 部分：thinking 里的花括号/代码围栏会让 JSON 抽取错位。 */
function responseText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      const item = part as { type?: string; text?: string } | null;
      return item?.type === 'text' ? (item.text ?? '') : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Pi 把 provider 错误包成 stopReason='error' 的空回复；不能当成“模型没说话”静默落一堆兜底观察。 */
function assertModelSucceeded(response: unknown): void {
  const item = response as { stopReason?: string; errorMessage?: string } | undefined;
  if (item?.stopReason === 'error') {
    throw new Error(item.errorMessage || 'model returned an error');
  }
}

function sourceText(entries: Entry[]): string {
  return entries
    .filter(isSourceEntry)
    .map((entry) => {
      if (entry.type === 'message') {
        const message = entry.message as { role?: string; content?: unknown } | undefined;
        return `[${entry.id}] ${message?.role ?? 'message'}: ${textOf(message?.content).slice(0, 12_000)}`;
      }
      return `[${entry.id}] ${entry.type}: ${String(entry.summary ?? entry.content ?? '').slice(0, 12_000)}`;
    })
    .join('\n\n');
}

function observerInputBudget(model: { contextWindow?: unknown }): number {
  const window =
    typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow)
      ? model.contextWindow
      : 32_000;
  return Math.max(
    OBSERVER_MIN_INPUT_TOKENS,
    window - OBSERVER_OUTPUT_TOKENS - OBSERVER_PROMPT_RESERVE
  );
}

export function chunkObservationSources(
  sources: Entry[],
  inputBudget: number
): Array<{ entries: Entry[]; text: string }> {
  const chunks: Array<{ entries: Entry[]; text: string }> = [];
  let entries: Entry[] = [];
  let texts: string[] = [];
  let tokens = 0;
  const flush = () => {
    if (!entries.length) return;
    chunks.push({ entries, text: texts.join('\n\n') });
    entries = [];
    texts = [];
    tokens = 0;
  };
  for (const entry of sources) {
    const prefix = `[${entry.id}] ${entry.type}: `;
    const raw = sourceText([entry]);
    const maxChars = Math.max(256, inputBudget * 4 - prefix.length);
    const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n[entry truncated]` : raw;
    const itemTokens = Math.ceil(text.length / 4);
    if (entries.length && tokens + itemTokens > inputBudget) flush();
    entries.push(entry);
    texts.push(text);
    tokens += Math.min(itemTokens, inputBudget);
    if (tokens >= inputBudget) flush();
  }
  flush();
  return chunks;
}

function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function idFor(kind: string, content: string, sources: string[]): string {
  return createHash('sha256')
    .update(`${kind}\0${content}\0${sources.join('\0')}`)
    .digest('hex')
    .slice(0, 12);
}

function normalizeObservations(value: unknown, allowed: Set<string>): Observation[] {
  if (!value || typeof value !== 'object') return [];
  const rows = (value as { observations?: unknown }).observations;
  if (!Array.isArray(rows)) return [];
  const out: Observation[] = [];
  for (const row of rows.slice(0, 24)) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const content =
      typeof item.content === 'string' ? item.content.trim().replace(/\s+/g, ' ') : '';
    const sourceEntryIds = Array.isArray(item.sourceEntryIds)
      ? [
          ...new Set(
            item.sourceEntryIds.filter(
              (id): id is string => typeof id === 'string' && allowed.has(id)
            )
          ),
        ]
      : [];
    if (!content || sourceEntryIds.length === 0) continue;
    const relevance = ['low', 'medium', 'high', 'critical'].includes(String(item.relevance))
      ? (item.relevance as Observation['relevance'])
      : 'medium';
    out.push({
      id: idFor('observation', content, sourceEntryIds),
      content: content.slice(0, 2_000),
      timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
      relevance,
      sourceEntryIds,
      tokenCount: Math.ceil(content.length / 4),
    });
  }
  return out;
}

function normalizeReflections(value: unknown, allowed: Set<string>): Reflection[] {
  if (!value || typeof value !== 'object') return [];
  const rows = (value as { reflections?: unknown }).reflections;
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 12).flatMap((row): Reflection[] => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const content =
      typeof item.content === 'string' ? item.content.trim().replace(/\s+/g, ' ') : '';
    const supportingObservationIds = Array.isArray(item.supportingObservationIds)
      ? [
          ...new Set(
            item.supportingObservationIds.filter(
              (id): id is string => typeof id === 'string' && allowed.has(id)
            )
          ),
        ]
      : [];
    if (!content || supportingObservationIds.length === 0) return [];
    return [
      {
        id: idFor('reflection', content, supportingObservationIds),
        content: content.slice(0, 2_000),
        supportingObservationIds,
        tokenCount: Math.ceil(content.length / 4),
      },
    ];
  });
}

function recallTool(): ToolDefinition {
  return {
    name: 'enso_memory_recall',
    label: 'Recall continuous memory evidence',
    description:
      'Recover exact current-branch source evidence for a 12-character id shown in an Enso continuous-memory summary.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-f0-9]{12}$' } },
      required: ['id'],
      additionalProperties: false,
    } as ToolDefinition['parameters'],
    async execute(_callId, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const id = (params as { id?: unknown }).id;
      if (typeof id !== 'string' || !MEMORY_ID.test(id)) throw new Error('Invalid memory id');
      if (id === CARRIED_BOUNDARY_ID) {
        return {
          content: [
            {
              type: 'text',
              text: 'This is the carried memory boundary: earlier lower-priority details were compacted away and have no single source entry. Recall a specific observation or reflection id instead.',
            },
          ],
          details: { memoryId: id, partial: false },
        };
      }
      const result = recallMemorySources(ctx.sessionManager.getBranch() as Entry[], id);
      if (result.status === 'not_found') {
        return {
          content: [{ type: 'text', text: `No continuous memory ${id} on the current branch.` }],
          details: { memoryId: id, partial: false },
        };
      }
      const sources = result.sourceEntries.map((entry) => sourceText([entry])).join('\n\n');
      return {
        content: [
          { type: 'text', text: sources || `Memory ${id} exists, but its source is unavailable.` },
        ],
        details: { memoryId: id, partial: result.partial },
      };
    },
  };
}

export function createContinuousMemoryFactory(options: ContinuousMemoryOptions = {}) {
  return (pi: ExtensionAPI) => {
    const modelRef = options.model
      ? parseSmartCompactSummaryRef(formatSmartCompactSummaryModel(options.model))
      : undefined;
    const fallback = createEnsoCompactFallback({ summaryModel: modelRef, mode: options.mode });
    const safeFallback = async (
      event: Parameters<typeof fallback>[0],
      ctx: Parameters<typeof fallback>[1]
    ) => {
      if (event.signal.aborted) return undefined;
      try {
        return await fallback(event, ctx);
      } catch (error) {
        console.warn('[continuous-memory] Enso fallback failed:', error);
        return { cancel: true } as const;
      }
    };
    let generation = 0;
    let inFlight = false;
    let controller = new AbortController();
    const bindController = (manager: object) => {
      if (controller.signal.aborted) controller = new AbortController();
      controllers.set(manager, controller);
    };

    const currentBranch = (manager: { getBranch(): unknown }) => manager.getBranch() as Entry[];
    const stillCurrent = (
      manager: { getBranch(): unknown },
      requiredEntryIds: readonly string[],
      run: number,
      signal: AbortSignal
    ) => {
      const ids = new Set(currentBranch(manager).map((entry) => entry.id));
      return !signal.aborted && run === generation && requiredEntryIds.every((id) => ids.has(id));
    };

    pi.registerTool(recallTool());
    pi.on('session_shutdown', () => {
      generation++;
      controller.abort();
    });
    pi.on('turn_end', (_event, ctx) => {
      if (inFlight || (retryAfter.get(ctx.sessionManager) ?? 0) > Date.now()) return;
      bindController(ctx.sessionManager);
      const branch = currentBranch(ctx.sessionManager);
      if (rawTokensSinceObservationCoverage(branch) < OBSERVE_AFTER_TOKENS) return;
      const sources = branch.slice(latestCoverageIndex(branch) + 1).filter(isSourceEntry);
      const run = generation;
      const signal = controller.signal;
      const model = modelRef ? ctx.modelRegistry.find(modelRef.provider, modelRef.id) : ctx.model;
      if (!model || sources.length === 0) return;
      inFlight = true;
      void (async () => {
        try {
          for (const chunk of chunkObservationSources(sources, observerInputBudget(model))) {
            const sourceIds = chunk.entries.map((entry) => entry.id);
            if (!stillCurrent(ctx.sessionManager, sourceIds, run, signal)) return;
            const prompt = `Extract factual observations from this session segment. Return JSON only: {"observations":[{"content":"single line","relevance":"low|medium|high|critical","sourceEntryIds":["exact ids"]}]}. Every exact source id must be represented by at least one observation. Preserve decisions, constraints, outcomes and unresolved work.\n\n${chunk.text}`;
            const response = await ctx.modelRegistry.complete(
              model,
              {
                messages: [
                  {
                    role: 'user',
                    content: [{ type: 'text', text: prompt }],
                    timestamp: Date.now(),
                  },
                ],
              },
              { signal, maxTokens: OBSERVER_OUTPUT_TOKENS }
            );
            assertModelSucceeded(response);
            const observations = normalizeObservations(
              parseJson(responseText(response?.content)),
              new Set(sourceIds)
            );
            const represented = new Set(observations.flatMap((item) => item.sourceEntryIds));
            for (const entry of chunk.entries) {
              if (represented.has(entry.id)) continue;
              const content = `Unstructured source retained: ${sourceText([entry]).slice(0, 800)}`;
              observations.push({
                id: idFor('observation', content, [entry.id]),
                content,
                timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
                relevance: 'low',
                sourceEntryIds: [entry.id],
                tokenCount: Math.ceil(content.length / 4),
              });
            }
            if (!stillCurrent(ctx.sessionManager, sourceIds, run, signal)) return;
            const coversUpToId = sourceIds.at(-1);
            const data = coversUpToId
              ? buildObservationsRecordedData(observations, coversUpToId)
              : undefined;
            if (data) pi.appendEntry(OM_OBSERVATIONS_RECORDED, data);
          }
          retryAfter.delete(ctx.sessionManager);
          const coversUpToId = sources.at(-1)?.id;
          const memory = fullProjection(currentBranch(ctx.sessionManager));
          if (coversUpToId && memory.observations.length >= REFLECT_AFTER_OBSERVATIONS) {
            const allowed = new Set(memory.observations.map((item) => item.id));
            const reflectionInput = memory.observations
              .map((item) => `[${item.id}] ${item.content}`)
              .join('\n')
              .slice(-observerInputBudget(model) * 4);
            const reflected = await ctx.modelRegistry.complete(
              model,
              {
                messages: [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: `Return JSON only: {"reflections":[{"content":"durable single-line conclusion","supportingObservationIds":["ids"]}]}. Distill stable constraints, decisions and preferences.\n\n${reflectionInput}`,
                      },
                    ],
                    timestamp: Date.now(),
                  },
                ],
              },
              { signal, maxTokens: 2048 }
            );
            assertModelSucceeded(reflected);
            const reflectionData = buildReflectionsRecordedData(
              normalizeReflections(parseJson(responseText(reflected?.content)), allowed),
              coversUpToId
            );
            if (
              reflectionData &&
              stillCurrent(
                ctx.sessionManager,
                sources.map((item) => item.id),
                run,
                signal
              )
            ) {
              pi.appendEntry(OM_REFLECTIONS_RECORDED, reflectionData);
            }
          }

          const folded = foldLedger(currentBranch(ctx.sessionManager));
          let total = folded.activeObservations.reduce((sum, item) => sum + item.tokenCount, 0);
          if (coversUpToId && total > ACTIVE_MEMORY_MAX_TOKENS) {
            const dropped: Observation[] = [];
            for (const item of folded.activeObservations) {
              if (total <= ACTIVE_MEMORY_TARGET_TOKENS) break;
              dropped.push(item);
              total -= item.tokenCount;
            }
            const indexes = new Map(
              currentBranch(ctx.sessionManager).map((entry, index) => [entry.id, index])
            );
            const coveredThroughEntryId = dropped
              .flatMap((item) => item.sourceEntryIds)
              .reduce<string | undefined>((latest, id) => {
                if (!latest) return id;
                return (indexes.get(id) ?? -1) > (indexes.get(latest) ?? -1) ? id : latest;
              }, undefined);
            if (!coveredThroughEntryId) return;
            const sourceEntryIds = [coveredThroughEntryId];
            const compacted: Observation = {
              id: idFor(
                'observation',
                'Earlier observations compacted; recall exact evidence.',
                sourceEntryIds
              ),
              content: 'Earlier observations compacted; recall exact evidence.',
              timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
              relevance: 'high',
              sourceEntryIds,
              tokenCount: 24,
            };
            const compactedData = buildObservationsRecordedData([compacted], coversUpToId);
            const droppedData = buildObservationsDroppedData(
              dropped.map((item) => item.id),
              coversUpToId
            );
            if (
              compactedData &&
              droppedData &&
              stillCurrent(
                ctx.sessionManager,
                sources.map((item) => item.id),
                run,
                signal
              )
            ) {
              pi.appendEntry(OM_OBSERVATIONS_RECORDED, compactedData);
              pi.appendEntry(OM_OBSERVATIONS_DROPPED, droppedData);
            }
          }
        } catch (error) {
          if (!signal.aborted) {
            retryAfter.set(ctx.sessionManager, Date.now() + OBSERVER_BACKOFF_MS);
            console.warn('[continuous-memory] background update failed:', error);
          }
        } finally {
          if (run === generation) inFlight = false;
        }
      })();
    });

    pi.on('session_before_compact', async (event, ctx) => {
      if (event.signal.aborted) return;
      try {
        bindController(ctx.sessionManager);
        const branch = event.branchEntries as Entry[];
        const projection = continuousMemoryProjection(branch, event.preparation.firstKeptEntryId);
        if (!projection) return await safeFallback(event, ctx);
        const body = renderSummary(projection.reflections, projection.observations);
        if (!body || estimateStringTokens(body) > ACTIVE_MEMORY_MAX_TOKENS) {
          return await safeFallback(event, ctx);
        }
        const priorSummary = carriedPriorSummary(
          branch,
          event.preparation.firstKeptEntryId,
          event.preparation.previousSummary
        );
        const summary = priorSummary
          ? `## Prior compacted history\n${priorSummary}\n\n${body}`
          : body;
        const { priorSummary: _carried, ...rest } = projection.details;
        const details = priorSummary ? { ...rest, priorSummary } : rest;
        return {
          compaction: {
            summary: summary.replaceAll('recall tool', 'enso_memory_recall tool'),
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details,
          },
        };
      } catch (error) {
        console.warn('[continuous-memory] compaction failed, using Enso fallback:', error);
        if (event.signal.aborted) return;
        return await safeFallback(event, ctx);
      }
    });
  };
}

export function continuousMemoryInlineExtension(
  options?: ContinuousMemoryOptions
): InlineExtension {
  return {
    name: 'enso-continuous-memory',
    hidden: true,
    factory: createContinuousMemoryFactory(options),
  };
}
