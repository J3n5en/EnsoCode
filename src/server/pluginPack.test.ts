import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { packPlugin } from './pluginPack';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'enso-plugin-pack-'));
  roots.push(root);
  return root;
}

const manifest = {
  schemaVersion: 1,
  id: 'example.demo',
  name: 'Demo',
  version: '1.2.3',
  permissions: [] as const,
};

function writeTree(dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, ...name.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** 只认本地头 + 中央目录 + EOCD，并核对 deflate 与固定时间戳。 */
function readZip(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8);
    const time = buf.readUInt16LE(offset + 10);
    const date = buf.readUInt16LE(offset + 12);
    const storedCrc = buf.readUInt32LE(offset + 14);
    const compSize = buf.readUInt32LE(offset + 18);
    const rawSize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
    const dataStart = nameStart + nameLen + extraLen;
    expect(method, name).toBe(8);
    expect(time, name).toBe(0);
    expect(date, name).toBe(0x21);
    const data = Buffer.from(inflateRawSync(buf.subarray(dataStart, dataStart + compSize)));
    expect(data.length, name).toBe(rawSize);
    expect(crc32(data) >>> 0, name).toBe(storedCrc);
    entries.push({ name, data });
    offset = dataStart + compSize;
  }

  const centralStart = offset;
  const names: string[] = [];
  while (offset + 4 <= buf.length && buf.readUInt32LE(offset) === 0x02014b50) {
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localName = buf
      .subarray(localOffset + 30, localOffset + 30 + localNameLen)
      .toString('utf8');
    expect(localName).toBe(name);
    expect(buf.readUInt16LE(offset + 10)).toBe(8);
    expect(buf.readUInt16LE(offset + 12)).toBe(0);
    expect(buf.readUInt16LE(offset + 14)).toBe(0x21);
    names.push(name);
    offset += 46 + nameLen + extraLen + commentLen;
  }

  expect(buf.readUInt32LE(offset)).toBe(0x06054b50);
  expect(buf.readUInt16LE(offset + 8)).toBe(entries.length);
  expect(buf.readUInt16LE(offset + 10)).toBe(entries.length);
  expect(buf.readUInt32LE(offset + 12)).toBe(offset - centralStart);
  expect(buf.readUInt32LE(offset + 16)).toBe(centralStart);
  expect(offset + 22 + buf.readUInt16LE(offset + 20)).toBe(buf.length);
  expect(names).toEqual(entries.map((entry) => entry.name));
  return entries;
}

describe('packPlugin', () => {
  it('打包清单校验通过的目录，排除隐藏项、node_modules、zip 和 test 目录', () => {
    const root = tempRoot();
    const dir = join(root, 'plugin');
    writeTree(dir, {
      'enso-plugin.json': `${JSON.stringify(manifest, null, 2)}\n`,
      'main.mjs': 'export {}\n',
      'README.md': 'hello\n',
      'nested/keep.txt': '保留\n',
      'src/util.mjs': 'util\n',
      'empty.txt': '',
      'test.txt': 'not a dir\n',
      'tests/also.js': 'keep tests\n',
      '.hidden': 'no\n',
      '.git/config': 'no\n',
      'src/.env': 'no\n',
      'node_modules/leftpad/index.js': 'no\n',
      'vendor/node_modules/pkg/index.js': 'no\n',
      'extra.zip': 'no\n',
      'docs/bundle.zip': 'no\n',
      'test/skip.js': 'no\n',
      'src/test/nope.js': 'no\n',
    });

    const packed = packPlugin(dir, { hostVersion: '0.3.3' });
    expect(packed).toMatchObject({
      file: join(root, 'example.demo-1.2.3.zip'),
      id: 'example.demo',
      version: '1.2.3',
    });
    const bytes = readFileSync(packed.file);
    expect(packed.size).toBe(bytes.length);
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);

    const entries = readZip(bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      'README.md',
      'empty.txt',
      'enso-plugin.json',
      'main.mjs',
      'nested/keep.txt',
      'src/util.mjs',
      'test.txt',
      'tests/also.js',
    ]);
    const body = (name: string) => entries.find((entry) => entry.name === name)?.data;
    expect(body('enso-plugin.json')?.equals(readFileSync(join(dir, 'enso-plugin.json')))).toBe(
      true
    );
    expect(body('main.mjs')?.toString()).toBe('export {}\n');
    expect(body('nested/keep.txt')?.toString()).toBe('保留\n');
    expect(body('empty.txt')?.length).toBe(0);
    expect(
      entries.some((entry) => entry.name.includes('node_modules') || entry.name.endsWith('.zip'))
    ).toBe(false);

    utimesSync(join(dir, 'main.mjs'), new Date(), new Date(Date.now() + 60_000));
    const again = packPlugin(dir, { hostVersion: '0.3.3', out: join(root, 'again.zip') });
    expect(again.sha256).toBe(packed.sha256);
    expect(readFileSync(again.file).equals(bytes)).toBe(true);
  });

  it('坏清单、非法 JSON 和缺失清单都抛 Error', () => {
    const root = tempRoot();
    const dir = join(root, 'bad');
    mkdirSync(dir);
    expect(() => packPlugin(dir, { hostVersion: '0.3.3' })).toThrow('找不到清单 enso-plugin.json');

    writeFileSync(join(dir, 'enso-plugin.json'), '{');
    expect(() => packPlugin(dir, { hostVersion: '0.3.3' })).toThrow('清单不是合法 JSON');

    writeFileSync(join(dir, 'enso-plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'nope' }));
    expect(() => packPlugin(dir, { hostVersion: '0.3.3' })).toThrow(
      'id 不合法\nname 不合法\nversion 不合法\npermissions 必须是数组'
    );

    writeFileSync(
      join(dir, 'enso-plugin.json'),
      JSON.stringify({ ...manifest, engines: { enso: '>=9.0.0' } })
    );
    expect(() => packPlugin(dir, { hostVersion: '0.3.3' })).toThrow('需要 Enso >=9.0.0');
  });
});
