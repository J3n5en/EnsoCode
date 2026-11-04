import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChromeRow, ShellChromeContext, WindowControls } from './WindowChrome';

vi.stubGlobal('window', { electronAPI: { env: { platform: 'darwin' } } });
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useViewport', () => ({ useIsMobile: () => false }));

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const withShell = (child: React.ReactElement) =>
  createElement(
    ShellChromeContext.Provider,
    {
      value: {
        trailing: createElement('button', { type: 'button' }, 'act'),
      },
    },
    child
  );

describe('WindowControls', () => {
  it('按平台给系统控件留位', () => {
    expect(html(createElement(WindowControls, { kind: 'mac' }))).toBe('');
    expect(html(createElement(WindowControls, { kind: 'mobile' }))).toBe('');
    const win = html(createElement(WindowControls, { kind: 'windows', edgeGap: 8 }));
    expect(win).toContain('data-native-window-controls');
    expect(win).toContain('- 8px');
    const linux = html(createElement(WindowControls, { kind: 'linux' }));
    expect(linux).toContain('aria-label="Close"');
    expect(linux).toContain('aria-label="Minimize"');
  });
});

describe('ChromeRow', () => {
  it('没有外壳时只是普通行，不可拖也不带动作', () => {
    const row = html(createElement(ChromeRow, null, 'tabs'));
    expect(row).toContain('tabs');
    expect(row).not.toContain('drag-region');
    expect(row).not.toContain('act');
  });

  it('桌面外壳下整行可拖并在右端挂动作', () => {
    const row = html(withShell(createElement(ChromeRow, null, 'tabs')));
    expect(row).toContain('drag-region');
    expect(row.indexOf('tabs')).toBeLessThan(row.indexOf('act'));
  });
});
