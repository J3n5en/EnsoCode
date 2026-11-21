import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { appUserImageDirs, probeImageView, resolveRoots } from '@shared/secretary/imageView';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ImageReferences,
  SecretaryImageStore,
  secretaryImagesRoot,
  sessionFileReferences,
} from './inboundImages';

const CONV = '11111111-2222-4333-8444-555555555555';
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function png(seed: number, size = 32): Buffer {
  const data = Buffer.alloc(size, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  // IHDR：让 image_view 读得出宽高
  data.writeUInt32BE(13, 8);
  data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(4, 16);
  data.writeUInt32BE(4, 20);
  return data;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(options: { quota?: number; refs?: Set<string> | null } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'secretary-images-'));
  roots.push(userData);
  const refs = options.refs === undefined ? new Set<string>() : options.refs;
  const logs: string[] = [];
  const store = new SecretaryImageStore({
    root: secretaryImagesRoot(userData),
    references: async (): Promise<ImageReferences | null> =>
      refs ? (name) => refs.has(name) : null,
    now: () => NOW,
    log: (message) => logs.push(message),
    ...(options.quota !== undefined ? { quota: options.quota } : {}),
  });
  const dir = join(secretaryImagesRoot(userData), CONV);
  return { userData, store, dir, refs, logs };
}

function age(file: string, days: number): void {
  const at = new Date(NOW - days * DAY);
  utimesSync(file, at, at);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('SecretaryImageStore 落盘', () => {
  it('按内容哈希存进 bot-chats 下的会话目录，image_view 白名单直接接受', async () => {
    const { userData, store, dir } = setup();
    const [saved] = store.saveAll(CONV, [png(1)]);
    expect(saved).toMatchObject({ ok: true, size: 32 });
    if (!saved?.ok) throw new Error('not saved');
    expect(saved.path.startsWith(`${dir}/`)).toBe(true);
    expect(basename(saved.path)).toMatch(/^[a-f0-9]{64}\.png$/);
    const probe = await probeImageView(
      {
        realpath: (target) => realpath(target).catch(() => null),
        size: async (target) => (await stat(target)).size,
        read: (target) => readFile(target),
        roots: () => resolveRoots(appUserImageDirs(userData)),
      },
      saved.path
    );
    expect(probe).toMatchObject({ ok: true, size: 32 });
  });

  it('同一张图再发只存一份', () => {
    const { store, dir } = setup();
    const first = store.saveAll(CONV, [png(1), png(1)]);
    const again = store.saveAll(CONV, [png(1)]);
    expect(new Set([...first, ...again].map((item) => item.ok && item.path)).size).toBe(1);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('不是图片、超过 10MB 都拒收，不落盘', () => {
    const { store, dir } = setup();
    const big = Buffer.concat([png(2), Buffer.alloc(10 * 1024 * 1024)]);
    expect(store.saveAll(CONV, [Buffer.from('<svg/>'), big])).toEqual([
      { ok: false, reason: 'not-image' },
      { ok: false, reason: 'too-large' },
    ]);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('会话 id 不是 uuid 时不落盘，挡住路径穿越', () => {
    const { store } = setup();
    expect(store.saveAll('../../etc', [png(1)])).toEqual([{ ok: false, reason: 'unavailable' }]);
  });
});

describe('SecretaryImageStore 清理', () => {
  it('删会话即删整个图片目录', () => {
    const { store, dir } = setup();
    store.saveAll(CONV, [png(1), png(2)]);
    store.remove(CONV);
    expect(existsSync(dir)).toBe(false);
  });

  it('启动扫描：未被引用且超过 7 天的删掉，仍被引用的、7 天内的保留', async () => {
    const refs = new Set<string>();
    const { store } = setup({ refs });
    const [old, referenced, fresh] = store
      .saveAll(CONV, [png(1), png(2), png(3)])
      .map((item) => (item.ok ? item.path : ''));
    age(old as string, 8);
    age(referenced as string, 30);
    age(fresh as string, 6);
    refs.add(basename(referenced as string));
    // 设置页「清理」与启动扫描共用 sweep：统计供提示用
    expect(await store.sweep()).toEqual({ freed: 32, removed: 1, skipped: 2, failed: 0 });
    expect(existsSync(old as string)).toBe(false);
    expect(existsSync(referenced as string)).toBe(true);
    expect(existsSync(fresh as string)).toBe(true);
  });

  it('读不到会话消息时不清理', async () => {
    const { store } = setup({ refs: null });
    const [saved] = store.saveAll(CONV, [png(1)]);
    if (!saved?.ok) throw new Error('not saved');
    age(saved.path, 30);
    expect(await store.sweep()).toEqual({ freed: 0, removed: 0, skipped: 1, failed: 0 });
    expect(existsSync(saved.path)).toBe(true);
  });

  it('超过体积上限：从最旧的未引用文件删起，降到上限以下即停，仍被引用的不删', async () => {
    const refs = new Set<string>();
    const { store, dir } = setup({ refs, quota: 100 });
    const paths = store
      .saveAll(CONV, [png(1), png(2), png(3)])
      .map((item) => (item.ok ? item.path : ''));
    // 最旧的被引用，其次两张未引用
    age(paths[0] as string, 3);
    age(paths[1] as string, 2);
    age(paths[2] as string, 1);
    refs.add(basename(paths[0] as string));
    store.saveAll(CONV, [png(4)]);
    await settle();
    const left = readdirSync(dir);
    expect(left).toContain(basename(paths[0] as string));
    expect(left).not.toContain(basename(paths[1] as string));
    expect(left).toContain(basename(paths[2] as string));
    expect(left).toHaveLength(3);
  });

  it('全是被引用的旧文件时宁可超限也不删', async () => {
    const refs = new Set<string>();
    const { store, dir } = setup({ refs, quota: 50 });
    const paths = store.saveAll(CONV, [png(1), png(2)]).map((item) => (item.ok ? item.path : ''));
    for (const file of paths) {
      refs.add(basename(file));
      age(file, 30);
    }
    store.saveAll(CONV, [png(3)]);
    await settle();
    expect(readdirSync(dir)).toHaveLength(3);
  });

  it('刚存下、消息还没落盘的图不因超限被删', async () => {
    const { store, dir } = setup({ quota: 50 });
    store.saveAll(CONV, [png(1)]);
    store.saveAll(CONV, [png(2)]);
    await settle();
    expect(readdirSync(dir)).toHaveLength(2);
  });
});

describe('sessionFileReferences', () => {
  it('jsonl 里写着文件名就算引用；没有 jsonl 视为无引用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'secretary-refs-'));
    roots.push(dir);
    const file = join(dir, 's.jsonl');
    writeFileSync(file, '{"text":"[图片 1] /x/abc.png"}\n');
    const refs = await sessionFileReferences(file);
    expect(refs?.('abc.png')).toBe(true);
    expect(refs?.('def.png')).toBe(false);
    expect((await sessionFileReferences(join(dir, 'gone.jsonl')))?.('abc.png')).toBe(false);
  });
});
