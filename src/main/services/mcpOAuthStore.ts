import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from '@platform';
import type { McpOAuthAccess, McpOAuthTokens } from '@shared/types/agent';

/** 单个 MCP server 的授权状态：DCR 注册信息与 token 都按 McpServerEntry.id 归属 */
export interface McpOAuthRecord {
  serverUrl?: string;
  tokens?: McpOAuthTokens;
  /** access token 绝对过期时间（ms），保存 tokens 时按 expires_in 换算 */
  expiresAt?: number;
  /** SDK 动态注册（DCR）返回的 client 信息，换 token 与 refresh 都要用 */
  clientInformation?: Record<string, unknown>;
}

export interface McpOAuthStoreOptions {
  file?: string;
  encryptionAvailable?: () => boolean;
  encrypt?: (text: string) => Buffer;
  decrypt?: (buf: Buffer) => string;
  now?: () => number;
}

interface Persisted {
  servers: Record<string, McpOAuthRecord>;
}

export class McpOAuthStore {
  private readonly file: string;
  private readonly encryptionAvailable: () => boolean;
  private readonly encrypt: (text: string) => Buffer;
  private readonly decrypt: (buf: Buffer) => string;
  private readonly now: () => number;
  private cache: Record<string, McpOAuthRecord> | null = null;
  /** 钥匙串不可用时降级明文；留痕供设置页/日志提示 */
  encryptionDegraded = false;

  constructor(options: McpOAuthStoreOptions = {}) {
    this.file = options.file ?? path.join(app.getPath('userData'), 'mcp-oauth.bin');
    this.encryptionAvailable =
      options.encryptionAvailable ??
      (() => {
        try {
          return safeStorage.isEncryptionAvailable();
        } catch {
          return false;
        }
      });
    this.encrypt = options.encrypt ?? ((text) => safeStorage.encryptString(text));
    this.decrypt = options.decrypt ?? ((buf) => safeStorage.decryptString(buf));
    this.now = options.now ?? Date.now;
  }

  record(serverId: string): McpOAuthRecord | undefined {
    return this.load()[serverId];
  }

  tokens(serverId: string): McpOAuthTokens | undefined {
    return this.load()[serverId]?.tokens;
  }

  /** 下发 worker 的子集：不含 refresh_token */
  access(serverId: string): McpOAuthAccess | undefined {
    const row = this.load()[serverId];
    if (!row?.tokens?.access_token) return undefined;
    return {
      access_token: row.tokens.access_token,
      ...(row.expiresAt !== undefined ? { expires_at: row.expiresAt } : {}),
    };
  }

  saveTokens(serverId: string, tokens: McpOAuthTokens, serverUrl?: string): void {
    const expiresAt =
      typeof tokens.expires_in === 'number' ? this.now() + tokens.expires_in * 1000 : undefined;
    this.merge(serverId, { tokens, expiresAt, ...(serverUrl ? { serverUrl } : {}) });
  }

  saveClientInformation(
    serverId: string,
    clientInformation: Record<string, unknown>,
    serverUrl?: string
  ): void {
    this.merge(serverId, { clientInformation, ...(serverUrl ? { serverUrl } : {}) });
  }

  /** 原样写回整条记录（授权未完成时回滚用）：不经 saveTokens，过期时间不按 expires_in 重算 */
  restore(serverId: string, record: McpOAuthRecord): void {
    this.save({ ...this.load(), [serverId]: record });
  }

  /** 只弃用 token（重新授权前避开失效 refresh_token），DCR 注册信息保留 */
  clearTokens(serverId: string): void {
    const rows = this.load();
    const row = rows[serverId];
    if (!row?.tokens) return;
    const { tokens: _tokens, expiresAt: _expiresAt, ...rest } = row;
    this.save({ ...rows, [serverId]: rest });
  }

  clear(serverId: string): void {
    const rows = { ...this.load() };
    if (!(serverId in rows)) return;
    delete rows[serverId];
    this.save(rows);
  }

  /** serverId → 是否已有可用 token */
  authState(): Record<string, boolean> {
    const rows = this.load();
    return Object.fromEntries(
      Object.entries(rows).map(([id, row]) => [id, Boolean(row.tokens?.access_token)])
    );
  }

  private merge(serverId: string, patch: McpOAuthRecord): void {
    const rows = this.load();
    this.save({ ...rows, [serverId]: { ...rows[serverId], ...patch } });
  }

  private load(): Record<string, McpOAuthRecord> {
    if (this.cache) return this.cache;
    try {
      if (!existsSync(this.file)) {
        this.cache = {};
        return this.cache;
      }
      const raw = readFileSync(this.file);
      const json = this.encryptionAvailable() ? this.decrypt(raw) : raw.toString('utf-8');
      const parsed = JSON.parse(json) as Persisted;
      this.cache =
        parsed.servers && typeof parsed.servers === 'object' ? parsed.servers : ({} as never);
    } catch {
      // 损坏或换过钥匙串：当空库，重新授权即可恢复
      this.cache = {};
    }
    return this.cache;
  }

  private save(rows: Record<string, McpOAuthRecord>): void {
    this.cache = rows;
    const available = this.encryptionAvailable();
    this.encryptionDegraded = !available;
    const json = JSON.stringify({ servers: rows } satisfies Persisted);
    const data = available ? this.encrypt(json) : Buffer.from(json, 'utf-8');
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    // 钥匙串不可用时 refresh_token 是明文，与其它密钥文件一样只给本人读写
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

let singleton: McpOAuthStore | undefined;

export function getMcpOAuthStore(): McpOAuthStore {
  singleton ??= new McpOAuthStore();
  return singleton;
}

export function setMcpOAuthStore(store: McpOAuthStore | undefined): void {
  singleton = store;
}
