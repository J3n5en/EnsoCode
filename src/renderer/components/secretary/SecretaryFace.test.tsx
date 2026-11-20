import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SecretaryFace } from './SecretaryFace';

const render = (props: Parameters<typeof SecretaryFace>[0]) =>
  renderToStaticMarkup(createElement(SecretaryFace, props));

describe('SecretaryFace', () => {
  it('没传图片时按名字用 boring-avatars 生成头像，和 bot 一样', () => {
    const html = render({ name: '小秘', color: '#7c5cff', enso: 'face' });
    expect(html).toContain('<svg');
    expect(html).toContain('data-enso="face"');
    expect(html).toContain('data-generated="true"');
    // 同名同色生成同一张，换名字换一张
    expect(render({ name: '小秘', color: '#7c5cff' })).toBe(
      render({ name: '小秘', color: '#7c5cff' })
    );
    expect(render({ name: '阿秘', color: '#7c5cff' })).not.toBe(
      render({ name: '小秘', color: '#7c5cff' })
    );
  });

  it('名字是空白时仍能生成，不留空', () => {
    expect(render({ name: '  ' })).toContain('<svg');
  });

  it('有图片时用图片', () => {
    const html = render({ name: '小秘', image: 'enso-local://secretary/avatar.png' });
    expect(html).toContain('<img');
    expect(html).toContain('data-image="true"');
    expect(html).not.toContain('<svg');
  });
});
