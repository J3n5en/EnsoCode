import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import type { SmartCompactMode } from '@shared/smartCompactMode';
import type { SpawnModelConfig } from '@shared/types/agent';
import { createEnsoCompactFallback } from '../ensoCompact/extension';
import type { EnsoCompactOptions } from '../ensoCompact/types';
import { formatSmartCompactSummaryModel, parseSmartCompactSummaryRef } from '../smartCompact';
import { registerCompactionTrigger } from './vendor/hooks/compaction-trigger.js';
import { registerConsolidationTrigger } from './vendor/hooks/consolidation-trigger.js';
import { Runtime } from './vendor/runtime.js';
import {
  buildCompactionProjection,
  type Entry,
  renderSummary,
} from './vendor/session-ledger/index.js';
import { registerRecallTool } from './vendor/tools/recall-observation.js';

export interface ContinuousMemoryOptions {
  model?: SpawnModelConfig;
  mode?: SmartCompactMode;
  /** 与已打开会话共享；有它时压缩读最新摘要模型，不在装载时冻结 */
  compact?: EnsoCompactOptions;
}

/** 上游 consolidation 无跨会话 abort 句柄；关机路径仍调用以保持 supervisor 签名。 */
export function cancelContinuousMemory(_manager: object): void {}

function overlayEnsoModel(runtime: Runtime, compact: EnsoCompactOptions): void {
  const ensure = runtime.ensureConfig.bind(runtime);
  runtime.ensureConfig = (cwd: string) => {
    ensure(cwd);
    const ref = compact.summaryModel;
    runtime.config.model = ref
      ? { provider: ref.provider, id: ref.id, thinking: 'low' }
      : undefined;
  };
}

function registerEnsoCompactionHook(
  pi: ExtensionAPI,
  runtime: Runtime,
  fallback: ReturnType<typeof createEnsoCompactFallback>
): void {
  pi.on('session_before_compact', async (event, ctx) => {
    if (event.signal.aborted) return;
    if (runtime.compactHookInFlight) {
      return await fallback(event, ctx);
    }
    runtime.compactHookInFlight = true;
    try {
      runtime.ensureConfig(ctx.cwd);
      const { firstKeptEntryId, tokensBefore } = event.preparation;
      const projection = buildCompactionProjection(
        event.branchEntries as Entry[],
        firstKeptEntryId,
        {
          observationsPoolMaxTokens: runtime.config.observationsPoolMaxTokens,
          reflectionsPoolMaxTokens: runtime.config.reflectionsPoolMaxTokens,
        }
      );
      const summary = renderSummary(projection.reflections, projection.observations);
      if (!summary) return await fallback(event, ctx);
      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
          details: projection.details,
        },
      };
    } catch (error) {
      console.warn('[continuous-memory] upstream compact failed, using Enso fallback:', error);
      if (event.signal.aborted) return;
      try {
        return await fallback(event, ctx);
      } catch (fallbackError) {
        console.warn('[continuous-memory] Enso fallback failed:', fallbackError);
        return { cancel: true } as const;
      }
    } finally {
      runtime.compactHookInFlight = false;
    }
  });
}

export function createContinuousMemoryFactory(options: ContinuousMemoryOptions = {}) {
  return (pi: ExtensionAPI) => {
    const compact = options.compact ?? {
      mode: options.mode,
      summaryModel: options.model
        ? parseSmartCompactSummaryRef(formatSmartCompactSummaryModel(options.model))
        : undefined,
    };
    const fallback = createEnsoCompactFallback(compact);
    const runtime = new Runtime();
    overlayEnsoModel(runtime, compact);
    registerConsolidationTrigger(pi, runtime);
    registerCompactionTrigger(pi, runtime);
    registerEnsoCompactionHook(pi, runtime, fallback);
    registerRecallTool(pi);
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
