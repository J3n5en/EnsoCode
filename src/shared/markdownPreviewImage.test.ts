import { describe, expect, it } from 'vitest';
import {
  classifyPreviewImageSrc,
  isRemoteOrDataImageSrc,
  normalizeRemoteImageUrl,
  previewImageMime,
  resolvePreviewImageRel,
} from './markdownPreviewImage';

describe('isRemoteOrDataImageSrc', () => {
  it('http/https/data/协议相对 URL 视为远程', () => {
    expect(isRemoteOrDataImageSrc('https://a.example/x.png')).toBe(true);
    expect(isRemoteOrDataImageSrc('http://a.example/x.png')).toBe(true);
    expect(isRemoteOrDataImageSrc('data:image/png;base64,AAAA')).toBe(true);
    expect(isRemoteOrDataImageSrc('//a.example/x.png')).toBe(true);
  });

  it('相对路径不算远程', () => {
    expect(isRemoteOrDataImageSrc('build/icons/256x256.png')).toBe(false);
    expect(isRemoteOrDataImageSrc('./chat.jpg')).toBe(false);
    expect(isRemoteOrDataImageSrc('/build/icons/256x256.png')).toBe(false);
  });
});

describe('resolvePreviewImageRel', () => {
  it('相对 Markdown 所在目录解析出工作区相对路径', () => {
    expect(resolvePreviewImageRel('', 'build/icons/256x256.png')).toBe('build/icons/256x256.png');
    expect(resolvePreviewImageRel('docs/readme', 'chat.jpg')).toBe('docs/readme/chat.jpg');
    expect(resolvePreviewImageRel('docs/readme', './chat.jpg')).toBe('docs/readme/chat.jpg');
  });

  it('以 / 开头视为工作区根相对路径', () => {
    expect(resolvePreviewImageRel('docs/readme', '/build/icons/256x256.png')).toBe(
      'build/icons/256x256.png'
    );
  });

  it('.. 在工作区内向上跳转允许', () => {
    expect(resolvePreviewImageRel('docs/readme', '../assets/logo.png')).toBe(
      'docs/assets/logo.png'
    );
  });

  it('.. 逃出工作区根拒绝', () => {
    expect(resolvePreviewImageRel('', '../secret.png')).toBeNull();
    expect(resolvePreviewImageRel('docs', '../../secret.png')).toBeNull();
  });

  it('远程/data URL 不解析，交给调用方原样处理', () => {
    expect(resolvePreviewImageRel('', 'https://a.example/x.png')).toBeNull();
    expect(resolvePreviewImageRel('', 'data:image/png;base64,AAAA')).toBeNull();
  });

  it('反斜杠或 NUL 视为非法拒绝', () => {
    expect(resolvePreviewImageRel('', 'a\\b.png')).toBeNull();
    expect(resolvePreviewImageRel('', 'a\0b.png')).toBeNull();
  });

  it('去掉查询串/锚点再解析', () => {
    expect(resolvePreviewImageRel('', 'a.png?raw=true#frag')).toBe('a.png');
  });

  // mdast-util-to-hast 会对 Markdown 图片地址做 normalizeUri：`![](docs/图片.png)`、`![](<my image.png>)`
  // 到这里已是 %XX 形态，原样发给 Main 读盘只会 ENOENT
  it('中文名、带空格的图片地址解码回真实文件名', () => {
    expect(resolvePreviewImageRel('', 'docs/%E5%9B%BE%E7%89%87.png')).toBe('docs/图片.png');
    expect(resolvePreviewImageRel('notes', 'my%20image.png?raw=1')).toBe('notes/my image.png');
  });

  it('编码的分隔符、..、反斜杠或 NUL 不能绕过分段与穿越校验', () => {
    expect(resolvePreviewImageRel('docs', '..%2F..%2Fsecret.png')).toBeNull();
    expect(resolvePreviewImageRel('', '%2E%2E/secret.png')).toBeNull();
    expect(resolvePreviewImageRel('', 'a%5C..%5Csecret.png')).toBeNull();
    expect(resolvePreviewImageRel('', 'a%00.png')).toBeNull();
  });

  it('%XX 解不出合法 UTF-8 时拒绝；不成 %XX 的字面 % 照旧当文件名字符', () => {
    expect(resolvePreviewImageRel('', '%E5%9B.png')).toBeNull();
    // 原始 HTML <img> 不经 normalizeUri，src 里的 % 就是文件名本身
    expect(resolvePreviewImageRel('', '100%.png')).toBe('100%.png');
  });

  it('Markdown 所在目录是真实路径，不参与解码', () => {
    expect(resolvePreviewImageRel('100%25', 'a.png')).toBe('100%25/a.png');
  });
});

describe('classifyPreviewImageSrc', () => {
  it('http(s) 与协议相对 URL 归类为 remote', () => {
    expect(classifyPreviewImageSrc('https://img.shields.io/badge.svg')).toBe('remote');
    expect(classifyPreviewImageSrc('http://img.shields.io/badge.svg')).toBe('remote');
    expect(classifyPreviewImageSrc('//img.shields.io/badge.svg')).toBe('remote');
  });

  it('data: URL 归类为 data（已是静态资源，不需要再取）', () => {
    expect(classifyPreviewImageSrc('data:image/png;base64,AAAA')).toBe('data');
  });

  it('相对路径归类为 local', () => {
    expect(classifyPreviewImageSrc('build/icons/256x256.png')).toBe('local');
    expect(classifyPreviewImageSrc('/build/icons/256x256.png')).toBe('local');
  });

  it('其他协议（mailto: 等）归类为 unsupported', () => {
    expect(classifyPreviewImageSrc('mailto:a@b.com')).toBe('unsupported');
    expect(classifyPreviewImageSrc('')).toBe('unsupported');
  });
});

describe('normalizeRemoteImageUrl', () => {
  it('协议相对 URL 补上 https:', () => {
    expect(normalizeRemoteImageUrl('//img.shields.io/badge.svg')).toBe(
      'https://img.shields.io/badge.svg'
    );
  });

  it('已带协议的 URL 不变', () => {
    expect(normalizeRemoteImageUrl('http://a.example/x.png')).toBe('http://a.example/x.png');
  });
});

describe('previewImageMime', () => {
  it('支持的位图扩展名返回 mime', () => {
    expect(previewImageMime('a.png')).toBe('image/png');
    expect(previewImageMime('a.JPG')).toBe('image/jpeg');
    expect(previewImageMime('dir/a.webp')).toBe('image/webp');
  });

  it('svg 支持（只通过 <img> 标签渲染，浏览器按图片上下文禁脚本，见 shared/imageSniff.ts）', () => {
    expect(previewImageMime('a.svg')).toBe('image/svg+xml');
  });

  it('未知扩展名不支持', () => {
    expect(previewImageMime('a.txt')).toBeNull();
    expect(previewImageMime('a')).toBeNull();
  });
});
