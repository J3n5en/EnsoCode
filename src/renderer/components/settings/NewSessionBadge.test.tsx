import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionBadge } from './NewSessionBadge';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const render = (note?: string) => renderToStaticMarkup(createElement(NewSessionBadge, { note }));

describe('NewSessionBadge', () => {
  it('标出新会话生效，并说明未标注的设置立即生效', () => {
    const html = render();
    expect(html).toContain('New sessions only');
    expect(html).toContain(
      'aria-label="New sessions only: Open sessions keep the previous setting; it applies once you start a new session. Settings without this tag take effect immediately."'
    );
  });

  it('部分生效的设置使用专门说明', () => {
    expect(render('Custom note.')).toContain(
      'aria-label="New sessions only: Custom note. Settings without this tag take effect immediately."'
    );
  });
});
