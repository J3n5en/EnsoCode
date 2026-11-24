/**
 * 记忆子系统的 Main 侧门面。
 *
 * 修复前 memory.db（better-sqlite3 同步 API）与 GGUF embedding/chat 都在
 * Main 主线程执行：一次 memory_search 的实体 instr 全扫 + 社区扩展 +
 * 开库迁移 + 模型加载能把事件循环卡到秒级，整个界面无响应。
 * 现在所有库操作与本地推理都在 enso-memory-service 这个 utilityProcess 里跑，
 * 本文件只做：配置收窄与推送、op 转发、LLM 远程补全代发、变更广播。
 * 服务崩溃 / 超时会自动重起（下一个 op 重新 fork）。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from '@platform';
import type { ChildSessionIdentity, SessionIdentity } from '@shared/builtinAgents';
import { normalizeLocale, translate } from '@shared/i18n';
import type { ForgettingSettings } from '@shared/memory/forgetting';
import { normalizeMemoryModelIdleMinutes } from '@shared/memory/modelIdle';
import { remoteEmbeddingIssue, remoteEmbeddingIssueMessage } from '@shared/memory/remoteEmbedding';
import { parseProviderProxy } from '@shared/providers/providerProxy';
import type { MemoryOp } from '@shared/types/agent';
import type { ModelProvider } from '@shared/types/llm';
import type { Complete, DistillJob } from './memory/distill';
import { DEFAULT_EMBEDDING_MODEL_ID, resolveEmbeddingModelSpec } from './memory/embedding/registry';
import type { RemoteEmbeddingOptions } from './memory/embedding/remote';
import { remoteModelName } from './memory/embedding/remote';
import type { ForgettingRunSummary } from './memory/forgetting';
import type { KgJob } from './memory/kg';
import type { ManualEditResult } from './memory/manual';
import type { ReconcileSummary } from './memory/reconcile';
import type { ReembedJob } from './memory/reembed';
import type { MemorySpaceContext } from './memory/space';
import { MemoryServiceClient } from './memoryServiceClient';
import type {
  MemoryDistillConfig,
  MemoryEmbeddingConfig,
  MemoryKgConfig,
} from './memoryServiceCore';

let onMemoryChanged: (() => void) | null = null;
let llmResolver: (() => Promise<Complete | null>) | null = null;

export function setMemoryChangeListener(listener: (() => void) | null): void {
  onMemoryChanged = listener;
}

/** ipc/agent 注入蒸馏 LLM 链（remoteComplete → completeText），服务经 RPC 调用 */
export function setMemoryLlmResolver(resolver: (() => Promise<Complete | null>) | null): void {
  llmResolver = resolver;
}

function memoryRoot(): string {
  return path.join(app.getPath('userData'), 'memory');
}

let downloadProgressSink: ((progress: unknown) => void) | null = null;

/** 设置页下载进度转发（embedding 与 chat 模型共用一个 sink 区分模型 id） */
export function setMemoryServiceProgressSink(sink: ((progress: unknown) => void) | null): void {
  downloadProgressSink = sink;
}

async function readTranscriptMain(sessionFile: string): Promise<unknown> {
  const [{ SessionManager, sessionEntryToContextMessages }, { projectMessage }] = await Promise.all(
    [import('@earendil-works/pi-coding-agent'), import('../../agent/projection')]
  );
  const root = path.resolve(path.join(app.getPath('userData'), 'agent', 'sessions'));
  const resolved = path.resolve(sessionFile);
  if (!resolved.startsWith(`${root}${path.sep}`)) return [];
  const branch = SessionManager.open(resolved, root).getBranch();
  const out: { role: 'user' | 'assistant'; text: string; entryId?: string }[] = [];
  for (const entry of branch) {
    for (const raw of sessionEntryToContextMessages(entry)) {
      const m = projectMessage(raw);
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const text = (m.content as { type: string; text?: string }[])
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n');
      if (text.trim()) out.push({ role: m.role, text, entryId: entry.id });
    }
  }
  return out;
}

