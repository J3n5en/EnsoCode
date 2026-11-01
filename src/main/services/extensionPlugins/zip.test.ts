import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractZip } from './zip';

interface ZipEntryInput {
  name: string;
  data?: string | Buffer;
  method?: 0 | 8;
  /** 只改中央目录的 uncompressed size，本地头仍写真实长度 */
  declaredUncompressedSize?: number;
  unixMode?: number;
}

function buildZip(entries: ZipEntryInput[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const declared = entry.declaredUncompressedSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([local, name, compressed]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    const external = entry.unixMode === undefined ? 0 : (entry.unixMode & 0xffff) * 0x10000;
    central.writeUInt32LE(external, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(localRecord);
    centrals.push(Buffer.concat([central, name]));
    offset += localRecord.length;
  }

  const centralDir = Buffer.concat(centrals);
  const commentBuf = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  return Buffer.concat([...locals, centralDir, eocd, commentBuf]);
}

describe('extractZip', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'enso-zip-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeZip(name: string, bytes: Buffer): string {
    const zipPath = path.join(tmp, name);
    writeFileSync(zipPath, bytes);
    return zipPath;
  }

  function destDir(): string {
    const dest = path.join(tmp, 'out');
    mkdirSync(dest);
    return dest;
  }

  it('解压 stored 与 deflate 条目并保留子目录和顶层目录', async () => {
    const zipPath = writeZip(
      'ok.zip',
      buildZip([
        { name: 'demo/', method: 0 },
        { name: 'demo/enso-plugin.json', data: '{"name":"demo"}', method: 0 },
        { name: 'demo/src/', method: 0 },
        { name: 'demo/src/a.txt', data: 'deflated-body', method: 8 },
      ])
    );
    const dest = destDir();

    await extractZip(zipPath, dest);

    expect(readFileSync(path.join(dest, 'demo/enso-plugin.json'), 'utf8')).toBe('{"name":"demo"}');
    expect(readFileSync(path.join(dest, 'demo/src/a.txt'), 'utf8')).toBe('deflated-body');
    expect(statSync(path.join(dest, 'demo/src')).isDirectory()).toBe(true);
    expect(existsSync(path.join(dest, 'enso-plugin.json'))).toBe(false);
    expect(existsSync(path.join(dest, 'src/a.txt'))).toBe(false);
  });

  it('拒绝 ../ 路径穿越', async () => {
    const zipPath = writeZip('slip.zip', buildZip([{ name: '../x', data: 'pwn', method: 0 }]));
    const dest = destDir();

    await expect(extractZip(zipPath, dest)).rejects.toThrow(/上级目录/);
    expect(existsSync(path.join(tmp, 'x'))).toBe(false);
  });

  it('拒绝绝对路径', async () => {
    const zipPath = writeZip('abs.zip', buildZip([{ name: '/x', data: 'pwn', method: 0 }]));

    await expect(extractZip(zipPath, destDir())).rejects.toThrow(/绝对路径/);
  });

  it('拒绝包含反斜杠的条目名', async () => {
    const zipPath = writeZip(
      'slash.zip',
      buildZip([{ name: 'foo\\bar.txt', data: 'x', method: 0 }])
    );

    await expect(extractZip(zipPath, destDir())).rejects.toThrow(/反斜杠/);
  });

  it('拒绝符号链接条目', async () => {
    const zipPath = writeZip(
      'link.zip',
      buildZip([{ name: 'link', data: 'target', method: 0, unixMode: 0o120777 }])
    );
    const dest = destDir();

    await expect(extractZip(zipPath, dest)).rejects.toThrow(/符号链接/);
    expect(existsSync(path.join(dest, 'link'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('保留 Unix 可执行位', async () => {
    const zipPath = writeZip(
      'mode.zip',
      buildZip([
        { name: 'bin/tool', data: '#!/bin/sh', method: 0, unixMode: 0o100755 },
        { name: 'bin/data', data: 'x', method: 8, unixMode: 0o100644 },
        { name: 'plain', data: 'y', method: 0 },
      ])
    );
    const dest = destDir();

    await extractZip(zipPath, dest);

    expect(statSync(path.join(dest, 'bin/tool')).mode & 0o111).not.toBe(0);
    expect(statSync(path.join(dest, 'bin/data')).mode & 0o111).toBe(0);
    expect(statSync(path.join(dest, 'plain')).mode & 0o111).toBe(0);
  });

  it('条目数超过上限时抛错', async () => {
    const zipPath = writeZip(
      'many.zip',
      buildZip([
        { name: 'a.txt', data: 'a', method: 0 },
        { name: 'b.txt', data: 'b', method: 0 },
        { name: 'c.txt', data: 'c', method: 0 },
      ])
    );

    await expect(extractZip(zipPath, destDir(), { maxEntries: 2 })).rejects.toThrow(/条目过多/);
  });

  it('单个条目超过大小上限时抛错', async () => {
    const zipPath = writeZip(
      'big.zip',
      buildZip([{ name: 'big.txt', data: '0123456789abcdef', method: 0 }])
    );

    await expect(extractZip(zipPath, destDir(), { maxEntryBytes: 8 })).rejects.toThrow(
      /单个条目超过大小限制：big\.txt/
    );
  });

  it('声明的解压大小与实际不符时抛错', async () => {
    const zipPath = writeZip(
      'lie.zip',
      buildZip([
        {
          name: 'lie.txt',
          data: 'hello',
          method: 8,
          declaredUncompressedSize: 100,
        },
      ])
    );

    await expect(extractZip(zipPath, destDir())).rejects.toThrow(/声明不一致/);
  });

  it('非 zip 文件抛错', async () => {
    const zipPath = writeZip('nope.zip', Buffer.from('this is not a zip'));

    await expect(extractZip(zipPath, destDir())).rejects.toThrow(/不是有效的 ZIP/);
  });

  it('带注释的 EOCD 仍能解压', async () => {
    const zipPath = writeZip(
      'comment.zip',
      buildZip([{ name: 'note.txt', data: 'with-comment', method: 0 }], '插件包注释')
    );
    const dest = destDir();

    await extractZip(zipPath, dest);

    expect(readFileSync(path.join(dest, 'note.txt'), 'utf8')).toBe('with-comment');
  });
});
