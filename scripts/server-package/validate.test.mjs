import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateServerPackTgz } from './validate.mjs';

/** 造一个最小 tgz：entries 为 { 路径: 内容 } */
function makeTgz(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'enso-pack-validate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stage = join(dir, 'package');
  for (const [file, content] of Object.entries(entries)) {
    const target = join(stage, file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  const tgz = join(dir, 'pkg.tgz');
  execFileSync('tar', ['czf', tgz, '-C', dir, 'package']);
  return tgz;
}

const INDEX_HTML = `<!doctype html><html><head>
<script type="module" crossorigin src="./assets/index-HASH.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-HASH.css">
</head><body><div id="root"></div></body></html>`;

function completeEntries() {
  return {
    'out/server/index.js': 'console.log(1)',
    'out/renderer/index.html': INDEX_HTML,
    'out/renderer/web-preload.js': 'preload',
    'out/renderer/plugin-view.html': '<html></html>',
    'out/renderer/assets/index-HASH.js': 'js',
    'out/renderer/assets/index-HASH.css': 'css',
    'out/phone/index.html': '<html>phone</html>',
    'out/phone/sw.js': 'sw',
  };
}

test('完整包通过校验', async (t) => {
  const result = await validateServerPackTgz(makeTgz(t, completeEntries()));
  assert.deepEqual(result, { ok: true });
});

test('缺 out/renderer 整体直接失败并说明', async (t) => {
  const entries = completeEntries();
  for (const key of Object.keys(entries)) if (key.startsWith('out/renderer')) delete entries[key];
  const result = await validateServerPackTgz(makeTgz(t, entries));
  assert.equal(result.ok, false);
  assert.match(result.error, /out\/renderer/);
});

test('缺 web-preload.js 失败', async (t) => {
  const entries = completeEntries();
  delete entries['out/renderer/web-preload.js'];
  const result = await validateServerPackTgz(makeTgz(t, entries));
  assert.equal(result.ok, false);
  assert.match(result.error, /web-preload\.js/);
});

test('index.html 引用的资产缺失失败', async (t) => {
  const entries = completeEntries();
  delete entries['out/renderer/assets/index-HASH.css'];
  const result = await validateServerPackTgz(makeTgz(t, entries));
  assert.equal(result.ok, false);
  assert.match(result.error, /index-HASH\.css/);
});

test('缺 phone 产物失败', async (t) => {
  const entries = completeEntries();
  delete entries['out/phone/index.html'];
  const result = await validateServerPackTgz(makeTgz(t, entries));
  assert.equal(result.ok, false);
  assert.match(result.error, /out\/phone/);
});

test('缺 server 入口失败', async (t) => {
  const entries = completeEntries();
  delete entries['out/server/index.js'];
  const result = await validateServerPackTgz(makeTgz(t, entries));
  assert.equal(result.ok, false);
  assert.match(result.error, /out\/server\/index\.js/);
});
