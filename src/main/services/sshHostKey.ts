import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SshHostKeyChallenge } from '@shared/types';

const KEY_TYPE_PREF = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
];

export type SshHostKeyKind = 'untrusted' | 'changed';

export interface ParsedSshKeyscanKey {
  hostToken: string;
  keyType: string;
  key: string;
  line: string;
}

export function classifySshHostKeyFailure(stderr: string): SshHostKeyKind | null {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'changed';
  if (/host key verification failed/i.test(stderr)) return 'untrusted';
  return null;
}

export function sshKeyFingerprint(keyB64: string): string {
  const digest = createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

export function parseSshKeyscanOutput(stdout: string): ParsedSshKeyscanKey | null {
  const parsed: ParsedSshKeyscanKey[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [hostToken, keyType, key] = parts;
    if (!hostToken || !keyType || !key) continue;
    if (!/^(ssh-|ecdsa-|sk-)/.test(keyType)) continue;
    parsed.push({ hostToken, keyType, key, line: `${hostToken} ${keyType} ${key}` });
  }
  for (const type of KEY_TYPE_PREF) {
    const hit = parsed.find((row) => row.keyType === type);
    if (hit) return hit;
  }
  return parsed[0] ?? null;
}

export function toSshHostKeyChallenge(
  input: ParsedSshKeyscanKey & { host: string; port: number }
): SshHostKeyChallenge {
  return {
    host: input.host,
    port: input.port,
    keyType: input.keyType,
    fingerprint: sshKeyFingerprint(input.key),
  };
}

export function challengeFromScan(
  host: string,
  port: number,
  scanned: ParsedSshKeyscanKey | null
): SshHostKeyChallenge {
  const resolvedPort = port && port !== 22 ? port : 22;
  if (!scanned) {
    return { host, port: resolvedPort, fingerprint: '', keyType: '' };
  }
  return toSshHostKeyChallenge({ ...scanned, host, port: resolvedPort });
}

export function defaultKnownHostsPath(): string {
  return path.join(homedir(), '.ssh', 'known_hosts');
}

function keyIdentity(line: string): string | null {
  const parsed = parseSshKeyscanOutput(line);
  return parsed ? `${parsed.keyType} ${parsed.key}` : null;
}

/** 写入 known_hosts；已有相同密钥返回 false */
export function appendKnownHostLine(file: string, line: string): boolean {
  const identity = keyIdentity(line);
  if (!identity) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  let existing = '';
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.split(/\r?\n/).some((row) => keyIdentity(row) === identity)) return false;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(file, `${existing}${prefix}${line}\n`);
  return true;
}

export type KeyscanRunner = (
  file: string,
  args: string[]
) => Promise<{ stdout: string; stderr?: string }>;

function runKeyscan(file: string, args: string[]): Promise<{ stdout: string; stderr?: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 12_000 }, (error, stdout, stderr) => {
      const out = `${stdout ?? ''}\n${stderr ?? ''}`;
      if (out.trim()) return resolve({ stdout: out });
      reject(error ?? new Error('ssh-keyscan failed'));
    });
  });
}

export async function scanSshHostKey(
  host: string,
  port = 22,
  run: KeyscanRunner = runKeyscan
): Promise<ParsedSshKeyscanKey | null> {
  const args = ['-T', '10'];
  if (port && port !== 22) args.push('-p', String(port));
  args.push(host);
  try {
    const result = await run('ssh-keyscan', args);
    return parseSshKeyscanOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } catch (error) {
    const stdout = String((error as { stdout?: unknown }).stdout ?? '');
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    return parseSshKeyscanOutput(`${stdout}\n${stderr}`);
  }
}

export type TrustSshHostKeyResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'mismatch'; error: string };

/**
 * 只把用户核对过的那把密钥写入 known_hosts：重新扫描，指纹与确认时展示的一致才写。
 * 两次扫描之间密钥被换（中间人）即拒绝；扫不到也不在这里兜底接受任意密钥。
 */
export async function trustSshHostKey(
  confirmed: Pick<SshHostKeyChallenge, 'host' | 'port' | 'fingerprint'>,
  file = defaultKnownHostsPath(),
  run: KeyscanRunner = runKeyscan
): Promise<TrustSshHostKeyResult> {
  const scanned = await scanSshHostKey(confirmed.host, confirmed.port, run);
  if (!scanned) {
    return { ok: false, reason: 'unavailable', error: '无法获取主机密钥，请重新测试连接。' };
  }
  if (sshKeyFingerprint(scanned.key) !== confirmed.fingerprint) {
    return { ok: false, reason: 'mismatch', error: '主机密钥已变化，请重新测试连接。' };
  }
  appendKnownHostLine(file, scanned.line);
  return { ok: true };
}
