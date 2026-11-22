import { rmSync } from 'node:fs';
import path from 'node:path';
import type { EmbeddingDownloadProgressDto, EmbeddingModelDto } from '@shared/memory/dto';
import { userDataPath } from './appPaths';
import {
  cancelModelDownload,
  downloadedBytes,
  downloadModel,
  isModelDownloading,
  isModelReady,
  subscribeModelDownloads,
} from './memory/embedding/downloader';
import {
  embeddingModelDirName,
  listEmbeddingModelSpecs,
  resolveEmbeddingModelSpec,
} from './memory/embedding/registry';
import type { EmbeddingModelSpec } from './memory/embedding/types';

/**
 * 嵌入模型的显式下载管理。`memoryHost` 的 autoDownload 是「用到时顺手拉」，
 * 这里是设置页主动触发的那条路径：可看状态、可取消、可删除。两者共用同一缓存目录。
 */

type ProgressSink = (progress: EmbeddingDownloadProgressDto) => void;

interface DownloadTask {
  controller: AbortController;
  settled: Promise<void>;
}

const running = new Map<string, DownloadTask>();
let sink: ProgressSink | null = null;
let unsubscribeDownloads: (() => void) | null = null;

/** 由接线层注入，用于把进度推给设置窗；未注入时下载静默进行 */
export function setEmbeddingProgressSink(next: ProgressSink | null): void {
  unsubscribeDownloads?.();
  sink = next;
  unsubscribeDownloads = next
    ? subscribeModelDownloads((event) => {
        const spec = resolveEmbeddingModelSpec(event.modelId);
        const { dir, ...progress } = event;
        if (!spec || dir !== path.resolve(modelDir(spec)) || running.has(spec.id)) return;
        sink?.(progress);
      })
    : null;
}

function modelDir(spec: EmbeddingModelSpec): string {
  return path.join(userDataPath(), 'memory', 'models', embeddingModelDirName(spec));
}

function toDto(spec: EmbeddingModelSpec): EmbeddingModelDto {
  const downloadable = spec.files.length > 0;
  const dir = downloadable ? modelDir(spec) : '';
  const ready = downloadable ? isModelReady(dir, spec) : true;
  return {
    id: spec.id,
    runtime: spec.runtime,
    dim: spec.dim,
    approxBytes: spec.approxBytes,
    downloadedBytes: downloadable ? downloadedBytes(dir, spec) : 0,
    state: !downloadable
      ? 'unavailable'
      : running.has(spec.id) || isModelDownloading(dir)
        ? 'downloading'
        : ready
          ? 'ready'
          : 'missing',
    downloadable,
  };
}

export function listEmbeddingModels(): EmbeddingModelDto[] {
  return listEmbeddingModelSpecs().map(toDto);
}

/** 下载中拒绝重复启动；已取消的任务先等它退出，再重新下载。 */
export async function startEmbeddingModelDownload(modelId: string): Promise<boolean> {
  const spec = resolveEmbeddingModelSpec(modelId);
  const previous = running.get(modelId);
  if (!spec || spec.files.length === 0) return false;
  if (previous && !previous.controller.signal.aborted) return false;
  const controller = new AbortController();
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const task = { controller, settled };
  running.set(modelId, task);
  const isCurrent = () => running.get(modelId) === task;
  let error: string | undefined;
  try {
    // Abort 只是请求取消；旧流/退避完全结束前不能让新任务碰同一个 .part。
    await previous?.settled;
    controller.signal.throwIfAborted();
    await downloadModel(spec, modelDir(spec), {
      signal: controller.signal,
      onProgress: (p) => {
        if (isCurrent() && !controller.signal.aborted) sink?.({ modelId, ...p });
      },
    });
    controller.signal.throwIfAborted();
    return true;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    return false;
  } finally {
    const current = isCurrent();
    if (current) running.delete(modelId);
    settle();
    // sink 内可能立刻刷新列表；显式与共享 registry 都释放后才发布终态。
    if (current && !isModelDownloading(modelDir(spec))) {
      sink?.({
        modelId,
        file: '',
        fileIndex: 0,
        fileCount: 0,
        received: 0,
        total: null,
        done: true,
        error,
      });
    }
  }
}

export function cancelEmbeddingModelDownload(modelId: string): boolean {
  const spec = resolveEmbeddingModelSpec(modelId);
  if (!spec || spec.files.length === 0) return false;
  const cancelled = cancelModelDownload(modelDir(spec));
  const task = running.get(modelId);
  if (!task || task.controller.signal.aborted) return cancelled;
  task.controller.abort();
  return true;
}

/** 同步删除接口：下载未退出时只请求取消并返回 false，待退出后可重试删除。 */
export function deleteEmbeddingModel(modelId: string): boolean {
  const spec = resolveEmbeddingModelSpec(modelId);
  if (!spec || spec.files.length === 0) return false;
  cancelEmbeddingModelDownload(modelId);
  if (running.has(modelId) || isModelDownloading(modelDir(spec))) return false;
  try {
    rmSync(modelDir(spec), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
