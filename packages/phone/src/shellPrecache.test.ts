import { describe, expect, it } from 'vitest';
import { injectShellManifest, shellAssets, shellFiles, stampShellVersion } from './shellPrecache';
import { pageShellVersion } from './shellUpdate';

const DESK = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/desk-AbC123xy.js"></script>
<link rel="modulepreload" crossorigin href="/assets/client-9f8e7d6c.js">
<link rel="stylesheet" crossorigin href="/assets/desk-11aa22bb.css">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<link rel="manifest" href="/manifest.webmanifest" />
</head><body></body></html>`;

describe('shellPrecache', () => {
  it('只收集 /assets 下的打包产物，去重排序', () => {
    expect(shellAssets(`${DESK}<script src="/assets/desk-AbC123xy.js"></script>`)).toEqual([
      '/assets/client-9f8e7d6c.js',
      '/assets/desk-11aa22bb.css',
      '/assets/desk-AbC123xy.js',
    ]);
  });

  it('清单是两个页面加 desk 入口依赖', () => {
    expect(shellFiles(DESK)).toEqual([
      '/',
      '/desk',
      '/assets/client-9f8e7d6c.js',
      '/assets/desk-11aa22bb.css',
      '/assets/desk-AbC123xy.js',
    ]);
  });

  it('写进 sw.js 占位；占位缺失或版本不合法直接报错，不悄悄产出不预缓存的 SW', () => {
    const sw = "const SHELL_VERSION = 'dev';\nconst SHELL_FILES = [];\n";
    expect(injectShellManifest(sw, '0123abcd0123abcd', ['/', '/desk'])).toBe(
      'const SHELL_VERSION = \'0123abcd0123abcd\';\nconst SHELL_FILES = ["/","/desk"];\n'
    );
    expect(() => injectShellManifest('', '0123abcd0123abcd', [])).toThrow();
    expect(() => injectShellManifest(sw, "x';alert(1)//", [])).toThrow();
  });

  it('页面记下版本，运行时读得回来', () => {
    const html = stampShellVersion(DESK, '0123abcd0123abcd');
    const meta = /<meta name="enso-shell" content="([^"]+)"/.exec(html);
    expect(meta?.[1]).toBe('0123abcd0123abcd');
    const doc = {
      querySelector: () => ({ getAttribute: () => meta?.[1] ?? null }),
    } as unknown as Document;
    expect(pageShellVersion(doc)).toBe('0123abcd0123abcd');
    const bad = { querySelector: () => ({ getAttribute: () => 'dev' }) } as unknown as Document;
    expect(pageShellVersion(bad)).toBeNull();
  });
});
