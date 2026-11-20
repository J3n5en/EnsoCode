import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { uiElementElectron } from './verify-electron.mjs';

function fakeBundle() {
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

test('clones the bundle with LSUIElement and leaves the original alone', {
  skip: process.platform !== 'darwin',
}, () => {
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
