import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { uiElementElectron } from './verify-electron.mjs';

function fakeBundle({ plistKey = 'CFBundleName' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'enso-verify-electron-test-'));
  const contents = path.join(root, 'dist', 'Electron.app', 'Contents');
  mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  writeFileSync(path.join(contents, 'MacOS', 'Electron'), '#!/bin/sh\n');
  writeFileSync(
    path.join(contents, 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleName</key><string>Electron</string></dict></plist>\n'
  );
  return {
    root,
    exe: path.join(contents, 'MacOS', 'Electron'),
    plist: path.join(contents, 'Info.plist'),
  };
}

const copyKeys = (cacheRoot) =>
  readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{12}$/.test(entry.name))
    .map((entry) => entry.name);

const age = (file) => {
  const past = new Date(Date.now() - 96 * 3600 * 1000);
  utimesSync(file, past, past);
};

const macOnly = { skip: process.platform !== 'darwin' };

const lsuiElement = (plist) =>
  execFileSync('plutil', ['-extract', 'LSUIElement', 'raw', plist], { encoding: 'utf8' }).trim();

test('only macOS app bundles are rewritten', () => {
  assert.equal(uiElementElectron('/x/electron', { platform: 'linux' }), '/x/electron');
  assert.equal(uiElementElectron('/x/electron.exe', { platform: 'win32' }), '/x/electron.exe');
  assert.equal(
    uiElementElectron('/usr/local/bin/electron', { platform: 'darwin' }),
    '/usr/local/bin/electron'
  );
});

test('clones the bundle with LSUIElement and leaves the original alone', macOnly, () => {
  const { root, exe, plist } = fakeBundle();
  const cacheRoot = path.join(root, 'cache');
  const original = readFileSync(plist, 'utf8');
  const cloned = uiElementElectron(exe, { cacheRoot });
  assert.ok(cloned.startsWith(cacheRoot + path.sep), cloned);
  assert.ok(cloned.endsWith(path.join('Electron.app', 'Contents', 'MacOS', 'Electron')), cloned);
  assert.equal(readFileSync(cloned, 'utf8'), '#!/bin/sh\n');
  assert.equal(lsuiElement(path.join(path.dirname(cloned), '..', 'Info.plist')), 'true');
  assert.equal(readFileSync(plist, 'utf8'), original);
  assert.equal(uiElementElectron(exe, { cacheRoot }), cloned, 'reuses the cached clone');
});

test('same bundle content in different locations shares one copy', macOnly, () => {
  const first = fakeBundle();
  const second = fakeBundle();
  const cacheRoot = path.join(first.root, 'cache');
  // 第二个 bundle 与第一个内容相同但路径不同、mtime 也不同：key 必须相同
  const stale = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  utimesSync(first.exe, stale, stale);
  const fromFirst = uiElementElectron(first.exe, { cacheRoot });
  const fromSecond = uiElementElectron(second.exe, { cacheRoot });
  assert.equal(copyKeys(cacheRoot).length, 1, 'content-identical bundles must share one copy');
  assert.equal(fromFirst, fromSecond);
});

test('different bundle content produces a distinct copy', macOnly, () => {
  const first = fakeBundle();
  const second = fakeBundle();
  writeFileSync(second.plist, readFileSync(second.plist, 'utf8') + '<!--v2-->');
  const cacheRoot = path.join(first.root, 'cache');
  const fromFirst = uiElementElectron(first.exe, { cacheRoot });
  const fromSecond = uiElementElectron(second.exe, { cacheRoot });
  assert.notEqual(fromFirst, fromSecond);
  assert.equal(copyKeys(cacheRoot).length, 2);
});

test('sweep removes aged unclaimed copies but keeps fresh and in-use ones', macOnly, () => {
  const old = fakeBundle();
  const cacheRoot = path.join(old.root, 'cache');
  uiElementElectron(old.exe, { cacheRoot });
  const oldKey = copyKeys(cacheRoot)[0];
  // 使用中的副本：claim 文件带活 pid（当前进程），即使超龄也不能删
  writeFileSync(path.join(cacheRoot, '.claims', `${oldKey}.${process.pid}`), '');
  age(path.join(cacheRoot, oldKey, '.lastuse'));
  const victim = fakeBundle();
  writeFileSync(victim.plist, readFileSync(victim.plist, 'utf8') + '<!--victim-->');
  uiElementElectron(victim.exe, { cacheRoot });
  const victimKey = copyKeys(cacheRoot).find((key) => key !== oldKey);
  age(path.join(cacheRoot, victimKey, '.lastuse'));
  // victim 的创建进程已退出：删掉它留下的认领文件（真实场景是 pid 死亡）
  rmSync(path.join(cacheRoot, '.claims', `${victimKey}.${process.pid}`), { force: true });
  // 新副本（不超龄）不能被删
  const fresh = fakeBundle();
  writeFileSync(fresh.plist, readFileSync(fresh.plist, 'utf8') + '<!--fresh-->');
  uiElementElectron(fresh.exe, { cacheRoot });
  const freshKey = copyKeys(cacheRoot).find((key) => key !== oldKey && key !== victimKey);
  // 触发一次 sweep
  const trigger = fakeBundle();
  writeFileSync(trigger.plist, readFileSync(trigger.plist, 'utf8') + '<!--trigger-->');
  uiElementElectron(trigger.exe, { cacheRoot });
  assert.ok(existsSync(path.join(cacheRoot, oldKey)), 'in-use copy must survive');
  assert.ok(!existsSync(path.join(cacheRoot, victimKey)), 'aged unclaimed copy must be swept');
  assert.ok(existsSync(path.join(cacheRoot, freshKey)), 'fresh copy must survive');
});

test('sweep never deletes outside the cache root', macOnly, () => {
  const { root, exe } = fakeBundle();
  const cacheRoot = path.join(root, 'cache');
  uiElementElectron(exe, { cacheRoot });
  const key = copyKeys(cacheRoot)[0];
  // 用 symlink 伪造一个指向 cacheRoot 之外的副本目录，sweep 不能顺着 symlink 删外部内容
  const outside = path.join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  symlinkSync(outside, path.join(cacheRoot, 'abcdef012345'), 'dir');
  const trigger = fakeBundle();
  writeFileSync(trigger.plist, readFileSync(trigger.plist, 'utf8') + '<!--trigger2-->');
  uiElementElectron(trigger.exe, { cacheRoot });
  assert.ok(existsSync(path.join(outside, 'keep.txt')), 'content outside cacheRoot must survive');
  assert.ok(existsSync(path.join(cacheRoot, key)), 'real copy must survive');
});
