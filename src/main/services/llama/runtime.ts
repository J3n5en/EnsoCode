/**
 * llama.cpp 运行时的唯一入口：embedding 与本地 chat 共用同一个 Llama 实例和模型槽。
 *
 * 只声明用到的表面，测试注入假实现；生产懒加载 node-llama-cpp（原生绑定，
 * 不能被打进 bundle —— 见 electron.vite.config.ts 的 external）。
 */

export interface LlamaEmbeddingLike {
  readonly vector: readonly number[];
}

export interface LlamaEmbeddingContextLike {
  getEmbeddingFor(input: string): Promise<LlamaEmbeddingLike>;
  dispose(): Promise<void>;
}

export interface LlamaContextSequenceLike {
  /** 清空这条 sequence 的历史，使其可复用；不销毁槽位 */
  clearHistory(): Promise<void>;
  dispose?(): void;
}

export interface LlamaContextLike {
  /** context 默认只有 1 条 sequence，取完即耗尽（sequencesLeft 归零） */
  getSequence(): LlamaContextSequenceLike;
  dispose(): Promise<void>;
}

export interface LlamaModelLike {
  createEmbeddingContext(opts?: {
    contextSize?: 'auto' | number | { min?: number; max?: number };
    batchSize?: number;
    createSignal?: AbortSignal;
  }): Promise<LlamaEmbeddingContextLike>;
  createContext(opts?: {
    contextSize?: 'auto' | number;
    createSignal?: AbortSignal;
  }): Promise<LlamaContextLike>;
  dispose(): Promise<void>;
}

export interface LlamaLike {
  loadModel(opts: {
    modelPath: string;
    gpuLayers?: number | 'auto' | 'max';
    createSignal?: AbortSignal;
  }): Promise<LlamaModelLike>;
  /** node-llama-cpp 的 Llama.dispose；退出前必须等它跑完，否则 AsyncWorker 在 FreeEnvironment 里 abort */
  dispose?(): Promise<void>;
}

export class LlamaUnavailableError extends Error {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    // 与 onnx 同样的分歧点：打包漏了 external 和「没装」报的都是加载失败，
    // 但处置完全不同，混在一起会让排查一路走偏。
    const bundled = reason.includes('dynamically require') || reason.includes('ERR_MODULE');
    const detail = bundled
      ? 'node-llama-cpp 被打进了 bundle，原生绑定加载失败：' +
        'electron.vite.config.ts 的 main.build.rollupOptions.external 必须包含它' +
        '（externalizeDeps 只处理 dependencies，它在 optionalDependencies 里）。'
      : 'node-llama-cpp 不可用（可选依赖未安装或当前平台无预编译二进制）。' +
        '请在记忆设置里把本地模型改为远程模型或其它运行时。';
    super(`${detail} 原因：${reason}`);
    this.name = 'LlamaUnavailableError';
  }
}

let llamaPromise: Promise<LlamaLike> | null = null;

/** 进程内单例：Llama 实例持有 GPU 上下文，重复创建会浪费显存 */
export async function loadLlama(): Promise<LlamaLike> {
  llamaPromise ??= (async () => {
    try {
      const { ensureGpuBackend } = await import('./gpuBackendInstall');
      await ensureGpuBackend().catch((err: unknown) => {
        console.warn('[llama] GPU backend unavailable, using CPU:', err);
      });
      const mod = await import('node-llama-cpp');
      // build:'never' —— 桌面端不该在用户机器上现编译 llama.cpp
      return (await mod.getLlama({ build: 'never', progressLogs: false })) as unknown as LlamaLike;
    } catch (cause) {
      llamaPromise = null;
      throw new LlamaUnavailableError(cause);
    }
  })();
  return llamaPromise;
}

/** 模型槽：按用途各占一个，切换模型时释放旧的，避免同时驻留多份权重 */
export type ModelSlot = 'embedding' | 'chat';

interface SlotState {
  path: string;
  model: LlamaModelLike;
}