const client = new MemoryServiceClient({
  memoryRoot,
  sessionDir: () => path.join(app.getPath('userData'), 'agent', 'sessions'),
  onChanged: () => {
    try {
      onMemoryChanged?.();
    } catch {}
  },
  onDownloadProgress: (progress) => downloadProgressSink?.(progress),
  llmResolver: async () => (await llmResolver?.()) ?? null,
  transcriptReader: readTranscriptMain,
  log: (level, message) => console[level](message),
});

/** 测试 / 诊断用：当前服务进程是否活着 */
export function memoryServiceAlive(): boolean {
  return client.alive();
}

/**
 * 库不存在时不建库（旧 openExistingMemoryDb 语义）：读类 op 返回调用方给的 fallback。
 * 写类调用方自行处理 { missing: true } 标记或直接用 invokeMemory（会建库）。
 */
export async function memoryServiceOp<T>(op: string, args?: unknown): Promise<T> {
  return client.invoke<T>(op, args);
}

/** 标记：服务侧打开库失败（文件不存在），按旧语义回落 */
export function isMissingDb(value: unknown): value is { missing: true } {
  return (
    Boolean(value) && typeof value === 'object' && (value as { missing?: unknown }).missing === true
  );
}

// ---- op 转发（旧 memoryHost 导出名保持，Main 侧调用点不用改语义） ----

export function invokeMemory(
  op: MemoryOp,
  params: unknown,
  scope: MemorySpaceContext | string | null
): Promise<unknown> {
  return memoryServiceOp('invoke', { op, params, scope });
}

export async function approvePendingMemoryWrite(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  return memoryServiceOp('approve-write', { id });
}

export async function editMemory(
  id: string,
  patch: import('./memory/manual').ManualEditPatch
): Promise<ManualEditResult | null> {
  const result = await memoryServiceOp<ManualEditResult | null | { missing: true }>('edit-memory', {
    id,
    patch,
  });
  return isMissingDb(result) ? null : result;
}

export function scheduleMemoryDistill(
  payload: Parameters<typeof import('./memoryServiceCore').scheduleMemoryDistill>[0],
  options?: Parameters<typeof import('./memoryServiceCore').scheduleMemoryDistill>[1]
): Promise<string | undefined> {
  return memoryServiceOp('schedule-distill', { payload, options });
}

export function distillSessionNow(
  payload: Parameters<typeof import('./memoryServiceCore').distillSessionNow>[0],
  options?: Parameters<typeof import('./memoryServiceCore').distillSessionNow>[1]
): Promise<boolean> {
  return memoryServiceOp('distill', { payload, options });
}

export function getMemoryDistillJobs(limit?: number): Promise<DistillJob[]> {
  return memoryServiceOp('distill-jobs', { limit });
}

export function getMemoryKgJobs(limit?: number): Promise<KgJob[]> {
  return memoryServiceOp('kg-jobs', { limit });
}

export function getMemoryKgFailedCount(): Promise<number> {
  return memoryServiceOp('kg-failed');
}

export function retryFailedMemoryKg(): Promise<number> {
  return memoryServiceOp('kg-retry-failed');
}

export function getMemoryReembedProgress(): Promise<ReembedJob | null> {
  return memoryServiceOp('reembed-progress');
}

export function awaitMemoryDistill(): Promise<void> {
  return memoryServiceOp('await-distill').then(() => undefined);
}

export function awaitSessionDistill(sessionId: string): Promise<void> {
  return memoryServiceOp('await-session-distill', { sessionId }).then(() => undefined);
}

export function awaitMemoryKg(): Promise<void> {
  return memoryServiceOp('await-kg').then(() => undefined);
}

export function awaitMemoryReconcile(): Promise<void> {
  return memoryServiceOp('await-reconcile').then(() => undefined);
}

export function awaitMemoryReembed(): Promise<void> {
  return memoryServiceOp('await-reembed').then(() => undefined);
}

