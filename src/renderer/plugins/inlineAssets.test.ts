import { describe, expect, it, vi } from 'vitest';
import { inlinePluginViewHtml } from './inlineAssets';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

const files: Record<string, { mime: string; base64: string }> = {
  'views/app.js': { mime: 'text/javascript', base64: b64('console.log("你好</script>")') },
  'views/app.css': { mime: 'text/css', base64: b64('body{color:red}') },
  'views/logo.png': { mime: 'image/png', base64: 'aGVsbG8=' },
  'app.js': { mime: 'text/javascript', base64: b64('root()') },
};

function reader() {
  return vi.fn(async (rel: string) => files[rel] ?? null);
}

const html = [
  '<script src="./app.js"></script>',
  '<link rel="stylesheet" href="app.css">',
  '<img alt="logo" src="logo.png">',
  '<script src="../app.js"></script>',
  '<script src="https://cdn.example/x.js"></script>',
  '<script src="//cdn.example/x.js"></script>',
  '<img src="/etc/passwd.png">',
  '<script src="../../secret.js"></script>',
  '<script src="app.js?v=1"></script>',
  '<link rel="icon" href="logo.png">',
  '<script>keep()</script>',
].join('\n');

describe('侧栏页面资源内联', () => {
  it('把相对脚本、样式和图片内联，路径相对页面目录', async () => {
    const read = reader();
    const out = await inlinePluginViewHtml(html, 'views/panel.html', read);
    expect(out).toContain('console.log("你好<\\/script>")');
    expect(out).toContain('<style>body{color:red}</style>');
    expect(out).toContain('src="data:image/png;base64,aGVsbG8="');
    expect(out).toContain('root()');
    expect(read).toHaveBeenCalledWith('views/app.js');
    expect(read).toHaveBeenCalledWith('views/app.css');
    expect(read).toHaveBeenCalledWith('views/logo.png');
    expect(read).toHaveBeenCalledWith('app.js');
  });

  it('绝对路径、协议 URL 和越界路径保持原样且不读取', async () => {
    const read = reader();
    const out = await inlinePluginViewHtml(html, 'views/panel.html', read);
    expect(out).toContain('src="https://cdn.example/x.js"');
    expect(out).toContain('src="//cdn.example/x.js"');
    expect(out).toContain('src="/etc/passwd.png"');
    expect(out).toContain('src="../../secret.js"');
    expect(out).toContain('src="app.js?v=1"');
    expect(out).toContain('href="logo.png"');
    expect(out).toContain('<script>keep()</script>');
    const rels = read.mock.calls.map((call) => call[0]);
    expect(rels).not.toEqual(expect.arrayContaining(['../../secret.js', '/etc/passwd.png']));
    expect(rels.every((rel) => !rel.includes('..') && !rel.includes('://'))).toBe(true);
  });

  it('资源读取失败时保留原标签', async () => {
    const read = vi.fn(async () => null);
    const source = '<script src="missing.js"></script>';
    await expect(inlinePluginViewHtml(source, 'panel.html', read)).resolves.toBe(source);
    expect(read).toHaveBeenCalledWith('missing.js');
  });
});
