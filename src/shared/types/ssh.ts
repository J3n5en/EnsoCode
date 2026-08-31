import { isUuid } from '../builtinAgents';

export type SshAuth = 'key' | 'password';

/** 渲染层可见的连接投影；密码永不出现 */
export interface SshConnection {
  id: string;
  name: string;
  host: string;
  user?: string;
  port?: number;
  auth: SshAuth;
  hasPassword: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const allowed = ['id', 'name', 'host', 'user', 'port', 'auth', 'hasPassword'] as const;

export function parseSshConnection(value: unknown): SshConnection | null {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => (allowed as readonly string[]).includes(key))
  ) {
    return null;
  }
  if (!isUuid(value.id) || !isNonEmptyString(value.name) || !isNonEmptyString(value.host)) {
    return null;
  }
  if (value.auth !== 'key' && value.auth !== 'password') return null;
  if (typeof value.hasPassword !== 'boolean') return null;
  if (value.user !== undefined && typeof value.user !== 'string') return null;
  if (
    value.port !== undefined &&
    (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535)
  ) {
    return null;
  }
  return value as unknown as SshConnection;
}
