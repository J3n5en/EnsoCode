import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleManifest,
  downloadEstimate,
  initialAssetPaths,
  injectWebPreload,
  normalizeAssetPath,
  readRendererAsset,
  rendererBuildId,
  WEB_PRELOAD_FILE,
} from './assets';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'enso-remote-assets-'));
  const root = join(base, 'renderer');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(
    join(root, 'index.html'),
    '<html><head><meta content="img-src \'self\' local-image:"></head><body></body></html>'
  );
  writeFileSync(join(root, WEB_PRELOAD_FILE), 'void 0');
  writeFileSync(join(root, 'assets', 'a.js'), 'export {}');
  writeFileSync(join(base, 'secret.txt'), 'nope');
  symlinkSync(join(base, 'secret.txt'), join(root, 'assets', 'link.js'));
  return root;
}

describe('remote renderer assets', () => {
  it('normalizes only safe relative paths', () => {
    expect(normalizeAssetPath('assets/a.js?v=1')).toBe('assets/a.js');
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a\\b', 'a//b', './a', 'a\0']) {
      expect(normalizeAssetPath(bad)).toBeNull();
    }
  });

  it('injects the web preload before any module script and rewrites the CSP scheme', () => {
    const html = injectWebPreload('<head><script type="module" src="./x.js"></script></head>');
    expect(html.indexOf(WEB_PRELOAD_FILE)).toBeLessThan(html.indexOf('x.js'));
    expect(injectWebPreload('<head>local-image:</head>')).not.toContain('local-image:');
  });

  it('serves files inside the root and refuses escapes, including symlinks', async () => {
    const root = fixture();
    const js = await readRendererAsset(root, 'assets/a.js');
    expect(js.status).toBe(200);
    expect(js.mime).toContain('javascript');
    expect((await readRendererAsset(root, 'index.html')).status).toBe(200);
    expect(new TextDecoder().decode((await readRendererAsset(root, 'index.html')).body)).toContain(
      WEB_PRELOAD_FILE
    );
    expect((await readRendererAsset(root, '../secret.txt')).status).toBe(404);
    expect((await readRendererAsset(root, 'assets/link.js')).status).toBe(404);
    expect((await readRendererAsset(root, 'assets/missing.js')).status).toBe(404);
  });

  it('derives a build id that changes with entry content', async () => {
    const root = fixture();
    const first = await rendererBuildId(root, '1.0.0');
    writeFileSync(join(root, WEB_PRELOAD_FILE), 'void 1');
    expect(await rendererBuildId(root, '1.0.0')).not.toBe(first);
    expect(await rendererBuildId(join(root, 'missing'), '1.0.0')).toBeNull();
  });
});

describe('first-load download estimate', () => {
  it('lists the entry, web-preload and assets the entry page references', () => {
    const html = `<head><script src="./web-preload.js"></script>
      <script type="module" crossorigin src="./assets/index-a.js"></script>
      <link rel="modulepreload" crossorigin href="./assets/globals-b.js">
      <link rel="stylesheet" href="./assets/index-c.css">
      <link rel="icon" href="data:image/png;base64,xx"><script src="https://x.test/y.js"></script>
      <link rel="stylesheet" href="./assets/index-c.css"></head>`;
    expect(initialAssetPaths(html)).toEqual([
      'index.html',
      WEB_PRELOAD_FILE,
      'assets/index-a.js',
      'assets/globals-b.js',
      'assets/index-c.css',
    ]);
  });

  it('estimates wire size, smaller when the browser accepts gzip or v2 binary', async () => {
    const root = fixture();
    writeFileSync(
      join(root, 'index.html'),
      '<html><head><script type="module" src="./assets/big.js"></script></head></html>'
    );
    writeFileSync(join(root, 'assets', 'big.js'), 'const a = 1;\n'.repeat(20_000));
    const plain = await downloadEstimate(root, false);
    const packed = await downloadEstimate(root, true);
    const v2Packed = await downloadEstimate(root, true, 'b1', true);
    expect(plain).toBeGreaterThan(20_000 * 13);
    expect(packed).toBeGreaterThan(0);
    expect(packed).toBeLessThan(plain / 5);
    expect(v2Packed).toBeGreaterThan(0);
    expect(v2Packed).toBeLessThan(packed);
  });
});

describe('relay bundle manifest', () => {
  it('hashes every servable file except HTML entries, maps and symlinks, matching the relay', async () => {
    const root = fixture();
    mkdirSync(join(root, 'fonts'));
    writeFileSync(join(root, 'fonts', 'f.ttf'), 'x');
    writeFileSync(join(root, 'assets', 'a.js.map'), '{}');
    const manifest = await bundleManifest(root, 'b1');
    expect(manifest?.text).toBe(
      'f4c5cf9bb78e85f15dc27180260637cf24b2a24bc39e0788783a3accc4dde614  assets/a.js\n' +
        '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881  fonts/f.ttf\n' +
        'cb28eafc61a54ef9b4621764371ef6b8fc5cc1a217a966416197ed9a903aa585  web-preload.js\n'
    );
    // packages/relay-go/deskbundle_test.go 断言同一个 id：两边算法必须一致
    expect(manifest?.id).toBe('8832e4e906adc9ed3a64e64d5910f3cf121c36faf9b39c7748ac9ec1d1f304b6');
  });

  it('is null when the renderer is missing', async () => {
    expect(await bundleManifest(join(fixture(), 'missing'), 'b2')).toBeNull();
  });
});
