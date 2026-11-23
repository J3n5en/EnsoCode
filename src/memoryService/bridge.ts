import type { Complete, CompleteOptions, TranscriptMessage } from '../main/services/memory/distill';

export interface MemoryServicePort {
  postMessage(message: unknown): void;
  onMessage(listener: (data: unknown) => void): void;
}

interface LlmRequestMessage {
  requestId: number;
  system: string;
  user: string;
  maxTokens?: number;
  stage?: string;
}

export function createMemoryServiceBridge(
  port: MemoryServicePort,
  dispatchOp: (op: string, args: unknown) => Promise<unknown>,
  opts: { transcriptTimeoutMs?: number } = {}
) {
  const transcriptTimeoutMs = opts.transcriptTimeoutMs ?? 60_000;
  const pendingLlm = new Map<
    number,
    { resolve: (text: string) => void; reject: (error: Error) => void }
  >();
  let llmSeq = 0;

  const transcriptWaiters = new Map<
    number,
    { resolve: (messages: TranscriptMessage[]) => void; timer: NodeJS.Timeout }
  >();
  let transcriptSeq = 0;

  function requestTranscript(sessionFile: string): Promise<TranscriptMessage[]> {
    return new Promise((resolve) => {
      const requestId = ++transcriptSeq;
      const timer = setTimeout(() => {
        if (transcriptWaiters.delete(requestId)) resolve([]);
      }, transcriptTimeoutMs);
      timer.unref?.();
      transcriptWaiters.set(requestId, { resolve, timer });
      port.postMessage({ type: 'transcript-request', requestId, sessionFile });
    });
  }

  function remoteComplete(): Promise<Complete | null> {
    const request = (requestId: number) =>
      new Promise<string>((resolve, reject) => {
        pendingLlm.set(requestId, { resolve, reject });
      });
    return Promise.resolve(
      (system: string, user: string, options?: CompleteOptions): Promise<string> => {
        const external = options?.signal;
        if (external?.aborted) {
          return Promise.reject(new Error('llm request aborted'));
        }
        const requestId = ++llmSeq;
        const payload: LlmRequestMessage = {
          requestId,
          system,
          user,
          ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options?.stage !== undefined ? { stage: options.stage } : {}),
        };
        const pending = request(requestId);
        const cancel = () => port.postMessage({ type: 'llm-cancel', requestId });
        if (external) {
          external.addEventListener('abort', cancel, { once: true });
        }
        port.postMessage({ type: 'llm-request', ...payload });
        return pending.finally(() => {
          pendingLlm.delete(requestId);
          external?.removeEventListener('abort', cancel);
        });
      }
    );
  }

  function handleMessage(raw: unknown): void {
    const message = raw as Record<string, unknown>;
    switch (message?.type) {
      case 'ping':
        port.postMessage({ type: 'pong', requestId: message.requestId });
        return;
      case 'op': {
        const requestId = message.requestId as number;
        void dispatchOp(message.op as string, message.args).then(
          (result) => port.postMessage({ type: 'op-result', requestId, result }),
          (error) =>
            port.postMessage({
              type: 'op-result',
              requestId,
              error: error instanceof Error ? error.message : String(error),
            })
        );
        return;
      }
      case 'transcript-result': {
        const requestId = message.requestId as number;
        const entry = transcriptWaiters.get(requestId);
        if (entry) {
          transcriptWaiters.delete(requestId);
          clearTimeout(entry.timer);
          entry.resolve(
            Array.isArray(message.messages) ? (message.messages as TranscriptMessage[]) : []
          );
        }
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
  }

  port.onMessage(handleMessage);

  return { requestTranscript, remoteComplete, handleMessage };
}
