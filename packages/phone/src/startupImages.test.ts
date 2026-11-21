import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STARTUP_BACKGROUND,
  STARTUP_DEVICES,
  startupImageLinks,
  startupImagePath,
} from './startupImages';

const publicDir = path.resolve(import.meta.dirname, '../public');

/** PNG IHDR：宽高在第 16–23 字节 */
function pngSize(file: string): [number, number] {
  const head = fs.readFileSync(file).subarray(0, 24);
  return [head.readUInt32BE(16), head.readUInt32BE(20)];
}

describe('iOS 启动图', () => {
  it('每个机型深浅色各一张，像素尺寸精确匹配（不匹配 iOS 就显示白屏）', () => {
    let total = 0;
    for (const device of STARTUP_DEVICES)
      for (const scheme of ['light', 'dark'] as const) {
        const file = path.join(publicDir, startupImagePath(device, scheme));
        expect(pngSize(file)).toEqual([device.width * device.ratio, device.height * device.ratio]);
        total += fs.statSync(file).size;
      }
    // 纯色底 + 小图标：整套控制在 200 KB 内
    expect(total).toBeLessThan(200 * 1024);
  });

  it('机型不重复，链接按深浅色区分', () => {
    const keys = STARTUP_DEVICES.map((d) => `${d.width}x${d.height}@${d.ratio}`);
    expect(new Set(keys).size).toBe(keys.length);
    const links = startupImageLinks();
    expect(links.match(/apple-touch-startup-image/g)).toHaveLength(STARTUP_DEVICES.length * 2);
    expect(links).toContain(
      'screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: dark)" href="/splash/1170x2532-dark.png"'
    );
  });

  it('底色与 manifest、页面 theme-color 一致，打开时不先闪白', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8')
    );
    expect(manifest.background_color).toBe(STARTUP_BACKGROUND.light);
    expect(manifest.theme_color).toBe(STARTUP_BACKGROUND.light);
    for (const page of ['index.html', 'desk.html']) {
      const html = fs.readFileSync(path.resolve(publicDir, '..', page), 'utf8');
      expect(html).toContain(
        `media="(prefers-color-scheme: dark)" content="${STARTUP_BACKGROUND.dark}"`
      );
    }
  });

  it('manifest id 取 "/"：等于没写 id 时按 start_url 推出的身份，已装到主屏的不会变成另一个 App', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8')
    );
    expect(manifest.id).toBe('/');
    expect(new URL(manifest.id, 'https://relay.test/').href).toBe(
      new URL(manifest.start_url, 'https://relay.test/').href
    );
  });
});