export function awaitMemoryEmbeddingClose(): Promise<void> {
  return memoryServiceOp('await-embedding-close').then(() => undefined);
}

export function flushMemoryDistillQueue(): Promise<void> {
  return memoryServiceOp('await-distill').then(() => undefined);
}

export function runMemoryForgettingNow(): Promise<ForgettingRunSummary> {
  return memoryServiceOp('forgetting-run');
}

export function runMemoryReconcileNow(): Promise<ReconcileSummary | null> {
  return memoryServiceOp('reconcile-run');
}

export function getMemoryEmbeddingError(): Promise<string | null> {
  return memoryServiceOp('embedding-error');
}

/** 设置页手动重嵌：autoDownload 会顺带把未下载的模型拉下来 */
export function refreshMemoryEmbedding(opts: { reembed?: boolean } = {}): Promise<unknown> {
  return memoryServiceOp('reembed', { force: opts.reembed !== false }).catch((error) => {
    console.warn('[memory] refresh embedding op failed:', error);
    return false;
  });
}

/** 删除本地 chat 权重前释放服务进程里的模型槽 */
export function releaseMemoryChatSlot(): Promise<void> {
  return memoryServiceOp('release-chat').then(() => undefined);
}

/** before-quit：发起优雅关（异步）；will-quit 由 shutdownMemoryService 兜住等待 */
export function closeMemoryDb(): void {
  void client.shutdown();
}

/** will-quit 收尾步骤：服务活着就等它关库关模型（超时内部会 SIGKILL） */
export function memoryServiceActive(): boolean {
  return client.alive();
}

// 启动后等界面与 worker 先起来，再在后台把记忆服务、库和 embedding 模型热好：
// 新版本首次加载模型要编译 Metal 管线，冷启动能超过工具 15s 的等待
const WARMUP_DELAY_MS = 20_000;
let warmupScheduled = false;

/** 只预热已在用记忆的用户（库已存在）；不为预热建库，也不拖慢启动 */
export function scheduleMemoryServiceWarmup(delayMs = WARMUP_DELAY_MS): void {
  if (warmupScheduled) return;
  warmupScheduled = true;
  setTimeout(() => {
    if (!existsSync(path.join(memoryRoot(), 'memory.db'))) return;
    void memoryServiceOp('warmup').then(
      (result) => console.info('[memory-service] warmup', result),
      (error) => console.warn('[memory-service] warmup failed:', error)
    );
  }, delayMs).unref?.();
}

export async function shutdownMemoryService(): Promise<void> {
  await client.shutdown();
}

/** 退出时同步通知入口；实际写入在服务侧，这里只是让渲染层立即刷新一次 */
export function notifyMemoryChanged(): void {
  try {
    onMemoryChanged?.();
  } catch {}
}

/** 子会话（coworker `${parentId}::cw-x` / enso child）归属父会话所在项目。 */
export function rootSessionId(identity: SessionIdentity | ChildSessionIdentity): string {
  const parent = (identity as ChildSessionIdentity).parent?.sessionId;
  const id = parent ?? identity.sessionId;
  const sep = id.indexOf('::');
  return sep === -1 ? id : id.slice(0, sep);
}

// ---- 配置收窄与推送 ----

