import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { AX_WORKER_TIMEOUT_MS } from './axWalkBudget';

const require = createRequire(import.meta.url);

export const AX_WORKER_EXITED = 'AX_WORKER_EXITED';

export type AxWorkerRequest =
  | { op: 'snapshot'; pid: number; maxDepth: number }
  | {
      op: 'query';
      pid: number;
      role?: string;
      title?: string;
      value?: string;
      description?: string;
      limit: number;
    }
  | { op: 'elementAt'; x: number; y: number }
  | { op: 'focused' }
  | { op: 'node'; handle: string }
  | { op: 'attributes'; handle: string }
  | { op: 'children'; handle: string }
  | { op: 'perform'; handle: string; action: string }
  | { op: 'setValue'; handle: string; value: string }
  | { op: 'focus'; handle: string }
  | { op: 'pid'; handle: string }
  | { op: 'enable'; pid: number; bundleId?: string }
  | { op: 'restoreEnable'; pid: number; attrs: string[] };

export type AxWorkerJob = AxWorkerRequest & { id: string };

export type AxWorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export function unwrapAxWorkerMessage(message: unknown, utility: boolean): AxWorkerJob | null {
  const job = utility ? (message as { data?: unknown } | null)?.data : message;
  if (!job || typeof job !== 'object') return null;
  const { id, op } = job as { id?: unknown; op?: unknown };
  return typeof id === 'string' && typeof op === 'string' ? (job as AxWorkerJob) : null;
}

export interface AxWorkerHandle {
  postMessage: (job: AxWorkerJob) => void;
  terminate: () => void | Promise<void>;
  on: (event: 'message' | 'error' | 'exit', handler: (value: unknown) => void) => void;
}

export function wrapUtilityProcess(child: {
  postMessage: (job: AxWorkerJob) => void;
  kill: () => boolean;
  on: (event: string, handler: (value: unknown) => void) => void;
  once: (event: string, handler: () => void) => void;
}): AxWorkerHandle {
  let ready = false;
  const queue: AxWorkerJob[] = [];
  child.once('spawn', () => {
    ready = true;
    for (const job of queue) child.postMessage(job);
    queue.length = 0;
  });
  return {
    postMessage: (job) => {
      if (ready) child.postMessage(job);
      else queue.push(job);
    },
    terminate: () => {
      child.kill();
    },
    on: (event, handler) => {
      child.on(event, handler);
    },
  };
}

export function spawnAxWorkerThread(filename: string): AxWorkerHandle {
  const worker = new Worker(filename);
  return {
    postMessage: (job) => worker.postMessage(job),
    terminate: () => {
      void worker.terminate();
    },
    on: (event, handler) => {
      worker.on(event, handler);
    },
  };
}

export type AxUtilityFork = (
  filename: string
) => Parameters<typeof wrapUtilityProcess>[0] | undefined;

function defaultUtilityFork(filename: string): ReturnType<AxUtilityFork> {
  try {
    const electron = require('electron') as {
      utilityProcess?: {
        fork: (
          path: string,
          args?: string[],
          opts?: object
        ) => Parameters<typeof wrapUtilityProcess>[0];
      };
    };
    if (typeof electron.utilityProcess?.fork === 'function') {
      return electron.utilityProcess.fork(filename, [], { serviceName: 'enso-ax-worker' });
    }
  } catch {
    // tests / no electron
  }
  return undefined;
}

export function spawnAxWorker(
  filename: string,
  fork: AxUtilityFork = defaultUtilityFork
): AxWorkerHandle {
  const child = fork(filename);
  if (child) return wrapUtilityProcess(child);
  return spawnAxWorkerThread(filename);
}

export function createAxWorkerClient(opts: { timeoutMs?: number; spawn: () => AxWorkerHandle }) {
  const timeoutMs = opts.timeoutMs ?? AX_WORKER_TIMEOUT_MS;
  let worker: AxWorkerHandle | undefined;
  let seq = 0;
  const pending = new Map<
    string,
    { owner: AxWorkerHandle; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  // 只清理属于 owner 的请求；旧实例的迟到事件不能波及新 worker
  const retire = (owner: AxWorkerHandle, error: Error) => {
    if (worker === owner) worker = undefined;
    const waiting = [...pending].filter(([, item]) => item.owner === owner);
    for (const [id] of waiting) pending.delete(id);
    for (const [, item] of waiting) item.reject(error);
  };

  const ensure = () => {
    if (worker) return worker;
    const spawned = opts.spawn();
    worker = spawned;
    spawned.on('message', (value) => {
      if (worker !== spawned) return;
      const msg = value as AxWorkerResponse | null;
      if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') return;
      const item = pending.get(msg.id);
      if (!item || item.owner !== spawned) return;
      pending.delete(msg.id);
      if (msg.ok) item.resolve(msg.result);
      else item.reject(new Error(msg.error));
    });
    spawned.on('error', (value) => {
      if (worker !== spawned) return;
      void Promise.resolve(spawned.terminate()).catch(() => undefined);
      retire(spawned, value instanceof Error ? value : new Error(String(value)));
    });
    spawned.on('exit', () => {
      if (worker !== spawned) return;
      retire(spawned, new Error(AX_WORKER_EXITED));
    });
    return spawned;
  };

  return {
    async call(request: AxWorkerRequest): Promise<unknown> {
      const id = String(++seq);
      const current = ensure();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          void Promise.resolve(current.terminate()).catch(() => undefined);
          retire(current, new Error('AX_TIMEOUT'));
        }, timeoutMs);
        pending.set(id, {
          owner: current,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          current.postMessage({ ...request, id });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  };
}
