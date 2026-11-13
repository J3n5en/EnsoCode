import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { serveControlConnection } from '@shared/controlSocket';
import { describeConfig, getConfig, listConfig, planSet } from './policy';

/** 设置存储的最小读写面：生产接 ipc/settings，测试可替换 */
export interface ConfigCliDeps {
  fields: readonly string[];
  readState(): Record<string, unknown>;
  patch(field: string, value: unknown): { ok: boolean; error?: string };
  reload(): boolean;
  applyProxy(mode: unknown, customUrl: unknown): Promise<{ ok: boolean; error?: string }>;
}

export interface ConfigCliHandle {
  endpoint: string;
  tokenPath: string;
  close(): void;
}

const MAX_REQUEST_BYTES = 1024 * 1024;
const PROXY_FIELDS = new Set(['proxyMode', 'customProxyUrl']);

/** Unix 放 userData/cli/cli.sock（目录 0700）；Windows 用按 userData 区分的命名管道 */
export function cliEndpoint(userData: string, platform = process.platform): string {
  if (platform === 'win32') {
    const id = createHash('sha256').update(userData).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\enso-code-cli-${id}`;
  }
  return path.join(userData, 'cli', 'cli.sock');
}

function tokenMatches(expected: Buffer, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const actual = Buffer.from(provided);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function handleConfigRequest(
  line: string,
  token: Buffer,
  deps: ConfigCliDeps
): Promise<unknown> {
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    request = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'invalid json' };
  }
  if (!tokenMatches(token, request.token)) return { ok: false, error: 'unauthorized' };
  if (request.cmd !== 'config') return { ok: false, error: 'only config commands are supported' };
  const state = deps.readState();
  switch (request.action) {
    case 'get':
      return getConfig(state, request.key, deps.fields);
    case 'list':
      return { ok: true, entries: listConfig(state, deps.fields, request.prefix) };
    case 'schema':
      return { ok: true, ...describeConfig(state, deps.fields) };
    case 'set': {
      if (!('value' in request)) return { ok: false, error: 'set requires value' };
      const plan = planSet(state, request.key, request.value, deps.fields);
      if (!plan.ok) return plan;
      const result = deps.patch(plan.field, plan.value);
      if (!result.ok) return { ok: false, error: result.error ?? 'write failed' };
      if (PROXY_FIELDS.has(plan.field)) {
        const next = deps.readState();
        const applied = await deps.applyProxy(next.proxyMode, next.customProxyUrl);
        if (!applied.ok) return { ok: false, error: applied.error ?? 'proxy apply failed' };
      }
      return { ok: true };
    }
    case 'reload': {
      if (!deps.reload()) return { ok: false, error: 'settings.json missing or unreadable' };
      const next = deps.readState();
      await deps.applyProxy(next.proxyMode, next.customProxyUrl);
      return { ok: true };
    }
    default:
      return { ok: false, error: 'unknown config action' };
  }
}

/** 监听本机 socket / 命名管道（不开 TCP），token 写 userData/cli-token（0600） */
export function startConfigCli(userData: string, deps: ConfigCliDeps): Promise<ConfigCliHandle> {
  const endpoint = cliEndpoint(userData);
  const tokenPath = path.join(userData, 'cli-token');
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token);
  const unix = process.platform !== 'win32';
  if (unix) {
    mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(endpoint), 0o700);
    // 单实例锁保证没有别的实例在用：残留 socket 直接清掉
    rmSync(endpoint, { force: true });
  }
  // 先删再建：mode 只在新建时生效，避免沿用旧文件的宽权限
  rmSync(tokenPath, { force: true });
  writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  if (unix) chmodSync(tokenPath, 0o600);

  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    let received = 0;
    socket.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_REQUEST_BYTES) socket.destroy();
    });
    serveControlConnection(socket, (line) => handleConfigRequest(line, tokenBytes, deps));
  });
  const close = () => {
    server.close();
    rmSync(tokenPath, { force: true });
    if (unix) rmSync(endpoint, { force: true });
  };
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      rmSync(tokenPath, { force: true });
      reject(error);
    });
    server.listen(endpoint, () => {
      if (unix) chmodSync(endpoint, 0o600);
      resolve({ endpoint, tokenPath, close });
    });
  });
}
