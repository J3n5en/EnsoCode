import path from 'node:path';
import { app } from '@platform';
import type { McpOAuthAccess, McpOAuthTokens } from '@shared/types/agent';
import { type SecureCodec, SecureJsonFile } from './secureFile';

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
  codec?: SecureCodec;
  now?: () => number;
}

interface Persisted {
  servers: Record<string, McpOAuthRecord>;
}

export class McpOAuthStore {
  private readonly data: SecureJsonFile<Persisted>;
  private readonly now: () => number;

  constructor(options: McpOAuthStoreOptions = {}) {
    const file = options.file ?? path.join(app.getPath('userData'), 'mcp-oauth.bin');
    this.data = new SecureJsonFile<Persisted>(
      () => file,
      () => ({ servers: {} }),
      (raw) => {
        const servers = (raw as Partial<Persisted> | null)?.servers;
        return { servers: servers && typeof servers === 'object' ? servers : {} };
      },
      options.codec
    );
    this.now = options.now ?? Date.now;
  }

  ready(): Promise<void> {
    return this.data.ready();
  }

  /** 等待已排队的落盘完成 */
  flush(): Promise<void> {
    return this.data.flush();
  }

  /** 钥匙串不可用时降级明文；供设置页/日志提示 */
  get encryptionDegraded(): boolean {
    return !this.data.isSecure();
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
    return this.data.get().servers;
  }

  private save(rows: Record<string, McpOAuthRecord>): void {
    void this.data.set({ servers: rows });
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
