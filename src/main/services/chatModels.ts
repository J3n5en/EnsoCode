import { rmSync } from 'node:fs';
import path from 'node:path';
import { app } from '@platform';
import type { ChatModelDto, EmbeddingDownloadProgressDto } from '@shared/memory/dto';
import { releaseLocalChatSlot } from './llama/chat';
import {
  type ChatModelSpec,
  chatModelDir,
  listChatModelSpecs,
  resolveChatModelSpec,
} from './llama/chatModels';
import { downloadedBytes, downloadModel, isModelReady } from './memory/embedding/downloader';

/**
 * 本地 chat 模型的显式下载管理。与 memoryModels.ts 同层同模式：
 * 设置页只传 id，路径由 Main 按注册表推导。
 */

type ProgressSink = (progress: EmbeddingDownloadProgressDto) => void;

interface DownloadTask {
  controller: AbortController;
  settled: Promise<void>;
}

const running = new Map<string, DownloadTask>();
const deleting = new Set<string>();
let sink: ProgressSink | null = null;
let rootOverride: string | null = null;

export function setChatModelProgressSink(next: ProgressSink | null): void {
  sink = next;
}

/** 仅供测试：指向临时目录，不碰真实 userData */
export function __setChatModelsRootForTest(root: string | null): void {
  rootOverride = root;
}

function modelsRoot(): string {
  return rootOverride ?? path.join(app.getPath('userData'), 'memory', 'chat-models');
}

function modelDir(spec: ChatModelSpec): string {
  return chatModelDir(modelsRoot(), spec);
}

function toDto(spec: ChatModelSpec): ChatModelDto {
  const downloadable = spec.files.length > 0;
  const dir = downloadable ? modelDir(spec) : '';
  const ready = downloadable ? isModelReady(dir, spec) : true;
  return {
    id: spec.id,
    label: spec.label,
    params: spec.params,
    contextSize: spec.contextSize,
    approxBytes: spec.approxBytes,
    downloadedBytes: downloadable ? downloadedBytes(dir, spec) : 0,
    state: !downloadable
      ? 'ready'
      : running.has(spec.id)
        ? 'downloading'
        : ready
          ? 'ready'
          : 'missing',
    downloadable,
  };
}

export function listChatModels(): ChatModelDto[] {
  return listChatModelSpecs().map(toDto);
}

export function chatModelsRoot(): string {
  return modelsRoot();
}

export async function startChatModelDownload(modelId: string): Promise<boolean> {
  const spec = resolveChatModelSpec(modelId);
  const previous = running.get(modelId);
  if (!spec || spec.files.length === 0 || deleting.has(modelId)) return false;
  if (previous && !previous.controller.signal.aborted) return false;
  const controller = new AbortController();
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const task = { controller, settled };
  running.set(modelId, task);
  const isCurrent = () => running.get(modelId) === task;
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
    sink?.({ modelId, file: '', fileIndex: 0, fileCount: 0, received: 0, total: null, done: true });
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    sink?.({
      modelId,
      file: '',
      fileIndex: 0,
      fileCount: 0,
      received: 0,
      total: null,
      done: true,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    if (isCurrent()) running.delete(modelId);
    settle();
  }
}

export function cancelChatModelDownload(modelId: string): boolean {
  const task = running.get(modelId);
  if (!task || task.controller.signal.aborted) return false;
  task.controller.abort();
  return true;
}

/** 删除已下载权重；正在下载的先取消。必须等 KV/模型槽释放完再 rm，否则 Windows 上 mmap 会让删除失败。 */
export async function deleteChatModel(modelId: string): Promise<boolean> {
  const spec = resolveChatModelSpec(modelId);
  if (!spec || spec.files.length === 0 || deleting.has(modelId)) return false;
  deleting.add(modelId);
  const task = running.get(modelId);
  cancelChatModelDownload(modelId);
  try {
    await task?.settled;
    await releaseLocalChatSlot();
    rmSync(modelDir(spec), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    deleting.delete(modelId);
  }
}
