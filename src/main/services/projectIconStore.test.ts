import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ICON_MAX_BYTES } from '@shared/projectIcon';
import { afterEach, describe, expect, it } from 'vitest';
import { handleLocalImageRequest, setProjectIconResolver } from './localImageProtocol';
import { customIconPath, ProjectIconStore } from './projectIconStore';

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function png(marker: number): Buffer {
  const bytes = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(8, 16);
  bytes.writeUInt32BE(8, 20);
  bytes[24] = marker;
  return bytes;
}

function revision(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

afterEach(async () => {
  setProjectIconResolver(async () => null);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('projectIconStore', () => {
  it('自定义图标压过扫描，扫描压过没有', async () => {
    const userData = await tempDir('enso-icon-user-');
    const project = await tempDir('enso-icon-proj-');
    const store = new ProjectIconStore(userData);
    await writeFile(join(project, 'favicon.svg'), '<svg>scan</svg>');

    const scanned = await store.getIcon('proj_1', project, 'local');
    expect(scanned.info.kind).toBe('scanned');
    expect(scanned.mimeType).toBe('image/svg+xml');
    expect(scanned.data?.toString()).toContain('scan');
    expect(scanned.info.revision).toBe(revision(scanned.data!));

    const custom = png(1);
    expect(await store.setCustomIcon('proj_1', custom)).toEqual({ ok: true });
    const uploaded = await store.getIcon('proj_1', project, 'local');
    expect(uploaded.info).toEqual({ revision: revision(custom), kind: 'custom' });
    expect(uploaded.data?.equals(custom)).toBe(true);
    expect(await readFile(customIconPath(userData, 'proj_1')!)).toEqual(custom);

    const replaced = png(2);
    await store.setCustomIcon('proj_1', replaced);
    const next = await store.getIcon('proj_1', project, 'local');
    expect(next.info.revision).not.toBe(uploaded.info.revision);
    expect(next.info.revision).toBe(revision(replaced));

    expect(await store.setCustomIcon('proj_1', null)).toEqual({ ok: true });
    const again = await store.getIcon('proj_1', project, 'local');
    expect(again.info.kind).toBe('scanned');
    expect(again.data?.toString()).toContain('scan');
  });

  it('没有图标时 kind 为 none', async () => {
    const store = new ProjectIconStore(await tempDir('enso-icon-user-'));
    const project = await tempDir('enso-icon-proj-');
    expect(await store.getIcon('proj_1', project, 'local')).toEqual({
      info: { revision: 'none', kind: 'none' },
      data: null,
      mimeType: null,
    });
  });

  it('拒绝非法 id、超限和非 png/jpeg/webp', async () => {
    const userData = await tempDir('enso-icon-user-');
    const store = new ProjectIconStore(userData);
    const image = png(1);
    expect((await store.setCustomIcon('', image)).ok).toBe(false);
    expect((await store.setCustomIcon('../x', image)).ok).toBe(false);
    expect((await store.setCustomIcon('a/b', image)).ok).toBe(false);
    expect((await store.setCustomIcon('a\\b', image)).ok).toBe(false);

    const dotted = await store.setCustomIcon('a.b', image);
    expect(dotted).toEqual({ ok: true });
    expect(customIconPath(userData, 'a.b')).toBe(
      join(userData, 'projects-icons', 'a_b', 'icon.png')
    );
    expect(await readFile(customIconPath(userData, 'a.b')!)).toEqual(image);

    const big = Buffer.alloc(PROJECT_ICON_MAX_BYTES + 1);
    image.copy(big);
    expect(await store.setCustomIcon('proj_1', big)).toEqual({ ok: false, error: 'too-large' });
    expect(
      await store.setCustomIcon('proj_1', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))
    ).toEqual({
      ok: false,
      error: 'unsupported-image',
    });
    expect(await store.setCustomIcon('proj_1', Buffer.from('hello'))).toEqual({
      ok: false,
      error: 'unsupported-image',
    });
  });

  it('ssh 和 scratch 不扫目录，本地和缺省 kind 会扫', async () => {
    const store = new ProjectIconStore(await tempDir('enso-icon-user-'));
    const project = await tempDir('enso-icon-proj-');
    await writeFile(join(project, 'favicon.svg'), '<svg></svg>');
    expect((await store.getIcon('p', project, 'ssh')).info.kind).toBe('none');
    expect((await store.getIcon('p', project, 'scratch')).info.kind).toBe('none');
    expect((await store.getIcon('p', project, 'secretary')).info.kind).toBe('none');
    expect((await store.getIcon('p', project, 'bot-home')).info.kind).toBe('none');
    expect((await store.getIcon('p', project, 'local')).info.kind).toBe('scanned');
    expect((await store.getIcon('q', project)).info.kind).toBe('scanned');
  });

  it('未命中 30 秒内不重复扫，命中看 mtime 且 60 秒后重读', async () => {
    let now = 1_000_000;
    const store = new ProjectIconStore(await tempDir('enso-icon-user-'), () => now);
    const project = await tempDir('enso-icon-proj-');
    expect((await store.getIcon('p', project, 'local')).info.kind).toBe('none');
    const file = join(project, 'favicon.svg');
    await writeFile(file, '<svg>1</svg>');
    expect((await store.getIcon('p', project, 'local')).info.kind).toBe('none');
    now += 30_000;
    const hit = await store.getIcon('p', project, 'local');
    expect(hit.data?.toString()).toContain('>1<');

    await writeFile(file, '<svg>2</svg>');
    const changed = await store.getIcon('p', project, 'local');
    expect(changed.data?.toString()).toContain('>2<');
    expect(changed.info.revision).not.toBe(hit.info.revision);
    expect(changed.data).not.toBe(hit.data);

    const cached = await store.getIcon('p', project, 'local');
    expect(cached.data).toBe(changed.data);
    now += 60_000;
    const reread = await store.getIcon('p', project, 'local');
    expect(reread.data).not.toBe(changed.data);
    expect(reread.data?.equals(changed.data!)).toBe(true);

    await rm(file);
    expect((await store.getIcon('p', project, 'local')).info.kind).toBe('none');
  });

  it('删掉自定义图标后立刻重新扫描，不被未命中缓存挡住', async () => {
    const now = 1_000_000;
    const store = new ProjectIconStore(await tempDir('enso-icon-user-'), () => now);
    const project = await tempDir('enso-icon-proj-');
    expect((await store.getIcon('p', project, 'local')).info.kind).toBe('none');
    await writeFile(join(project, 'favicon.svg'), '<svg></svg>');
    await store.setCustomIcon('p', png(4));
    expect((await store.getIcon('p', project, 'local')).info.kind).toBe('custom');
    await store.setCustomIcon('p', null);
    expect((await store.getIcon('p', project, 'local')).info.kind).toBe('scanned');
    expect(now).toBe(1_000_000);
  });

  it('ICO 抽出的 PNG 可以按文件服务，裸 ICO 不当命中', async () => {
    const userData = await tempDir('enso-icon-user-');
    const project = await tempDir('enso-icon-proj-');
    const store = new ProjectIconStore(userData);
    store.setProjectLookup((id) => (id === 'p' ? { canonicalPath: project, kind: 'local' } : null));
    const frame = png(5);
    const header = Buffer.alloc(6 + 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header[6] = 8;
    header[7] = 8;
    header.writeUInt32LE(frame.length, 14);
    header.writeUInt32LE(header.length, 18);
    await writeFile(join(project, 'favicon.ico'), Buffer.concat([header, frame]));

    const icon = await store.getIcon('p', project, 'local');
    expect(icon.info.kind).toBe('scanned');
    expect(icon.mimeType).toBe('image/png');
    expect(icon.data?.equals(frame)).toBe(true);
    const served = await store.serveIconFile('p');
    expect(served?.mimeType).toBe('image/png');
    expect(await readFile(served!.path)).toEqual(frame);

    await rm(join(project, 'favicon.ico'));
    const bare = Buffer.alloc(22);
    bare.writeUInt16LE(1, 2);
    bare.writeUInt16LE(1, 4);
    bare[6] = 16;
    bare[7] = 16;
    bare.writeUInt32LE(4, 14);
    bare.writeUInt32LE(22, 18);
    await writeFile(join(project, 'favicon.ico'), Buffer.concat([bare, Buffer.from('BMP!')]));
    expect((await store.getIcon('p', project, 'local')).info.kind).toBe('none');
  });

  it('协议按内容返回 svg/png，拒绝穿越和非图片', async () => {
    const userData = await tempDir('enso-icon-user-');
    const project = await tempDir('enso-icon-proj-');
    const store = new ProjectIconStore(userData);
    store.setProjectLookup((id) =>
      id === 'proj_1' ? { canonicalPath: project, kind: 'local' } : null
    );
    setProjectIconResolver((id) => store.serveIconFile(id));
    await writeFile(join(project, 'favicon.svg'), '<svg></svg>');

    const svg = await handleLocalImageRequest('local-image://project-icon/proj_1?v=1', null);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('access-control-allow-origin')).toBe('*');
    expect(svg.headers.get('cache-control')).toBe('max-age=31536000');
    expect(Buffer.from(await svg.arrayBuffer()).toString()).toContain('<svg');

    await store.setCustomIcon('proj_1', png(6));
    const custom = await handleLocalImageRequest('local-image://project-icon/proj_1?v=2', null);
    expect(custom.status).toBe(200);
    expect(custom.headers.get('content-type')).toBe('image/png');
    expect(custom.headers.get('access-control-allow-origin')).toBe('*');

    expect(
      (await handleLocalImageRequest('local-image://project-icon/%2e%2e%2fetc?v=1', null)).status
    ).toBe(403);
    expect((await handleLocalImageRequest('local-image://project-icon/?v=1', null)).status).toBe(
      403
    );
    expect(
      (await handleLocalImageRequest('local-image://project-icon/missing?v=1', null)).status
    ).toBe(404);

    const text = join(project, 'note.txt');
    await writeFile(text, 'not an image');
    setProjectIconResolver(async () => ({ path: text }));
    expect(
      (await handleLocalImageRequest('local-image://project-icon/proj_1?v=3', null)).status
    ).toBe(403);
  });
  it('项目删除后自定义图标与扫描物化副本被清理', async () => {
    const userData = await tempDir('enso-icon-user-');
    const project = await tempDir('enso-icon-proj-');
    const store = new ProjectIconStore(userData);
    await writeFile(join(project, 'favicon.svg'), '<svg></svg>');
    expect((await store.getIcon('proj_1', project, 'local')).info.kind).toBe('scanned');
    expect((await store.setCustomIcon('proj_1', png(9))).ok).toBe(true);
    const customFile = customIconPath(userData, 'proj_1');
    expect(customFile).not.toBeNull();
    await readFile(customFile!);

    store.removeProjectData('proj_1');

    await expect(readFile(customFile!)).rejects.toThrow();
    // 内存缓存也清掉：再拿同 id 是重新解析，不是旧命中
    const info = await store.getIcon('proj_1', project, 'local');
    expect(info.info.kind).toBe('scanned');
  });
});
