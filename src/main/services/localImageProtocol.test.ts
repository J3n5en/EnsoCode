import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localImageUrlToPath, pluginAssetUrl } from '@shared/localImage';
import { afterEach, describe, expect, it } from 'vitest';
import { handleLocalImageRequest, setPluginAssetResolver } from './localImageProtocol';

describe('plugin-asset', () => {
  let dir = '';

  afterEach(() => {
    setPluginAssetResolver(null);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  async function respond(url: string) {
    return handleLocalImageRequest(url, null);
  }

  it('未注册或解析失败时 404', async () => {
    const url = pluginAssetUrl('acme.theme', 'a.png', 'b1');
    expect((await respond(url)).status).toBe(404);
    setPluginAssetResolver(() => null);
    expect((await respond(url)).status).toBe(404);
    setPluginAssetResolver(() => {
      throw new Error('missing');
    });
    expect((await respond(url)).status).toBe(404);
  });

  it('非白名单扩展名 403，坏的百分号编码 400', async () => {
    setPluginAssetResolver(() => '/tmp/nope.mp4');
    expect((await respond(pluginAssetUrl('acme.theme', 'a.mp4', 'b1'))).status).toBe(403);
    expect((await respond('local-image://plugin-asset/acme.theme/%ZZ.png')).status).toBe(400);
  });

  it('字体带 MIME、CORS 和长缓存，并解码路径', async () => {
    dir = mkdtempSync(join(tmpdir(), 'enso-plugin-asset-'));
    const file = join(dir, 'a.woff2');
    writeFileSync(file, 'font-bytes');
    let seen: { pluginId: string; rel: string } | null = null;
    setPluginAssetResolver((pluginId, rel) => {
      seen = { pluginId, rel };
      return file;
    });
    const response = await respond(pluginAssetUrl('奶龙', '字体/a.woff2', 'build 2'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('font/woff2');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('max-age=31536000');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('font-bytes');
    expect(seen).toEqual({ pluginId: '奶龙', rel: '字体/a.woff2' });
  });

  it('不把 plugin-asset 当成磁盘路径', () => {
    expect(localImageUrlToPath(new URL(pluginAssetUrl('acme.theme', 'a.png', 'b1')))).toBeNull();
  });
});
