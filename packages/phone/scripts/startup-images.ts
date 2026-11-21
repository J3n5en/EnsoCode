/**
 * 生成 iOS 启动图（public/splash）：纯色底 + 居中品牌环。改了机型表或底色后重跑：
 *   node packages/phone/scripts/startup-images.ts
 * 依赖 ImageMagick 7（magick）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  STARTUP_BACKGROUND,
  STARTUP_DEVICES,
  type StartupScheme,
  startupImagePath,
} from '../src/startupImages.ts';

const phone = path.resolve(import.meta.dirname, '..');
const icon = path.join(phone, 'public/icons/icon-512.png');
/** 图标里环的颜色；深色底换成浅灰 */
const RING: Record<StartupScheme, string> = { light: '#464952', dark: '#d4d4d8' };

fs.rmSync(path.join(phone, 'public/splash'), { recursive: true, force: true });
fs.mkdirSync(path.join(phone, 'public/splash'), { recursive: true });
let total = 0;
for (const device of STARTUP_DEVICES) {
  for (const scheme of ['light', 'dark'] as const) {
    const w = device.width * device.ratio;
    const h = device.height * device.ratio;
    const size = Math.round(device.width * 0.32) * device.ratio;
    const out = path.join(phone, 'public', startupImagePath(device, scheme));
    // 图标是白底灰环：灰度取反当透明度，再上品牌色，深浅底都干净
    execFileSync('magick', [
      '-size',
      `${w}x${h}`,
      `xc:${STARTUP_BACKGROUND[scheme]}`,
      '(',
      '-size',
      `${size}x${size}`,
      `xc:${RING[scheme]}`,
      '(',
      icon,
      '-resize',
      `${size}x${size}`,
      '-colorspace',
      'gray',
      '-negate',
      '-level',
      '0%,70%',
      ')',
      '-alpha',
      'off',
      '-compose',
      'copy_opacity',
      '-composite',
      ')',
      '-gravity',
      'center',
      '-compose',
      'over',
      '-composite',
      '-strip',
      '-colors',
      '32',
      '-define',
      'png:compression-level=9',
      `PNG8:${out}`,
    ]);
    total += fs.statSync(out).size;
  }
}
console.log(`${STARTUP_DEVICES.length * 2} 张，共 ${(total / 1024).toFixed(1)} KB`);
