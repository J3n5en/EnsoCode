import { describe, expect, it } from 'vitest';
import { parseImageViewFacts, toolImageOf, toolImageSrc } from './toolImage';

const facts = { path: '/tmp/shot.png', size: 2048, width: 1280, height: 720 };
const output = `${JSON.stringify({ ...facts, mimeType: 'image/png' })}\n<source_reference type="file" path="/tmp/shot.png" />`;

describe('image_view 结果里的图片', () => {
  it('取第一个可显示的图片块，并保留原对象引用', () => {
    const part = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const content = [{ type: 'text', text: output }, part];
    expect(toolImageOf(content)).toBe(part);
  });

  it('空数据和非图片类型不算图片', () => {
    expect(toolImageOf([{ type: 'image', data: '', mimeType: 'image/png' }])).toBeUndefined();
    expect(toolImageOf([{ type: 'image', data: 'AAAA', mimeType: 'text/html' }])).toBeUndefined();
    expect(toolImageOf([{ type: 'text', text: 'x' }])).toBeUndefined();
  });

  it('元数据只解析第一行 JSON；不是 JSON 时返回 null', () => {
    expect(parseImageViewFacts(output)).toEqual(facts);
    expect(parseImageViewFacts('path is out of scope')).toBeNull();
    expect(parseImageViewFacts(null)).toBeNull();
  });

  it('有图片字节时直接拼 data URL，不按路径读宿主文件', () => {
    const src = toolImageSrc({ data: 'AAAA', mimeType: 'image/png' }, facts.path, true);
    expect(src).toBe('data:image/png;base64,AAAA');
  });

  it('没有图片字节时只对成功结果里的绝对路径走 local-image 通道', () => {
    expect(toolImageSrc(undefined, '/tmp/shot.png', true)).toBe('local-image://posix/tmp/shot.png');
    expect(toolImageSrc(undefined, 'shot.png', true)).toBeNull();
    expect(toolImageSrc(undefined, null, true)).toBeNull();
  });

  it('失败的调用不出图', () => {
    expect(toolImageSrc({ data: 'AAAA', mimeType: 'image/png' }, '/tmp/x.png', false)).toBeNull();
    expect(toolImageSrc(undefined, '/tmp/x.png', false)).toBeNull();
  });
});