export function syncMemoryEmbeddingFromSettings(state: Record<string, unknown>): void {
  const rawModel = state.memoryEmbeddingModel;
  const modelId =
    typeof rawModel === 'string' && resolveEmbeddingModelSpec(rawModel)
      ? rawModel
      : DEFAULT_EMBEDDING_MODEL_ID;
  const autoDownload = state.memoryEmbeddingAutoDownload === true;
  const providerId =
    typeof state.memoryEmbeddingRemoteProviderId === 'string'
      ? state.memoryEmbeddingRemoteProviderId
      : null;
  const providers = Array.isArray(state.providers) ? (state.providers as unknown[]) : [];
  const spec = resolveEmbeddingModelSpec(modelId);
  const remote = spec?.runtime === 'openai-compatible';
  const selected = providerId
    ? providers.find(
        (x): x is ModelProvider =>
          Boolean(x) && typeof x === 'object' && (x as ModelProvider).id === providerId
      )
    : undefined;
  const model = remote ? remoteModelName(spec) : null;
  const issue = remote
    ? remoteEmbeddingIssue({ providerId, provider: selected, modelId: model })
    : null;
  const locale = normalizeLocale(typeof state.language === 'string' ? state.language : undefined);
  const remoteIssue = issue
    ? remoteEmbeddingIssueMessage(
        issue,
        { provider: selected?.name || providerId || '', model: model ?? '' },
        (key, params) => translate(locale, key, params)
      )
    : null;
  // 坏代理不给凭证：不能退回全局代理把记忆正文发到用户没选的出口
  const proxy = parseProviderProxy(selected?.proxy);
  const credentials: RemoteEmbeddingOptions | null =
    remote && !issue && selected && proxy !== null
      ? { baseUrl: selected.baseUrl, apiKey: selected.apiKey, ...(proxy ? { proxy } : {}) }
      : null;
  client.configure({
    embedding: {
      modelId,
      autoDownload,
      remoteIssue,
      remoteCredentials: credentials ?? undefined,
      idleMinutes: normalizeMemoryModelIdleMinutes(state.memoryModelIdleMinutes),
    },
    chat: {
      memoryChatModel: state.memoryChatModel,
      memoryModelIdleMinutes: normalizeMemoryModelIdleMinutes(state.memoryModelIdleMinutes),
    },
  });
}

export function syncMemoryDistillFromSettings(state: Record<string, unknown>): void {
  client.configure({ distill: state });
}

export function syncMemoryKgFromSettings(state: Record<string, unknown>): void {
  client.configure({ kg: state });
}

export function syncMemoryReconcileFromSettings(state: Record<string, unknown>): void {
  client.configure({ reconcile: state });
}

export function syncMemoryForgettingFromSettings(state: Record<string, unknown>): void {
  client.configure({ forgetting: state });
}

export function configureMemoryDistill(next: Partial<MemoryDistillConfig>): void {
  // complete 获取器是函数不能跨进程：注册为 resolver，服务 LLM 请求经它回 Main；
  // null 表示「远程通道不可用」，服务侧任务保留 pending 等下次开库续跑
  if (next.complete !== undefined) {
    llmResolver = next.complete ? async () => (await next.complete!()) ?? null : async () => null;
  }
  const serializable: Record<string, unknown> = {};
  if (next.enabled !== undefined) serializable.enabled = next.enabled;
  if (next.language !== undefined) serializable.language = next.language;
  if (next.windowMinutes !== undefined) serializable.windowMinutes = next.windowMinutes;
  if (Object.keys(serializable).length > 0) client.configure({ 'distill-options': serializable });
}

export function configureMemoryKg(next: Partial<MemoryKgConfig>): void {
  if (next.enabled !== undefined) client.configure({ 'kg-enabled': next.enabled });
}

export function configureMemoryEmbedding(next: Partial<MemoryEmbeddingConfig>): void {
  const serializable: Record<string, unknown> = {};
  if (next.modelId !== undefined) serializable.modelId = next.modelId;
  if (next.autoDownload !== undefined) serializable.autoDownload = next.autoDownload;
  if (next.remoteIssue !== undefined) serializable.remoteIssue = next.remoteIssue;
  if (Object.keys(serializable).length > 0) client.configure({ 'embedding-options': serializable });
}

export function syncLocalChatFromSettings(state: Record<string, unknown>): void {
  client.configure({
    chat: {
      memoryChatModel: state.memoryChatModel,
      memoryModelIdleMinutes: normalizeMemoryModelIdleMinutes(state.memoryModelIdleMinutes),
    },
  });
}

export function forgettingSettings(): Promise<ForgettingSettings> {
  return memoryServiceOp('forgetting-settings');
}
