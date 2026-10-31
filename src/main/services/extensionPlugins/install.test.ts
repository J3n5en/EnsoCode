import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArchiveFetch } from './download';
import { commitStaged, pluginPackagePath, stagePlugin } from './install';

const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const manifest = {
  schemaVersion: 1,
  id: 'example.demo',
  name: 'Demo',
  version: '1.0.0',
  main: 'main.js',
  permissions: ['agent.tool'],
  contributes: {
    agentTools: [{ name: 'lookup', description: 'd', parameters: { type: 'object' } }],
  },
};

function writePlugin(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

describe('stagePlugin（目录来源）', () => {
  it('复制到暂存区并解析清单', async () => {
    const src = temp('src-');
    const root = temp('root-');
    writePlugin(src, {
      'enso-plugin.json': JSON.stringify(manifest),
      'main.js': 'export {}',
      '.git/HEAD': 'x',
    });
    const result = await stagePlugin(root, { kind: 'dir', path: src }, '0.2.12');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staged.manifest.id).toBe('example.demo');
    expect(existsSync(join(result.staged.pluginRoot, 'main.js'))).toBe(true);
    expect(existsSync(join(result.staged.pluginRoot, '.git'))).toBe(false);
    expect(result.staged.pluginRoot.startsWith(root)).toBe(true);
  });

  it('缺清单、清单不合法、引用文件不存在都失败且不留暂存文件', async () => {
    const root = temp('root-');
    const noManifest = temp('src-');
    writePlugin(noManifest, { 'main.js': '' });
    const bad = temp('src-');
    writePlugin(bad, { 'enso-plugin.json': '{"schemaVersion":2}' });
    const missingMain = temp('src-');
    writePlugin(missingMain, { 'enso-plugin.json': JSON.stringify(manifest) });
    for (const src of [noManifest, bad, missingMain]) {
      const result = await stagePlugin(root, { kind: 'dir', path: src }, '0.2.12');
      expect(result.ok).toBe(false);
    }
    expect(existsSync(join(root, 'staging')) ? readdirSync(join(root, 'staging')) : []).toEqual([]);
  });

  it('拒绝包含符号链接的插件目录', async () => {
    const src = temp('src-');
    const root = temp('root-');
    writePlugin(src, { 'enso-plugin.json': JSON.stringify(manifest), 'main.js': '' });
    symlinkSync('/etc', join(src, 'escape'));
    const result = await stagePlugin(root, { kind: 'dir', path: src }, '0.2.12');
    expect(result.ok).toBe(false);
  });

  it('引用的 skills 必须是插件内的目录', async () => {
    const src = temp('src-');
    const root = temp('root-');
    writePlugin(src, {
      'enso-plugin.json': JSON.stringify({
        ...manifest,
        contributes: { ...manifest.contributes, skills: ['skills/x'] },
      }),
      'main.js': '',
      'skills/x': 'not a dir',
    });
    expect((await stagePlugin(root, { kind: 'dir', path: src }, '0.2.12')).ok).toBe(false);
  });

  it('预设引用的正文必须是插件内的文件', async () => {
    const src = temp('src-');
    const root = temp('root-');
    writePlugin(src, {
      'enso-plugin.json': JSON.stringify({
        ...manifest,
        contributes: {
          ...manifest.contributes,
          presets: [
            {
              id: 'review',
              name: 'Review',
              skills: [],
              mcpServers: [],
              systemPrompt: 'prompts/role.md',
            },
          ],
        },
      }),
      'main.js': '',
    });
    expect((await stagePlugin(root, { kind: 'dir', path: src }, '0.2.12')).ok).toBe(false);
  });
});

function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localRecord = Buffer.concat([local, nameBuf, raw]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(localRecord);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localRecord.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

describe('stagePlugin（URL 来源）', () => {
  it('下载 zip 后按包内清单暂存，不引用原地址', async () => {
    const root = temp('root-');
    const zip = storedZip({
      'enso-plugin.json': JSON.stringify(manifest),
      'main.js': 'export {}',
    });
    const fetchImpl: ArchiveFetch = async () => ({
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(zip);
          controller.close();
        },
      }),
    });
    const result = await stagePlugin(
      root,
      { kind: 'url', url: 'https://example.com/demo.zip' },
      '0.2.12',
      { fetch: fetchImpl }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.staged.manifest.id).toBe('example.demo');
    expect(readFileSync(join(result.staged.pluginRoot, 'main.js'), 'utf8')).toBe('export {}');
    expect(result.staged.pluginRoot.startsWith(root)).toBe(true);
  });

  it('链接不合法或下载失败时不留暂存', async () => {
    const root = temp('root-');
    const badUrl = await stagePlugin(root, { kind: 'url', url: 'file:///tmp/a.zip' }, '0.2.12');
    expect(badUrl.ok).toBe(false);
    const failed = await stagePlugin(
      root,
      { kind: 'url', url: 'https://example.com/missing.zip' },
      '0.2.12',
      { fetch: async () => ({ status: 404, headers: { get: () => null }, body: null }) }
    );
    expect(failed.ok).toBe(false);
    expect(existsSync(join(root, 'staging')) ? readdirSync(join(root, 'staging')) : []).toEqual([]);
  });

  it('GitHub 仓库地址下载 zipball，tree 子目录作为插件根', async () => {
    const root = temp('root-');
    const zip = storedZip({
      'demo-main/plugins/demo/enso-plugin.json': JSON.stringify(manifest),
      'demo-main/plugins/demo/main.js': 'export {}',
    });
    const seen: string[] = [];
    const fetchImpl: ArchiveFetch = async (url) => {
      seen.push(url);
      return {
        status: 200,
        headers: { get: () => null },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(zip);
            controller.close();
          },
        }),
      };
    };
    const result = await stagePlugin(
      root,
      { kind: 'url', url: 'https://github.com/acme/demo/tree/main/plugins/demo' },
      '0.2.12',
      { fetch: fetchImpl }
    );
    expect(seen).toEqual(['https://api.github.com/repos/acme/demo/zipball/main']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(result.staged.pluginRoot, 'main.js'), 'utf8')).toBe('export {}');

    const notRepo = await stagePlugin(
      root,
      { kind: 'url', url: 'https://github.com/acme' },
      '0.2.12',
      {
        fetch: async () => {
          throw new Error('不应下载');
        },
      }
    );
    expect(notRepo.ok).toBe(false);
  });
});

describe('commitStaged', () => {
  it('把暂存目录移到 packages/<id>/<dir>', async () => {
    const src = temp('src-');
    const root = temp('root-');
    writePlugin(src, { 'enso-plugin.json': JSON.stringify(manifest), 'main.js': 'export {}' });
    const result = await stagePlugin(root, { kind: 'dir', path: src }, '0.2.12');
    if (!result.ok) throw new Error(result.error);
    const dir = commitStaged(root, result.staged);
    const installed = pluginPackagePath(root, 'example.demo', dir);
    expect(readFileSync(join(installed, 'main.js'), 'utf8')).toBe('export {}');
    expect(existsSync(result.staged.pluginRoot)).toBe(false);
  });
});
