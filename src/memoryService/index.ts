/**
 * 记忆服务进程入口：utilityProcess（生产）或 child_process.fork（测试）运行。
 * better-sqlite3 / sqlite-vec / node-llama-cpp 全在本进程，Main 只做转发，
 * 检索 / 写入 / 本地推理不再阻塞渲染。
 */
import path from 'node:path';
import type { Complete, CompleteOptions } from '../main/services/memory/distill';
import { initMemoryService } from '../main/services/memoryServiceCore';
import { dispatchMemoryOp } from './ops';

const memoryRoot = process.env.ENSO_MEMORY_ROOT;
const sessionDir = process.env.ENSO_MEMORY_SESSION_DIR;
if (!memoryRoot || !sessionDir) {
  throw new Error('ENSO_MEMORY_ROOT and ENSO_MEMORY_SESSION_DIR are required');
}

interface LlmRequestMessage {
  requestId: number;
  system: string;
  user: string;
  maxTokens?: number;
  stage?: string;
}

const pendingLlm = new Map<
  number,
  { resolve: (text: string) => void; reject: (error: Error) => void }
>();
let llmSeq = 0;
let port: { postMessage(message: unknown): void };

/** 转录代读：服务 → transcript-request → Main 回 transcript-result */
const transcriptWaiters = new Map<number, (messages: unknown) => void>();
let transcriptSeq = 0;
function requestTranscript(sessionFile: string): Promise<unknown> {
  return new Promise((resolve) => {
    const requestId = ++transcriptSeq;
    transcriptWaiters.set(requestId, resolve);
    port.postMessage({ type: 'transcript-request', requestId, sessionFile });
    setTimeout(() => {
      if (transcriptWaiters.delete(requestId)) resolve([]);
    }, 60_000).unref?.();
  });
}

/** 远程补全代发：Main 侧经 resolver 复用 completeText / OAuth 候选链 */
function remoteComplete(): Promise<Complete | null> {
  const request = (requestId: number) =>
    new Promise<string>((resolve, reject) => {
      pendingLlm.set(requestId, { resolve, reject });
    });
  return Promise.resolve(
    (system: string, user: string, options?: CompleteOptions): Promise<string> => {
      const requestId = ++llmSeq;
      const _message: LlmRequestMessage = {
        requestId,
        system,
        user,
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options?.stage !== undefined ? { stage: options.stage } : {}),
      };
      const external = options?.signal;
      if (external) {
        const cancel = () => port.postMessage({ type: 'llm-cancel', requestId });
        external.addEventListener('abort', cancel, { once: true });
      }
      return request(requestId).finally(() => pendingLlm.delete(requestId));
    }
  );
}

function workerPort(): {
  postMessage(message: unknown): void;
  onMessage(listener: (data: unknown) => void): void;
} {
  const parent = process.parentPort;
  if (parent) {
    return {
      postMessage: (message) => parent.postMessage(message),
      onMessage: (listener) => parent.on('message', (event) => listener(event.data)),
    };
  }
  if (typeof process.send === 'function') {
    const send = process.send.bind(process);
    return {
      postMessage: (message) => {
        send(message);
      },
      onMessage: (listener) => process.on('message', listener),
    };
  }
  throw new Error('memory service has no parent channel');
}

const wport = workerPort();
port = wport;

initMemoryService({
  paths: { memoryRoot: path.resolve(memoryRoot), sessionDir: path.resolve(sessionDir) },
  postEvent: (event) => wport.postMessage(event),
  remoteComplete,
  transcriptReader: (sessionFile) =>
    requestTranscript(sessionFile) as Promise<
      import('../main/services/memory/distill').TranscriptMessage[]
    >,
});

wport.onMessage((raw: unknown) => {
  const message = raw as Record<string, unknown>;
  switch (message?.type) {
    case 'op': {
      const requestId = message.requestId as number;
      void dispatchMemoryOp(message.op as string, message.args).then(
        (result) => wport.postMessage({ type: 'op-result', requestId, result }),
        (error) =>
          wport.postMessage({
            type: 'op-result',
            requestId,
            error: error instanceof Error ? error.message : String(error),
          })
      );
      return;
    }
    case 'llm-result': {
      const entry = pendingLlm.get(message.requestId as number);
      if (entry) {
        pendingLlm.delete(message.requestId as number);
        entry.resolve(String(message.text ?? ''));
      }
      return;
    }
    case 'llm-error': {
      const entry = pendingLlm.get(message.requestId as number);
      if (entry) {
        pendingLlm.delete(message.requestId as number);
        entry.reject(new Error(String(message.error ?? 'llm request failed')));
      }
      return;
    }
  }
});

wport.postMessage({ type: 'ready' });
