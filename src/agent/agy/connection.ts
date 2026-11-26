import {
  AGY_PROTOCOL_ERROR_MESSAGE,
  AGY_SIGNED_OUT_MESSAGE,
  classifyStdoutLine,
} from '@shared/agy/stdout';

export class AgyRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'AgyRpcError';
    this.code = code;
    this.data = data;
  }
}

type RpcId = number | string;

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export interface JsonRpcConnection {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  /**
   * 发请求，答复到达时在读到它的那一刻同步回调：和前后的 notification 保持线上顺序。
   * `request()` 的 Promise 要等微任务，同一块 stdout 里排在答复后面的 update 会先被处理。
   */
  requestInOrder(method: string, params: unknown, settle: (outcome: RpcOutcome) => void): void;
  notify(method: string, params: unknown): void;
  setRequestHandler(handler: (method: string, params: unknown) => Promise<unknown> | unknown): void;
  setNotificationHandler(handler: (method: string, params: unknown) => void): void;
  push(chunk: string): void;
  close(): void;
}

export type StdoutFault = 'signed-out' | 'protocol-error';

export type RpcOutcome = { result: unknown } | { error: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 换行分隔的 JSON-RPC 2.0。ACP 的 agy 进程用这个帧，不引 SDK。 */
export function createJsonRpcConnection(
  write: (line: string) => void,
  options?: { onFault?: (fault: StdoutFault) => void }
): JsonRpcConnection {
  let buffer = '';
  let nextId = 1;
  let closed = false;
  const pending = new Map<RpcId, Pending>();
  let onRequest: JsonRpcConnection['setRequestHandler'] extends (handler: infer H) => void
    ? H
    : never = () => {
    throw new AgyRpcError(-32601, 'method not found');
  };
  let onNotification: (method: string, params: unknown) => void = () => {};

  const send = (message: unknown) => {
    if (closed) return;
    write(`${JSON.stringify(message)}\n`);
  };

  const fail = (id: RpcId, error: AgyRpcError) => {
    send({
      jsonrpc: '2.0',
      id,
      error: {
        code: error.code,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    });
  };

  const handle = (message: unknown) => {
    if (!isRecord(message) || message.jsonrpc !== '2.0') return;
    if ('method' in message && typeof message.method === 'string') {
      if (message.id === undefined) {
        onNotification(message.method, message.params ?? {});
        return;
      }
      const id = message.id as RpcId;
      Promise.resolve()
        .then(() => onRequest(message.method as string, message.params ?? {}))
        .then((result) => send({ jsonrpc: '2.0', id, result: result ?? null }))
        .catch((error: unknown) => {
          const rpc = error instanceof AgyRpcError ? error : new AgyRpcError(-32603, String(error));
          fail(id, rpc);
        });
      return;
    }
    if (message.id === undefined || !pending.has(message.id as RpcId)) return;
    const waiter = pending.get(message.id as RpcId);
    pending.delete(message.id as RpcId);
    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : -32603;
      const text = typeof message.error.message === 'string' ? message.error.message : 'ACP error';
      waiter?.reject(new AgyRpcError(code, text, message.error.data));
      return;
    }
    waiter?.resolve(message.result);
  };

  const fault = (kind: StdoutFault) => {
    if (closed) return;
    closed = true;
    const error =
      kind === 'signed-out'
        ? new AgyRpcError(-32000, AGY_SIGNED_OUT_MESSAGE)
        : new AgyRpcError(-32603, AGY_PROTOCOL_ERROR_MESSAGE);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    options?.onFault?.(kind);
  };

  return {
    request(method, params, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (closed) return Promise.reject(new AgyRpcError(-32000, 'connection closed'));
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const finish = (error?: unknown, value?: unknown) => {
          signal?.removeEventListener('abort', onAbort);
          pending.delete(id);
          if (error) reject(error);
          else resolve(value);
        };
        const onAbort = () => finish(abortError());
        pending.set(id, {
          resolve: (value) => finish(undefined, value),
          reject: (error) => finish(error),
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    requestInOrder(method, params, settle) {
      if (closed) {
        settle({ error: new AgyRpcError(-32000, 'connection closed') });
        return;
      }
      const id = nextId;
      nextId += 1;
      pending.set(id, {
        resolve: (result) => settle({ result }),
        reject: (error) => settle({ error }),
      });
      send({ jsonrpc: '2.0', id, method, params });
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params });
    },
    setRequestHandler(handler) {
      onRequest = handler;
    },
    setNotificationHandler(handler) {
      onNotification = handler;
    },
    push(chunk) {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const parsed = classifyStdoutLine(line);
          if (parsed.kind === 'signed-out' || parsed.kind === 'protocol-error') {
            fault(parsed.kind);
            return;
          }
          if (parsed.kind === 'json') handle(parsed.value);
        }
        newline = buffer.indexOf('\n');
      }
    },
    close() {
      closed = true;
      for (const waiter of pending.values()) {
        waiter.reject(new AgyRpcError(-32000, 'connection closed'));
      }
      pending.clear();
    },
  };
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}
