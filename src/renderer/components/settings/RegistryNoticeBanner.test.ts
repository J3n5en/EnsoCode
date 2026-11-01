import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RegistryNoticeBanner } from './RegistryNoticeBanner';

const render = (remote: boolean) =>
  renderToStaticMarkup(
    createElement(RegistryNoticeBanner, {
      notice: { discarded: ['old.one'], unreadable: true },
      remote,
      onDismiss: () => {},
    })
  );

describe('RegistryNoticeBanner', () => {
  it('本机显示问题与「知道了」', () => {
    const html = render(false);
    expect(html).toContain('old.one');
    expect(html).toContain('registry.json.unreadable');
    expect(html).toContain('知道了');
  });

  it('远端不提供清除按钮，改为指引到桌面端或命令行', () => {
    const html = render(true);
    expect(html).toContain('old.one');
    expect(html).not.toContain('<button');
    expect(html).toContain('enso-server plugin notice-dismiss');
  });
});
