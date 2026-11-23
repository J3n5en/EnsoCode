import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { USER_CSS_TEMPLATE } from '@shared/theme/userCssTemplate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureUserCss, readUserCss, USER_CSS_FILE, watchUserCss } from './userCss';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'enso-user-css-'));
  file = join(dir, USER_CSS_FILE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('user.css', () => {
  it('文件不存在、是目录或过大时读到 null', async () => {
    expect(await readUserCss(file)).toBeNull();
    expect(await readUserCss(dir)).toBeNull();
    writeFileSync(file, 'a'.repeat(1024 * 1024 + 1));
    expect(await readUserCss(file)).toBeNull();
    writeFileSync(file, 'a{color:red}');
    expect(await readUserCss(file)).toBe('a{color:red}');
  });

  it('首次打开写入模板，已有内容不被覆盖', async () => {
    await ensureUserCss(file);
    expect(readFileSync(file, 'utf8')).toBe(USER_CSS_TEMPLATE);
    writeFileSync(file, 'b{}');
    await ensureUserCss(file);
    expect(readFileSync(file, 'utf8')).toBe('b{}');
  });

  it('原子保存（写临时文件再改名）也会通知，连续写合并成一次', async () => {
    // macOS FSEvents 约 50ms 一批投递，改名与随后的写入可能分两批到达；防抖用假时钟，合并与否不取决于批次间隔
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const stop = watchUserCss(dir, () => calls++, 50);
    try {
      writeFileSync(join(dir, 'other.json'), '{}');
      await sleep(120);
      vi.advanceTimersByTime(50);
      expect(calls).toBe(0);
      writeFileSync(join(dir, 'user.css.tmp'), 'c{}');
      renameSync(join(dir, 'user.css.tmp'), file);
      writeFileSync(file, 'd{}');
      while (vi.getTimerCount() === 0) await sleep(10);
      await sleep(200);
      vi.advanceTimersByTime(50);
      expect(calls).toBe(1);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
