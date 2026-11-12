import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SecureCodec } from './secureFile';
import { SshConnectionStore } from './sshConnectionStore';

const id = '11111111-1111-4111-8111-111111111111';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-ssh-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function store(encryption = true) {
  const codec: SecureCodec = {
    available: async () => encryption,
    encrypt: async (text) => Buffer.from(text, 'utf-8'),
    decrypt: async (data) => ({ text: data.toString('utf-8'), reEncrypt: false }),
  };
  const s = new SshConnectionStore({
    file: path.join(dir, 'ssh-connections.bin'),
    codec,
    randomUuid: () => id,
  });
  await s.ready();
  return s;
}

describe('SshConnectionStore', () => {
  it('list 投影无密码;密码模式写入后 hasPassword', async () => {
    const s = await store();
    const created = s.upsert({
      name: 'box',
      host: 'dev',
      user: 'root',
      auth: 'password',
      password: 's3cret',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toEqual({
      id,
      name: 'box',
      host: 'dev',
      user: 'root',
      auth: 'password',
      hasPassword: true,
    });
    expect(JSON.stringify(s.list())).not.toContain('s3cret');
    expect(s.getSecret(id)?.password).toBe('s3cret');
  });

  it('钥匙串不可用时拒绝保存密码连接', async () => {
    const s = await store(false);
    expect(s.upsert({ name: 'box', host: 'dev', auth: 'password', password: 'x' })).toEqual({
      ok: false,
      error: '无法加密保存密码:系统钥匙串不可用。',
    });
    expect(s.upsert({ name: 'key', host: 'dev', auth: 'key' }).ok).toBe(true);
  });

  it('改名可不重输密码;删除后口令消失', async () => {
    const s = await store();
    s.upsert({ name: 'a', host: 'h', auth: 'password', password: 'keep' });
    const renamed = s.upsert({ id, name: 'b', host: 'h', auth: 'password' });
    expect(renamed.ok).toBe(true);
    expect(s.getSecret(id)?.password).toBe('keep');
    expect(s.delete(id)).toEqual({ ok: true, value: null });
    expect(s.getSecret(id)).toBeUndefined();
  });
});
