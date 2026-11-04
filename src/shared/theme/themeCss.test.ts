import { describe, expect, it } from 'vitest';
import { rewriteThemeCssUrls, themeCssReferencesLocalImage } from './themeCss';

const toUrl = (rel: string) => `asset:${rel}`;
const rewrite = (css: string, cssPath = 'theme.css') => rewriteThemeCssUrls(css, cssPath, toUrl);

describe('themeCssReferencesLocalImage', () => {
  it('大小写、转义、续行和 URL 会删掉的 tab 都算引用', () => {
    expect(themeCssReferencesLocalImage('LOCAL-IMAGE:')).toBe(true);
    expect(themeCssReferencesLocalImage('l\\6f cal-image:')).toBe(true);
    expect(themeCssReferencesLocalImage('url("l\\6f cal-image://x")')).toBe(true);
    expect(themeCssReferencesLocalImage('local-\\\nimage:')).toBe(true);
    expect(themeCssReferencesLocalImage('url("local-im\\9 age://remote-fetch/")')).toBe(true);
    expect(themeCssReferencesLocalImage('url(local-im\\a age://x)')).toBe(true);
    expect(themeCssReferencesLocalImage('/* local-image */ a{color:red}')).toBe(true);
  });

  it('百分号编码（含多层）拼出来的也算', () => {
    expect(
      themeCssReferencesLocalImage(
        'a{background:url(/desk/li/_/%6Cocal-image%3A%2F%2Fremote-fetch%2F)}'
      )
    ).toBe(true);
    expect(themeCssReferencesLocalImage('a{background:image-set("/x/%256Cocal-image%253A")}')).toBe(
      true
    );
  });

  it('普通相对地址不算', () => {
    expect(themeCssReferencesLocalImage('a{background:url("a.png")}')).toBe(false);
    expect(themeCssReferencesLocalImage('a{background:url(local.png)}')).toBe(false);
  });
});

describe('rewriteThemeCssUrls', () => {
  it('改写三种引号，并忽略大小写和空白', () => {
    expect(rewrite('a{background:url("img/a.png")}')).toBe('a{background:url("asset:img/a.png")}');
    expect(rewrite("a{background:url('img/a.png')}")).toBe('a{background:url("asset:img/a.png")}');
    expect(rewrite('a{background:url(img/a.png)}')).toBe('a{background:url("asset:img/a.png")}');
    expect(rewrite('a{background:URL( img/a.png )}')).toBe('a{background:url("asset:img/a.png")}');
  });

  it('按 CSS 文件目录解析 . 和 ..', () => {
    expect(rewrite('a{background:url("../a.png")}', 'themes/x.css')).toBe(
      'a{background:url("asset:a.png")}'
    );
    expect(rewrite('a{background:url("./img/../b.png")}', 'themes/x.css')).toBe(
      'a{background:url("asset:themes/b.png")}'
    );
    expect(rewrite('a{background:url("../../a.png")}', 'themes/x.css')).toBe(
      'a{background:url("../../a.png")}'
    );
  });

  it('绝对地址、data、hash 和反斜杠保持原样', () => {
    expect(rewrite('a{background:url("https://x/a.png")}')).toBe(
      'a{background:url("https://x/a.png")}'
    );
    expect(rewrite('a{background:url("data:image/png;base64,aaa")}')).toBe(
      'a{background:url("data:image/png;base64,aaa")}'
    );
    expect(rewrite('a{background:url(/abs.png)}')).toBe('a{background:url(/abs.png)}');
    expect(rewrite('a{background:url(#id)}')).toBe('a{background:url(#id)}');
    expect(rewrite('a{background:url("img\\\\a.png")}')).toBe('a{background:url("img\\\\a.png")}');
    expect(rewrite('a{background:url("l\\6f go.png")}')).toBe('a{background:url("l\\6f go.png")}');
  });

  it('去掉 query，把 hash 留在生成的地址后面', () => {
    expect(rewrite('a{background:url("dir/a.png?x=1#y")}', 'themes/x.css')).toBe(
      'a{background:url("asset:themes/dir/a.png#y")}'
    );
    expect(rewrite(`a{background:url('a.svg#x"y')}`)).toBe(
      'a{background:url("asset:a.svg#x%22y")}'
    );
  });

  it('路径先解百分号编码，交给 toUrl 的是真实文件名', () => {
    expect(rewrite('a{background:url(img/a%20b.png)}')).toBe(
      'a{background:url("asset:img/a b.png")}'
    );
    expect(rewrite('a{background:url(img/%2E%2E/%2E%2E/x.png)}')).toBe(
      'a{background:url(img/%2E%2E/%2E%2E/x.png)}'
    );
    expect(rewrite('a{background:url(img/%ZZ.png)}')).toBe('a{background:url(img/%ZZ.png)}');
  });

  it('同一条声明里的多个 url 都改写', () => {
    expect(rewrite('@font-face{src:url("a.woff2") format("woff2")}')).toBe(
      '@font-face{src:url("asset:a.woff2") format("woff2")}'
    );
    expect(rewrite('a{background:url(a.png),url("b/c.webp")}')).toBe(
      'a{background:url("asset:a.png"),url("asset:b/c.webp")}'
    );
  });
});
