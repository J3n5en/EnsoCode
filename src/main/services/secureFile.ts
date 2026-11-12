import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from '@platform';

/** safeStorage 的异步接口（同步版 Electron 45 弃用、46 移除） */
export interface SecureCodec {
  available(): Promise<boolean>;
  encrypt(text: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<{ text: string; reEncrypt: boolean }>;
}

export const platformCodec: SecureCodec = {
  available: async () => {
    try {
      return await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      return false;
    }
  },
  encrypt: (text) => safeStorage.encryptStringAsync(text),
  decrypt: async (data) => {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(data);
    return { text: result, reEncrypt: shouldReEncrypt };
  },
};

/**
 * 加密 JSON 文件：ready() 异步解密进内存，之后读写都走内存；落盘串行、原子写。
 * 钥匙串不可用时明文。ready 之前 get() 只有空值，入口须先 await ready()。
 */
export class SecureJsonFile<T> {
  private value: T;
  private secure = false;
  private dirty = false;
  /** 钥匙串不可用且旧文件读不出：多半是加密数据，不拿明文覆盖它 */
  private locked = false;
  private hydrating: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: () => string,
    empty: () => T,
    private readonly parse: (raw: unknown) => T,
    private readonly codec: SecureCodec = platformCodec
  ) {
    this.value = empty();
  }

  ready(): Promise<void> {
    this.hydrating ??= this.hydrate();
    return this.hydrating;
  }

  get(): T {
    return this.value;
  }

  isSecure(): boolean {
    return this.secure;
  }

  /** 内存立即生效；返回的 Promise 在本次落盘结束后 resolve，失败只记日志 */
  set(value: T): Promise<void> {
    this.value = value;
    this.dirty = true;
    const run = Promise.all([this.ready(), this.writing])
      .then(() => {
        if (this.locked) throw new Error('keychain unavailable, keeping existing encrypted file');
        return this.write(value);
      })
      .catch((error) => console.warn(`[secure-file] save ${this.file()} failed`, error));
    this.writing = run;
    return run;
  }

  flush(): Promise<void> {
    return this.writing;
  }

  private async hydrate(): Promise<void> {
    try {
      this.secure = await this.codec.available();
    } catch {
      this.secure = false;
    }
    let raw: Buffer;
    try {
      raw = await readFile(this.file());
    } catch {
      return;
    }
    if (this.dirty) return;
    try {
      const { text, reEncrypt } = this.secure
        ? await this.codec.decrypt(raw)
        : { text: raw.toString('utf-8'), reEncrypt: false };
      const parsed = this.parse(JSON.parse(text));
      if (this.dirty) return;
      this.value = parsed;
      if (reEncrypt) void this.set(parsed);
    } catch {
      // 损坏或换过钥匙串：当空库，重新配对/授权即可恢复
      if (!this.secure) this.locked = true;
    }
  }

  private async write(value: T): Promise<void> {
    const json = JSON.stringify(value);
    const data = this.secure ? await this.codec.encrypt(json) : Buffer.from(json, 'utf-8');
    const file = this.file();
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }
}
