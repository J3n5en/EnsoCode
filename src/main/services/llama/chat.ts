import type { Complete } from '../memory/distill';
import {
  chatModelIdFromSettings,
  localChatModelPathIfReady,
  REMOTE_CHAT_MODEL_ID,
  resolveChatModelSpec,
} from './chatModels';
import { withoutReasoning } from './chatWrapper';
import { ModelIdleTimer } from './idle';
import {
  acquireModel,
  type LlamaContextLike,
  type LlamaContextSequenceLike,
  type LlamaModelLike,
  releaseModel,
} from './runtime';

export interface ChatSessionLike {
  prompt(userText: string, opts?: { signal?: AbortSignal }): Promise<string>;
  dispose(): void;
}

export interface CreateLocalCompleteOptions {
  timeoutMs?: number;
  contextSize?: number;
  acquireModelImpl?: (
    slot: 'chat',
    modelPath: string,
    opts?: { gpuLayers?: number | 'auto' | 'max' }
  ) => Promise<LlamaModelLike>;
  /**
   * 测试注入假 session。生产走 node-llama-cpp 的 LlamaChatSession。
   * 每次 Complete 都新建 session：契约是无状态 (system, user)→text，
   * 复用会把提炼历史泄漏进解读。
   */
  createSession?: (model: LlamaModelLike, systemPrompt: string) => Promise<ChatSessionLike>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_SIZE = 8192;

/**
 * llama.cpp 默认一个 sequence；提炼虽串行，解读/结晶可能并发。
 * 重叠推理会抢同一份 KV，所以进程内所有本地 Complete 共用这一把锁。
 */
let queue: Promise<unknown> = Promise.resolve();
let chatIdle = new ModelIdleTimer(() => releaseLocalChatSlot());

let selectedChatModel = REMOTE_CHAT_MODEL_ID;

export function syncLocalChatFromSettings(state: Record<string, unknown>): void {
  chatIdle.configure(state.memoryModelIdleMinutes);
  const id = chatModelIdFromSettings(state);
  if (id === selectedChatModel) return;
  selectedChatModel = id;
  void releaseLocalChatSlot().catch(() => {});
}

export function holdLocalChat(): () => void {
  return chatIdle.acquire();
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

let cachedContext: {
  path: string;
  context: LlamaContextLike;
  sequence: LlamaContextSequenceLike | null;
  /** resolveChatWrapper 要解析模型元数据，每轮重建是白费开销 */
  wrapper?: object;
} | null = null;

/**
 * context 默认只有 1 条 sequence，`getSequence()` 取完就耗尽。
 * 早先每轮都取一条新的并在 dispose 时销毁，结果第二次调用直接抛
 * `No sequences left`——本地提炼从第二个任务起永久失败（实测 call1 成功、call2/3 立刻失败）。
 * 正确做法是复用同一条，靠 clearHistory 保证 Complete 的无状态契约。
 */
export async function takeReusableSequence(
  context: LlamaContextLike,
  previous: LlamaContextSequenceLike | null
): Promise<LlamaContextSequenceLike> {
  if (!previous) return context.getSequence();
  try {
    await previous.clearHistory();
    return previous;
  } catch {
    // 清不掉就换一条，绝不把上一轮的历史带进下一轮
    return context.getSequence();
  }
}

async function defaultCreateSession(
  model: LlamaModelLike,
  systemPrompt: string,
  modelPath: string,
  contextSize: number
): Promise<ChatSessionLike> {
  if (!cachedContext) {
    const context = await model.createContext({ contextSize });
    cachedContext = { path: modelPath, context, sequence: null };
  }
  const sequence = await takeReusableSequence(cachedContext.context, cachedContext.sequence);
  cachedContext.sequence = sequence;
  const { LlamaChatSession, resolveChatWrapper } = await import('node-llama-cpp');
  // 提炼是结构化抽取，CoT 只烧时间：gemma-4-E2B 实测 65.6s → 5.6s（2026-09-10，Metal）
  cachedContext.wrapper ??= withoutReasoning(resolveChatWrapper(model as never));
  const session = new LlamaChatSession({
    contextSequence: sequence as never,
    systemPrompt,
    chatWrapper: cachedContext.wrapper as never,
    // 必须为 false：sequence 由 cachedContext 持有并复用，销毁它就耗尽了槽位
    autoDisposeSequence: false,
  });
  return {
    prompt: (userText, opts) => session.prompt(userText, { signal: opts?.signal, temperature: 0 }),
    dispose: () => {
      session.dispose({ disposeSequence: false });
    },
  };
}

/** 仅供测试：丢掉缓存的 KV，避免跨用例串台 */
export function __resetLocalChatForTest(): void {
  selectedChatModel = REMOTE_CHAT_MODEL_ID;
  chatIdle.reset();
  chatIdle = new ModelIdleTimer(() => releaseLocalChatSlot());
  cachedContext = null;
  queue = Promise.resolve();
}

/**
 * 删权重前必须先把 KV 和模型槽释放完。Windows 上 llama.cpp 仍 mmap 着 GGUF 时 rm 会失败。
 * 实测（2026-09-10，Metal，gemma-4-E2B Q4）：AbortSignal 在 decode 中第 12 chunk 触发后 31ms
 * prompt() 即拒绝，再等 2.5s 无新 chunk，下一次推理 286ms 起步——GPU 侧停了，不必再叠一层硬 dispose。
 */
export function releaseLocalChatSlot(): Promise<void> {
  chatIdle.reset();
  return enqueue(async () => {
    await disposeChatContext();
    await releaseModel('chat');
    chatIdle.reset();
  });
}

async function disposeChatContext(): Promise<void> {
  if (!cachedContext) return;
  const previous = cachedContext;
  cachedContext = null;
  await previous.context.dispose().catch(() => {});
}

export function createLocalComplete(
  modelPath: string,
  opts: CreateLocalCompleteOptions = {}
): Complete {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const contextSize = opts.contextSize ?? DEFAULT_CONTEXT_SIZE;
  const acquire = opts.acquireModelImpl ?? ((slot, p) => acquireModel(slot, p));
  const createSession =
    opts.createSession ??
    ((model, systemPrompt) => defaultCreateSession(model, systemPrompt, modelPath, contextSize));

  return (systemPrompt, userText) => {
    const release = chatIdle.acquire();
    return new Promise<string>((resolve, reject) => {
      void enqueue(async () => {
        const ac = new AbortController();
        const timedOut = new Error('local chat timed out');
        const timer = setTimeout(() => {
          ac.abort(timedOut);
          reject(timedOut);
        }, timeoutMs);
        let session: ChatSessionLike | null = null;
        try {
          if (cachedContext && cachedContext.path !== modelPath) await disposeChatContext();
          const model = await acquire('chat', modelPath);
          ac.signal.throwIfAborted();
          session = await createSession(model, systemPrompt);
          ac.signal.throwIfAborted();
          // 调用者超时不代表 native 已停；锁、session 和空闲计时都等真实推理 settle。
          resolve(await session.prompt(userText, { signal: ac.signal }));
        } catch (error) {
          reject(error);
        } finally {
          clearTimeout(timer);
          try {
            session?.dispose();
          } catch {}
          release();
        }
      });
    });
  };
}

export async function memoryCompleteFromSettings(
  state: Record<string, unknown> | undefined,
  opts: {
    modelsRoot: string;
    remoteComplete: () => Promise<Complete | null>;
    createLocal?: typeof createLocalComplete;
  }
): Promise<Complete | null> {
  const id = chatModelIdFromSettings(state);
  if (id === REMOTE_CHAT_MODEL_ID) return opts.remoteComplete();
  const gguf = localChatModelPathIfReady(opts.modelsRoot, id);
  if (!gguf) return null;
  const spec = resolveChatModelSpec(id);
  return (opts.createLocal ?? createLocalComplete)(gguf, { contextSize: spec?.contextSize });
}