const slots = new Map<ModelSlot, SlotState>();
const slotQueues = new Map<ModelSlot, Promise<unknown>>();
const retained = new Map<LlamaModelLike, number>();
let disposal: Promise<void> | null = null;
let ownersReleased: (() => void) | null = null;

function inSlot<T>(slot: ModelSlot, task: () => Promise<T>): Promise<T> {
  const run = (slotQueues.get(slot) ?? Promise.resolve()).then(task, task);
  const settled = run.then(
    () => {},
    () => {}
  );
  slotQueues.set(slot, settled);
  void settled.then(() => {
    if (slotQueues.get(slot) === settled) slotQueues.delete(slot);
  });
  return run;
}

/**
 * 取指定槽的模型；路径变化时释放旧模型再加载新的。
 * 同一路径重复调用直接复用（加载一个 0.6B 权重需要数百毫秒）。
 */
export async function acquireModel(
  slot: ModelSlot,
  modelPath: string,
  opts: {
    gpuLayers?: number | 'auto' | 'max';
    loadLlamaImpl?: () => Promise<LlamaLike>;
    retain?: boolean;
  } = {}
): Promise<LlamaModelLike> {
  if (disposal) throw new Error('llama runtime is closing');
  return inSlot(slot, async () => {
    const current = slots.get(slot);
    let model = current?.path === modelPath ? current.model : null;
    if (!model) {
      if (current) {
        slots.delete(slot);
        if (!retained.has(current.model)) await current.model.dispose().catch(() => {});
      }
      const llama = await (opts.loadLlamaImpl ?? loadLlama)();
      model = await llama.loadModel({ modelPath, gpuLayers: opts.gpuLayers ?? 'auto' });
      slots.set(slot, { path: modelPath, model });
    }
    if (opts.retain) retained.set(model, (retained.get(model) ?? 0) + 1);
    return model;
  });
}

export async function releaseModel(slot: ModelSlot, expected?: LlamaModelLike): Promise<void> {
  return inSlot(slot, async () => {
    const current = slots.get(slot);
    const model = expected ?? current?.model;
    if (!model) return;
    if (expected) {
      const count = retained.get(model);
      if (count === undefined) return;
      if (count > 1) {
        retained.set(model, count - 1);
        return;
      }
      retained.delete(model);
    } else if (retained.has(model)) {
      // provider 仍持有 context，由最后一个 owner 的身份释放收尾。
      return;
    }
    if (current?.model === model) slots.delete(slot);
    await model.dispose().catch(() => {});
    if (retained.size === 0) ownersReleased?.();
  });
}

export async function releaseAllModels(): Promise<void> {
  await Promise.all((['embedding', 'chat'] as const).map((slot) => releaseModel(slot)));
}

export function llamaRuntimeActive(): boolean {
  return llamaPromise !== null || slots.size > 0 || slotQueues.size > 0;
}

/**
 * 先放模型槽再 dispose Llama 单例。
 * 必须在 will-quit 里 await：N-API AsyncWorker 在 FreeEnvironment 期间 OnWorkComplete 会 SIGABRT。
 */
export function disposeLlamaRuntime(): Promise<void> {
  disposal ??= (async () => {
    await releaseAllModels();
    if (retained.size > 0) {
      await new Promise<void>((resolve) => {
        ownersReleased = resolve;
      });
      ownersReleased = null;
      await releaseAllModels();
    }
    // 已接收的排队加载也可能创建 Llama，必须在 drain 后取快照。
    const loading = llamaPromise;
    llamaPromise = null;
    if (!loading) return;
    try {
      const llama = await loading;
      await llama.dispose?.();
    } catch {
      /* 加载失败或 dispose 抛错都不能挡住退出 */
    }
  })();
  return disposal;
}

/** 仅供测试：重置单例与槽位 */
export function __resetLlamaForTest(): void {
  llamaPromise = null;
  slots.clear();
  retained.clear();
  slotQueues.clear();
  disposal = null;
  ownersReleased = null;
}

/** 仅供测试：跳过 getLlama，直接挂上已有实例 */
export function __installLlamaForTest(llama: LlamaLike): void {
  llamaPromise = Promise.resolve(llama);
}
