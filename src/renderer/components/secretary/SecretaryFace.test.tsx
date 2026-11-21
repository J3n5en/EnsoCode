import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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

  it('图片加载失败时回退到按名字生成的头像，换了地址再试图片', async () => {
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = window.document.getElementById('root') as unknown as HTMLElement;
    const root = createRoot(container);
    const face = (image: string) =>
      createElement(SecretaryFace, { name: '小秘', color: '#7c5cff', image, enso: 'face' });
    try {
      await act(async () => root.render(face('local-image://secretary-avatar/avatar.png?v=1')));
      const img = container.querySelector('img');
      expect(img?.getAttribute('data-image')).toBe('true');

      await act(async () => {
        img?.dispatchEvent(new window.Event('error'));
      });
      expect(container.querySelector('img')).toBeNull();
      const fallback = container.querySelector('[data-enso="face"]');
      expect(fallback?.getAttribute('data-generated')).toBe('true');
      expect(fallback?.querySelector('svg')).not.toBeNull();

      await act(async () => root.render(face('local-image://secretary-avatar/avatar.png?v=2')));
      expect(container.querySelector('img')?.getAttribute('src')).toContain('v=2');
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
