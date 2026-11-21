import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemImageRoots } from '@shared/secretary/imageView';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REPORT_IMAGE_MAX_COUNT,
  REPORT_IMAGE_RETENTION_MS,
  reportImageRoots,
  SecretaryReportStore,
  secretaryReportsRoot,
} from './reportImages';

const CONV = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

function png(seed: number, size = 64): Buffer {
  const data = Buffer.alloc(size, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  return data;
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function setup(options: { maxBytes?: number; totalBytes?: number } = {}) {
  const userData = temp('secretary-reports-');
  const allowed = temp('report-shots-');
  const outside = temp('report-outside-');
  let now = T0;
  const store = new SecretaryReportStore({
    root: secretaryReportsRoot(userData),
    roots: () => [allowed],
    now: () => now,
    log: () => {},
    ...options,
  });
  const dir = join(secretaryReportsRoot(userData), CONV);
  const shot = (name: string, data: Buffer = png(name.length)) => {
    const file = join(allowed, name);
    writeFileSync(file, data);
    return file;
  };
  return { userData, allowed, outside, store, dir, shot, tick: (ms: number) => (now += ms) };
}

const media = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((name) => name !== 'report.json') : [];

describe('SecretaryReportStore 归档', () => {
  it('把汇报里的截图按内容哈希复制到 userData/secretary-reports/<会话>/，正文照存', async () => {
    const { store, dir, shot } = setup();
    const a = shot('desk.png', png(1));
    const b = shot('mobile.png', png(2));
    const text = `完成。截图：${a}\n手机：\`${b}\``;
    const saved = await store.archive(CONV, T0, text);
    expect(saved?.images.map((image) => image.label)).toEqual(['desk.png', 'mobile.png']);
    const names = saved?.images.map((image) => ('name' in image ? image.name : null)) ?? [];
    expect(names.every((name) => name && /^[0-9a-f]{64}\.png$/.test(name))).toBe(true);
    expect(media(dir).sort()).toEqual([...(names as string[])].sort());
    expect(store.read(CONV)).toEqual({ at: T0, text, images: saved?.images });
    rmSync(a);
    expect(store.imageFile(CONV, names[0] as string)).toBe(join(dir, names[0] as string));
  });

  it('白名单外、符号链接越界、不存在、不是图片、超过单张上限的都标成不可用', async () => {
    const { store, dir, shot, outside } = setup({ maxBytes: 1024 });
    const far = join(outside, 'far.png');
    writeFileSync(far, png(3));
    const sneaky = shot('sneaky.png');
    rmSync(sneaky);
    symlinkSync(far, sneaky);
    const fake = shot('fake.png', Buffer.from('not an image at all'));
    const huge = shot('huge.png', png(4, 4096));
    const text = [far, sneaky, fake, huge, '/tmp/definitely-missing-report.png'].join('\n');
    const saved = await store.archive(CONV, T0, text);
    expect(saved?.images).toEqual([
      { label: 'far.png', missing: true },
      { label: 'sneaky.png', missing: true },
      { label: 'fake.png', missing: true },
      { label: 'huge.png', missing: true },
      { label: 'definitely-missing-report.png', missing: true },
    ]);
    expect(media(dir)).toEqual([]);
  });

  it(`每份最多 ${REPORT_IMAGE_MAX_COUNT} 张、总量超限的不再复制`, async () => {
    const { store, shot } = setup({ totalBytes: 64 * 3 });
    const files = Array.from({ length: 5 }, (_, index) => shot(`s${index}.png`, png(index + 10)));
    const saved = await store.archive(CONV, T0, files.join('\n'));
    expect(saved?.images.map((image) => 'name' in image)).toEqual([true, true, true, false, false]);
  });

  it('同一会话再次完成：换成新报告，旧截图删掉', async () => {
    const { store, dir, shot } = setup();
    await store.archive(CONV, T0, shot('old.png', png(5)));
    const saved = await store.archive(CONV, T0 + 1, shot('new.png', png(6)));
    const [image] = saved?.images ?? [];
    expect(media(dir)).toEqual([image && 'name' in image ? image.name : '']);
  });

  it('非法会话 id 与非法文件名一律拒绝', async () => {
    const { store, shot } = setup();
    expect(await store.archive('../x', T0, shot('a.png'))).toBeNull();
    expect(store.imageFile(CONV, '../report.json')).toBeNull();
    expect(store.imageFile('../x', `${'a'.repeat(64)}.png`)).toBeNull();
  });
});

describe('SecretaryReportStore 清理', () => {
  it(`完成 ${REPORT_IMAGE_RETENTION_MS / DAY} 天后扫掉截图，报告文字保留并标记过期`, async () => {
    const { store, dir, shot, tick } = setup();
    await store.archive(CONV, T0, `完成 ${shot('a.png')}`);
    tick(REPORT_IMAGE_RETENTION_MS - 1000);
    expect((await store.sweep()).removed).toBe(0);
    expect(media(dir)).toHaveLength(1);
    tick(2000);
    const stats = await store.sweep();
    expect(stats.removed).toBe(1);
    expect(stats.freed).toBeGreaterThan(0);
    expect(media(dir)).toEqual([]);
    expect(store.read(CONV)).toMatchObject({
      text: expect.stringContaining('完成'),
      imagesGone: 'expired',
    });
  });

  it('资源页清理删掉全部截图，报告标记已清理', async () => {
    const { store, dir, shot } = setup();
    await store.archive(CONV, T0, shot('a.png'));
    await store.archive(OTHER, T0, '没有截图');
    const stats = await store.clear();
    expect(stats.removed).toBe(1);
    expect(media(dir)).toEqual([]);
    expect(store.read(CONV)?.imagesGone).toBe('cleared');
    expect(store.read(OTHER)?.imagesGone).toBeUndefined();
  });

  it('扫掉时记下清理时刻', async () => {
    const { store, shot, tick } = setup();
    await store.archive(CONV, T0, shot('a.png'));
    tick(REPORT_IMAGE_RETENTION_MS + DAY);
    await store.sweep();
    expect(store.read(CONV)?.imagesGoneAt).toBe(T0 + REPORT_IMAGE_RETENTION_MS + DAY);
  });

  it('删除会话时整个目录一起删', async () => {
    const { store, dir, shot } = setup();
    await store.archive(CONV, T0, shot('a.png'));
    store.remove(CONV);
    expect(existsSync(dir)).toBe(false);
    expect(store.read(CONV)).toBeNull();
  });
});

describe('SecretaryReportStore 结果视图', () => {
  const gone = (store: SecretaryReportStore) =>
    store
      .view(CONV)
      ?.images.map((image) => ('missing' in image ? 'missing' : (image.gone ?? 'live')));

  it('全部过期：每张标成已过期，带保留天数与清理时刻', async () => {
    const { store, shot, tick } = setup();
    await store.archive(CONV, T0, `${shot('a.png', png(1))}\n${shot('b.png', png(2))}`);
    tick(REPORT_IMAGE_RETENTION_MS + DAY);
    await store.sweep();
    expect(gone(store)).toEqual(['expired', 'expired']);
    expect(store.view(CONV)).toMatchObject({
      at: T0,
      retentionDays: REPORT_IMAGE_RETENTION_MS / DAY,
      imagesGoneAt: T0 + REPORT_IMAGE_RETENTION_MS + DAY,
    });
  });

  it('部分过期：文件还在的照常，过了保留期没了的标已过期', async () => {
    const { store, dir, shot, tick } = setup();
    const saved = await store.archive(
      CONV,
      T0,
      `${shot('a.png', png(1))}\n${shot('b.png', png(2))}`
    );
    tick(REPORT_IMAGE_RETENTION_MS + DAY);
    const [first] = saved?.images ?? [];
    rmSync(join(dir, first && 'name' in first ? first.name : ''));
    expect(gone(store)).toEqual(['expired', 'live']);
    expect(store.view(CONV)?.imagesGoneAt).toBe(T0 + REPORT_IMAGE_RETENTION_MS);
  });

  it('保留期内文件没了算无法显示，不算过期；复制时就没成的照旧无法显示', async () => {
    const { store, dir, shot } = setup();
    const saved = await store.archive(
      CONV,
      T0,
      `${shot('a.png', png(1))}\n${shot('b.png', png(2))}\n/tmp/definitely-missing-report.png`
    );
    const [first] = saved?.images ?? [];
    rmSync(join(dir, first && 'name' in first ? first.name : ''));
    expect(gone(store)).toEqual(['missing', 'live', 'missing']);
    expect(store.view(CONV)?.imagesGoneAt).toBeUndefined();
  });

  it('资源页清理的标成已清理', async () => {
    const { store, shot } = setup();
    await store.archive(CONV, T0, shot('a.png'));
    await store.clear();
    expect(gone(store)).toEqual(['cleared']);
    expect(store.view(CONV)?.imagesGoneAt).toBe(T0);
  });
});

describe('reportImageRoots', () => {
  it('只放系统临时目录与会话 worktree 根', () => {
    expect(reportImageRoots(undefined)).toEqual(systemImageRoots());
    expect(reportImageRoots('/Users/me/wt/x')).toEqual([...systemImageRoots(), '/Users/me/wt/x']);
  });
});
