import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app } from '@platform';
import type { SshAuth, SshConnection } from '@shared/types';
import { type SecureCodec, SecureJsonFile } from './secureFile';

export interface SshConnectionSecret {
  id: string;
  name: string;
  host: string;
  user?: string;
  port?: number;
  auth: SshAuth;
  password?: string;
}

export interface SshConnectionUpsert {
  id?: string;
  name: string;
  host: string;
  user?: string;
  port?: number;
  auth: SshAuth;
  password?: string;
}

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SshConnectionStoreOptions {
  file?: string;
  codec?: SecureCodec;
  randomUuid?: () => string;
}

interface Persisted {
  connections: SshConnectionSecret[];
}

export class SshConnectionStore {
  private readonly data: SecureJsonFile<Persisted>;
  private readonly randomUuid: () => string;

  constructor(options: SshConnectionStoreOptions = {}) {
    const file = options.file ?? path.join(app.getPath('userData'), 'ssh-connections.bin');
    this.data = new SecureJsonFile<Persisted>(
      () => file,
      () => ({ connections: [] }),
      (raw) => {
        const rows = (raw as Partial<Persisted> | null)?.connections;
        return { connections: Array.isArray(rows) ? rows : [] };
      },
      options.codec
    );
    this.randomUuid = options.randomUuid ?? randomUUID;
  }

  ready(): Promise<void> {
    return this.data.ready();
  }

  list(): SshConnection[] {
    return this.load().map(toPublic);
  }

  getSecret(id: string): SshConnectionSecret | undefined {
    return this.load().find((row) => row.id === id);
  }

  upsert(input: SshConnectionUpsert): StoreResult<SshConnection> {
    const name = input.name.trim();
    const host = input.host.trim();
    if (!name || !host) return { ok: false, error: '名称和主机不能为空。' };
    if (input.auth !== 'key' && input.auth !== 'password') {
      return { ok: false, error: '无效的认证方式。' };
    }
    const rows = this.load();
    const existing = input.id ? rows.find((row) => row.id === input.id) : undefined;
    if (input.id && !existing) return { ok: false, error: '连接不存在。' };
    let password = input.password;
    if (input.auth === 'password') {
      if (!password && existing?.auth === 'password') password = existing.password;
      if (!password) return { ok: false, error: '密码不能为空。' };
      if (!this.data.isSecure()) {
        return { ok: false, error: '无法加密保存密码:系统钥匙串不可用。' };
      }
    } else {
      password = undefined;
    }
    const record: SshConnectionSecret = {
      id: existing?.id ?? this.randomUuid(),
      name,
      host,
      auth: input.auth,
      ...(input.user?.trim() ? { user: input.user.trim() } : {}),
      ...(input.port && input.port !== 22 ? { port: input.port } : {}),
      ...(password ? { password } : {}),
    };
    const next = existing
      ? rows.map((row) => (row.id === record.id ? record : row))
      : [...rows, record];
    this.save(next);
    return { ok: true, value: toPublic(record) };
  }

  delete(id: string): StoreResult<null> {
    const rows = this.load();
    if (!rows.some((row) => row.id === id)) return { ok: false, error: '连接不存在。' };
    this.save(rows.filter((row) => row.id !== id));
    return { ok: true, value: null };
  }

  private load(): SshConnectionSecret[] {
    return this.data.get().connections;
  }

  private save(rows: SshConnectionSecret[]): void {
    void this.data.set({ connections: rows });
  }
}

function toPublic(row: SshConnectionSecret): SshConnection {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    auth: row.auth,
    hasPassword: Boolean(row.password),
    ...(row.user ? { user: row.user } : {}),
    ...(row.port ? { port: row.port } : {}),
  };
}

let singleton: SshConnectionStore | undefined;

export function getSshConnectionStore(): SshConnectionStore {
  singleton ??= new SshConnectionStore();
  return singleton;
}

export function setSshConnectionStore(store: SshConnectionStore | undefined): void {
  singleton = store;
}
