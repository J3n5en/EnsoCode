import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProjectIcon, getProjectIcon } from './projectIconScanner';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'enso-icon-scan-'));
  dirs.push(dir);
  return dir;
}

function png(width: number, height: number, marker: number): Buffer {
  const bytes = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = marker;
  return bytes;
}

function ico(frames: Array<{ width: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const entries: Buffer[] = [];
  const bodies: Buffer[] = [];
  for (const frame of frames) {
    const entry = Buffer.alloc(16);
    entry[0] = frame.width === 256 ? 0 : frame.width;
    entry[1] = frame.width === 256 ? 0 : frame.width;
    entry.writeUInt32LE(frame.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    bodies.push(frame.png);
    offset += frame.png.length;
  }
  return Buffer.concat([header, ...entries, ...bodies]);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('projectIconScanner', () => {
  it('命中 favicon.svg', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'favicon.svg'), '<svg></svg>');
    const icon = await getProjectIcon(dir);
    expect(icon?.mimeType).toBe('image/svg+xml');
    expect(icon?.data.toString()).toContain('<svg');
  });

  it('非方形 PNG 不命中', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'favicon.png'), png(16, 32, 1));
    expect(await findProjectIcon(dir)).toBe(join(dir, 'favicon.png'));
    expect(await getProjectIcon(dir)).toBeNull();
  });

  it('超过 32KB 不命中', async () => {
    const dir = await tempDir();
    const big = Buffer.alloc(32 * 1024 + 1);
    png(16, 16, 1).copy(big);
    await writeFile(join(dir, 'favicon.png'), big);
    expect(await getProjectIcon(dir)).toBeNull();
  });

  it('ICO 抽出最大的 PNG 帧', async () => {
    const dir = await tempDir();
    const small = png(16, 16, 1);
    const large = png(32, 32, 9);
    await writeFile(
      join(dir, 'favicon.ico'),
      ico([
        { width: 16, png: small },
        { width: 32, png: large },
      ])
    );
    const icon = await getProjectIcon(dir);
    expect(icon?.mimeType).toBe('image/png');
    expect(icon?.data.equals(large)).toBe(true);
  });

  it('没有 PNG 帧的 ICO 仍按 image/x-icon 返回', async () => {
    const dir = await tempDir();
    const header = Buffer.alloc(22);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header[6] = 16;
    header[7] = 16;
    header.writeUInt32LE(4, 14);
    header.writeUInt32LE(22, 18);
    await writeFile(join(dir, 'favicon.ico'), Buffer.concat([header, Buffer.from('BMP!')]));
    const icon = await getProjectIcon(dir);
    expect(icon?.mimeType).toBe('image/x-icon');
  });

  it('扩展名是 ico、内容是方形 PNG 时按 PNG 返回', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'favicon.ico'), png(8, 8, 3));
    const icon = await getProjectIcon(dir);
    expect(icon?.mimeType).toBe('image/png');
    expect(icon?.data[24]).toBe(3);
  });

  it('priority 目录里的 logo.svg 优先于根目录 favicon.png', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'favicon.png'), png(8, 8, 1));
    await mkdir(join(dir, 'public'));
    await writeFile(join(dir, 'public', 'logo.svg'), '<svg>logo</svg>');
    expect(await findProjectIcon(dir)).toBe(join(dir, 'public', 'logo.svg'));
  });

  it('通配文件名按模式表命中', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'public'));
    await writeFile(join(dir, 'public', 'favicon-32.png'), png(32, 32, 7));
    const icon = await getProjectIcon(dir);
    expect(icon?.mimeType).toBe('image/png');
    expect(icon?.data[24]).toBe(7);
  });

  it('忽略 node_modules 和 src', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'favicon.svg'), '<svg></svg>');
    await writeFile(join(dir, 'src', 'favicon.svg'), '<svg></svg>');
    expect(await findProjectIcon(dir)).toBeNull();
  });

  it('项目根浅扫两层，再深不扫', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'favicon.svg'), '<svg>docs</svg>');
    expect(await findProjectIcon(dir)).toBe(join(dir, 'docs', 'favicon.svg'));

    await rm(join(dir, 'docs', 'favicon.svg'));
    await mkdir(join(dir, 'a', 'b', 'c'), { recursive: true });
    await writeFile(join(dir, 'a', 'b', 'c', 'favicon.svg'), '<svg>deep</svg>');
    expect(await findProjectIcon(dir)).toBeNull();
  });

  it('monorepo 包里先看 priority 目录', async () => {
    const dir = await tempDir();
    const web = join(dir, 'apps', 'web');
    await mkdir(join(web, 'public'), { recursive: true });
    await writeFile(join(web, 'favicon.png'), png(8, 8, 1));
    await writeFile(join(web, 'public', 'logo.svg'), '<svg>app</svg>');
    expect(await findProjectIcon(dir)).toBe(join(web, 'public', 'logo.svg'));
  });

  it('目录不存在时返回 null，不抛', async () => {
    const dir = await tempDir();
    expect(await getProjectIcon(join(dir, 'missing'))).toBeNull();
  });
});
