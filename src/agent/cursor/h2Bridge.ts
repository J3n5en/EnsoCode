/**
 * Cursor Connect 的进程内 HTTP/2 桥。
 * 协议与 @rahularya01/pi-cursor 的 h2-bridge.mjs 相同（stdin/stdout 长度前缀帧），
 * 但不 spawn：我们不是 Bun，worker 里 node:http2 可用。
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import http2 from 'node:http2';
import { PassThrough } from 'node:stream';

const CURSOR_CLIENT_VERSION = process.env.PI_CURSOR_CLIENT_VERSION || 'cli-2026.05.01-eea359f';
const MAX_BRIDGE_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 1024 * 1024;
const STREAM_DONE_MAGIC = Buffer.from('PI_CURSOR_STREAM_DONE');

export type CursorH2Proc = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

export function startCursorH2Bridge(): CursorH2Proc {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as CursorH2Proc;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;

  let exited = false;
  const shutdown = (code: number) => {
    if (exited) return;
    exited = true;
    clearBridgeTimeout();
    if (pingTimer) clearInterval(pingTimer);
    try {
      client?.close();
    } catch {
      // already closed
    }
    if (!stdin.writableEnded) stdin.end();
    if (!stdout.writableEnded) stdout.end();
    if (!stderr.writableEnded) stderr.end();
    queueMicrotask(() => {
      proc.emit('exit', code);
      proc.emit('close', code);
    });
  };

  proc.kill = () => {
    shutdown(1);
    return true;
  };

  let client: http2.ClientHttp2Session | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let idleTimeoutMs = 0;

  function clearBridgeTimeout() {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
  }
  function armBridgeTimeout(ms: number) {
    clearBridgeTimeout();
    if (!ms || ms <= 0) return;
    timeout = setTimeout(() => shutdown(1), ms);
  }
  function resetTimeout() {
    armBridgeTimeout(idleTimeoutMs);
  }

  function writeMessage(data: Buffer) {
    if (data.byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
      throw new Error(`bridge output exceeds ${MAX_BRIDGE_MESSAGE_BYTES} bytes`);
    }
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    return stdout.write(Buffer.concat([lenBuf, data]));
  }

  function log(line: string) {
    stderr.write(`${line}\n`);
  }

  const reader = makeReader(stdin, () => shutdown(1));

  void (async () => {
    const configBuf = await reader.readMessage();
    if (!configBuf || exited) {
      shutdown(1);
      return;
    }
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(configBuf.toString('utf8')) as Record<string, unknown>;
    } catch {
      log('[h2-bridge] invalid config JSON');
      shutdown(1);
      return;
    }
    if (!config || typeof config !== 'object') {
      log('[h2-bridge] config must be a JSON object');
      shutdown(1);
      return;
    }

    const accessToken = str(config.accessToken);
    const url = str(config.url) || 'https://api2.cursor.sh';
    const rpcPath = str(config.path) || '/agent.v1.AgentService/Run';
    const unary = config.unary === true;
    const persistent = unary ? false : config.persistent !== false;
    const connectTimeoutMs = optionalMs(config.connectTimeoutMs, 30_000);
    idleTimeoutMs = optionalMs(config.idleTimeoutMs, 0);
    const pingEveryMs = optionalMs(config.pingIntervalMs, 20_000);

    client = http2.connect(url);
    if (pingEveryMs > 0) {
      pingTimer = setInterval(() => {
        if (!client || client.destroyed || client.closed) return;
        try {
          client.ping((err) => {
            if (err) log(`[h2-bridge] ping failed: ${err.message}`);
          });
        } catch (err) {
          log(`[h2-bridge] ping threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, pingEveryMs);
      pingTimer.unref?.();
    }

    armBridgeTimeout(connectTimeoutMs);

    client.on('error', (err) => {
      log(`[h2-bridge] client error: ${err instanceof Error ? err.message : String(err)}`);
      shutdown(1);
    });
    client.on('goaway', (errorCode, _last, opaqueData) => {
      const opaque = opaqueData ? opaqueData.toString('utf8').slice(0, 200) : '';
      log(`[h2-bridge] GOAWAY errorCode=${errorCode} opaque=${opaque}`);
      try {
        writeMessage(
          connectEndStreamError(
            'unavailable',
            `Cursor GOAWAY (errorCode=${errorCode}): upstream connection closed, retriable`
          )
        );
      } catch {
        // stdout 可能已关
      }
      setTimeout(() => shutdown(2), 100);
    });

    const requestHeaders = (token: string) => ({
      ':method': 'POST',
      ':path': rpcPath,
      'content-type': unary ? 'application/proto' : 'application/connect+proto',
      'connect-protocol-version': '1',
      te: 'trailers',
      authorization: `Bearer ${token}`,
      'x-ghost-mode': 'true',
      'x-cursor-client-version': CURSOR_CLIENT_VERSION,
      'x-cursor-client-type': 'cli',
      'x-request-id': randomUUID(),
    });

    const attachStream = (h2Stream: http2.ClientHttp2Stream) => {
      let responseStatus = 0;
      let responseStatusText = '';
      const errorChunks: Buffer[] = [];
      let errorBodyBytes = 0;
      const isErrorStatus = () =>
        responseStatus !== 0 && (responseStatus < 200 || responseStatus >= 300);

      h2Stream.on('response', (responseHeaders) => {
        resetTimeout();
        responseStatus = Number(responseHeaders[':status'] || 0);
        const grpc = responseHeaders['grpc-message'];
        const connectErr = responseHeaders['connect-error-message'];
        responseStatusText = String(grpc || connectErr || '');
      });
      h2Stream.on('data', (chunk) => {
        resetTimeout();
        const buf = Buffer.from(chunk);
        if (isErrorStatus()) {
          const remaining = MAX_ERROR_BODY_BYTES - errorBodyBytes;
          if (remaining > 0) {
            const kept = buf.subarray(0, remaining);
            errorChunks.push(kept);
            errorBodyBytes += kept.byteLength;
          }
        } else if (!writeMessage(buf)) {
          h2Stream.pause();
          stdout.once('drain', () => h2Stream.resume());
        }
      });

      return new Promise<{ ok: boolean }>((resolve) => {
        h2Stream.on('end', () => {
          if (isErrorStatus()) {
            const body = Buffer.concat(errorChunks).toString('utf8').trim();
            const detail = responseStatusText || body || 'HTTP/2 upstream request failed';
            writeMessage(
              connectEndStreamError(
                `http_${responseStatus}`,
                `Cursor HTTP ${responseStatus}: ${detail}`
              )
            );
            resolve({ ok: false });
            return;
          }
          resolve({ ok: true });
        });
        h2Stream.on('error', (err) => {
          log(`[h2-bridge] stream error: ${err instanceof Error ? err.message : String(err)}`);
          resolve({ ok: false });
        });
      });
    };

    if (unary) {
      const h2Stream = client.request(requestHeaders(accessToken));
      const ended = attachStream(h2Stream);
      const body = await reader.readMessage();
      if (exited) return;
      if (body && body.length > 0 && !h2Stream.closed && !h2Stream.destroyed) h2Stream.end(body);
      else h2Stream.end();
      const result = await ended;
      shutdown(result.ok ? 0 : 1);
      return;
    }

    let currentStream: http2.ClientHttp2Stream | null = client.request(requestHeaders(accessToken));
    let currentEnded = attachStream(currentStream);
    currentEnded.then((result) => {
      if (!result.ok) {
        shutdown(1);
        return;
      }
      if (!persistent) {
        shutdown(0);
        return;
      }
      writeMessage(STREAM_DONE_MAGIC);
      currentStream = null;
    });

    while (!exited) {
      const msg = await reader.readMessage();
      if (!msg || exited) {
        shutdown(0);
        return;
      }
      if (msg.length === 0) {
        if (currentStream && !currentStream.closed && !currentStream.destroyed) currentStream.end();
        if (!persistent) {
          shutdown(0);
          return;
        }
        continue;
      }
      const open = parseOpenCommand(msg);
      if (open) {
        if (!client || client.destroyed || client.closed) {
          log('[h2-bridge] cannot open stream: client closed');
          shutdown(1);
          return;
        }
        const token =
          typeof open.accessToken === 'string' && open.accessToken ? open.accessToken : accessToken;
        currentStream = client.request(requestHeaders(token));
        currentEnded = attachStream(currentStream);
        currentEnded.then((result) => {
          if (!result.ok) {
            shutdown(1);
            return;
          }
          writeMessage(STREAM_DONE_MAGIC);
          currentStream = null;
        });
        continue;
      }
      if (currentStream && !currentStream.closed && !currentStream.destroyed) {
        resetTimeout();
        if (!currentStream.write(msg)) {
          try {
            await once(currentStream, 'drain');
          } catch {
            break;
          }
        }
      }
    }
  })().catch((err) => {
    log(`[h2-bridge] ${err instanceof Error ? err.message : String(err)}`);
    shutdown(1);
  });

  return proc;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalMs(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0) return 0;
  return Math.floor(n);
}

function connectEndStreamError(code: string, message: string): Buffer {
  const payload = Buffer.from(JSON.stringify({ error: { code, message } }), 'utf8');
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0b00000010;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function parseOpenCommand(msg: Buffer): { cmd?: string; accessToken?: string } | undefined {
  if (!msg || msg.length === 0 || msg[0] !== 0x7b) return undefined;
  try {
    const parsed = JSON.parse(msg.toString('utf8')) as { cmd?: string; accessToken?: string };
    if (parsed && parsed.cmd === 'open') return parsed;
  } catch {
    // binary Connect 帧可能碰巧以 `{` 开头
  }
  return undefined;
}

function makeReader(stdin: PassThrough, onOverflow: () => void) {
  let chunks: Buffer[] = [];
  let length = 0;
  let ended = false;
  let wake: (() => void) | null = null;

  stdin.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    length += chunk.length;
    if (length > MAX_BRIDGE_MESSAGE_BYTES + 4) {
      onOverflow();
      return;
    }
    wake?.();
    wake = null;
  });
  stdin.on('end', () => {
    ended = true;
    wake?.();
    wake = null;
  });

  const wait = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });

  async function readExact(n: number): Promise<Buffer | null> {
    while (length < n) {
      if (ended) return null;
      await wait();
    }
    if (chunks.length > 1) chunks = [Buffer.concat(chunks, length)];
    const buf = chunks[0] ?? Buffer.alloc(0);
    const result = buf.subarray(0, n);
    const rest = buf.subarray(n);
    chunks = rest.length > 0 ? [rest] : [];
    length = rest.length;
    return Buffer.from(result);
  }

  return {
    async readMessage(): Promise<Buffer | null> {
      const lenBuf = await readExact(4);
      if (!lenBuf) return null;
      const len = lenBuf.readUInt32BE(0);
      if (len > MAX_BRIDGE_MESSAGE_BYTES) {
        throw new Error(`bridge input exceeds ${MAX_BRIDGE_MESSAGE_BYTES} bytes`);
      }
      if (len === 0) return Buffer.alloc(0);
      return readExact(len);
    },
  };
}
