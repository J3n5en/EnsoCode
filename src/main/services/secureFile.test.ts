import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import { type SecureCodec, SecureJsonFile } from './secureFile';

let dir: string;
const file = () => path.join(dir, 'store.bin');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-secure-file-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function codec(available = true, reEncrypt = false): SecureCodec {
  return {
    available: async () => available,
    encrypt: async (text) => Buffer.from(`enc:${text}`, 'utf-8'),
    decrypt: async (data) => {
      const text = data.toString('utf-8');
      if (!text.startsWith('enc:')) throw new Error('bad cipher');
      return { text: text.slice(4), reEncrypt };
    },
  };
}

function open(c: SecureCodec = codec()) {
  return new SecureJsonFile<string[]>(
    file,
    () => [],
    (raw) => (Array.isArray(raw) ? raw : []),
    c
  );
}

describe('SecureJsonFile', () => {
  it('加密写入后新实例异步解密读回', async () => {
    const store = open();
    await store.ready();
    expect(store.isSecure()).toBe(true);
    await store.set(['a']);
    expect(readFileSync(file(), 'utf-8')).toBe('enc:["a"]');
    const reopened = open();
    expect(reopened.get()).toEqual([]);
    await reopened.ready();
    expect(reopened.get()).toEqual(['a']);
  });

  it('钥匙串不可用时明文读写', async () => {
    const store = open(codec(false));
    await store.ready();
    expect(store.isSecure()).toBe(false);
    await store.set(['plain']);
    expect(readFileSync(file(), 'utf-8')).toBe('["plain"]');
  });

  it('文件缺失、解不开或坏 JSON 都当空库', async () => {
    const missing = open();
    await missing.ready();
    expect(missing.get()).toEqual([]);
    writeFileSync(file(), 'not-encrypted');
    const undecryptable = open();
    await undecryptable.ready();
    expect(undecryptable.get()).toEqual([]);
    writeFileSync(file(), 'enc:{oops');
    const broken = open();
    await broken.ready();
    expect(broken.get()).toEqual([]);
  });

  it('写入立即反映到内存，落盘按调用顺序串行', async () => {
    const store = open();
    await store.ready();
    void store.set(['1']);
    void store.set(['1', '2']);
    expect(store.get()).toEqual(['1', '2']);
    await store.flush();
    expect(readFileSync(file(), 'utf-8')).toBe('enc:["1","2"]');
  });

  it('解密提示需重新加密时按新密钥回写', async () => {
    writeFileSync(file(), 'enc:["old"]');
    const encrypt = vi.fn(async (text: string) => Buffer.from(`enc:${text}`, 'utf-8'));
    const store = open({ ...codec(true, true), encrypt });
    await store.ready();
    await store.flush();
    expect(store.get()).toEqual(['old']);
    expect(encrypt).toHaveBeenCalledWith('["old"]');
  });

  it('hydrate 前的写入不被盘上旧值覆盖，且等 hydrate 定下加密姿态后才落盘', async () => {
    writeFileSync(file(), 'enc:["disk"]');
    const store = open();
    const written = store.set(['early']);
    await store.ready();
    await written;
    expect(store.get()).toEqual(['early']);
    expect(readFileSync(file(), 'utf-8')).toBe('enc:["early"]');
  });

  it('某次落盘失败不阻断后续写入', async () => {
    let fail = true;
    const store = open({
      ...codec(),
      encrypt: async (text) => {
        if (fail) throw new Error('keychain locked');
        return Buffer.from(`enc:${text}`, 'utf-8');
      },
    });
    await store.ready();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(store.set(['x'])).resolves.toBeUndefined();
    fail = false;
    await store.set(['y']);
    expect(readFileSync(file(), 'utf-8')).toBe('enc:["y"]');
    warn.mockRestore();
  });

  it('钥匙串不可用时不拿明文覆盖读不出的旧加密文件', async () => {
    writeFileSync(file(), 'enc:["paired"]');
    const store = open(codec(false));
    await store.ready();
    expect(store.get()).toEqual([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store.set(['new']);
    expect(store.get()).toEqual(['new']);
    expect(readFileSync(file(), 'utf-8')).toBe('enc:["paired"]');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
