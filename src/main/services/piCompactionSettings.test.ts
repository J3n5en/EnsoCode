import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCompactReserveTokens, writeCompactReserveTokens } from './piCompactionSettings';

let dir: string;
let file: string;
const read = () => JSON.parse(readFileSync(file, 'utf8'));

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-compaction-')));
  file = join(dir, 'pi-agent', 'settings.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pi compaction.reserveTokens', () => {
  it('文件不存在时读为 null，写入后只新增该字段', () => {
    expect(readCompactReserveTokens(file)).toBeNull();
    expect(writeCompactReserveTokens(file, 32768)).toEqual({ ok: true });
    expect(read()).toEqual({ compaction: { reserveTokens: 32768 } });
    expect(readCompactReserveTokens(file)).toBe(32768);
  });

  it('保留其它字段；清空时删除字段，compaction 为空则一起删除', () => {
    mkdirSync(join(dir, 'pi-agent'));
    writeFileSync(
      file,
      `\uFEFF${JSON.stringify({ deviceId: 'd', compaction: { enabled: true, reserveTokens: 1 } })}`
    );
    expect(writeCompactReserveTokens(file, 20000)).toEqual({ ok: true });
    expect(read()).toEqual({ deviceId: 'd', compaction: { enabled: true, reserveTokens: 20000 } });
    expect(writeCompactReserveTokens(file, null)).toEqual({ ok: true });
    expect(read()).toEqual({ deviceId: 'd', compaction: { enabled: true } });
    writeFileSync(file, JSON.stringify({ deviceId: 'd', compaction: { reserveTokens: 9000 } }));
    expect(writeCompactReserveTokens(file, null)).toEqual({ ok: true });
    expect(read()).toEqual({ deviceId: 'd' });
  });

  it('文件损坏时不覆盖，读为 null', () => {
    mkdirSync(join(dir, 'pi-agent'));
    writeFileSync(file, '{ broken');
    expect(readCompactReserveTokens(file)).toBeNull();
    expect(writeCompactReserveTokens(file, 20000)).toEqual({ ok: false, error: 'invalid-file' });
    expect(readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('非法值不落盘；文件里的非法值读为 null', () => {
    expect(writeCompactReserveTokens(file, 10)).toEqual({ ok: false, error: 'invalid-value' });
    mkdirSync(join(dir, 'pi-agent'), { recursive: true });
    writeFileSync(file, JSON.stringify({ compaction: { reserveTokens: -5 } }));
    expect(readCompactReserveTokens(file)).toBeNull();
  });

  it('pi 正持有锁时等待失败也不写入', () => {
    mkdirSync(join(dir, 'pi-agent'));
    writeFileSync(file, '{}');
    mkdirSync(`${file}.lock`);
    expect(writeCompactReserveTokens(file, 20000)).toEqual({ ok: false, error: 'locked' });
    expect(read()).toEqual({});
  });
});
