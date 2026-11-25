// @ensocode/server 发布前校验：tarball 里必须带齐浏览器版资源（完整版桌面的 renderer、
// 手机 PWA）。历史上 beta 包漏资源只表现为用户打开时报「桌面端缺少浏览器版资源」，
// 发布流水线本身毫无察觉。缺任何一样直接失败，不发布。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REQUIRED = [
  'package/out/server/index.js',
  'package/out/renderer/index.html',
  // 完整版桌面经隧道加载的必经文件：rendererBuildId 缺它就 null，meta 直接 503
  'package/out/renderer/web-preload.js',
  'package/out/phone/index.html',
  'package/out/phone/sw.js',
];

/** 入口页直接引用的 ./assets/* 也必须在包里（首屏下载失败同样起不来） */
function referencedAssets(html) {
  const assets = [];
  for (const match of html.matchAll(/\b(?:src|href)="\.\/(assets\/[^"?#]+)"/g)) {
    if (!assets.includes(match[1])) assets.push(match[1]);
  }
  return assets;
}

function tarList(tgz) {
  return execFileSync('tar', ['tzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function tarRead(tgz, file) {
  const dir = mkdtempSync(join(tmpdir(), 'enso-pack-read-'));
  try {
    execFileSync('tar', ['xzf', tgz, '-C', dir, file]);
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @returns {Promise<{ok:true}|{ok:false,error:string}>} */
export async function validateServerPackTgz(tgz) {
  const entries = new Set(tarList(tgz));
  for (const file of REQUIRED) {
    if (!entries.has(file)) {
      return { ok: false, error: `tarball 缺少必需资源 ${file}` };
    }
  }
  const html = tarRead(tgz, 'package/out/renderer/index.html');
  if (!html) return { ok: false, error: '无法读取 tarball 里的 out/renderer/index.html' };
  for (const asset of referencedAssets(html)) {
    if (!entries.has(`package/out/renderer/${asset}`)) {
      return { ok: false, error: `index.html 引用的 ${asset} 不在 tarball 里` };
    }
  }
  return { ok: true };
}
