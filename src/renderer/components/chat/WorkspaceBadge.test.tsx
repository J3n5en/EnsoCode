import { parseHTML } from 'linkedom';
import { act, type ReactNode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceBadge } from './WorkspaceBadge';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  // 挂载即视为打开菜单，触发 onOpenChange(true) 去拉应用列表
  const Menu = ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    useEffect(() => onOpenChange?.(true), [onOpenChange]);
    return <div>{children}</div>;
  };
  return {
    Menu,
    MenuGroup: Pass,
    MenuGroupLabel: Pass,
    MenuItem: Pass,
    MenuPopup: Pass,
    MenuSeparator: () => null,
    MenuTrigger: Pass,
  };
});

let container: HTMLElement;
let root: Root;
const openInApps = vi.fn();

function setup(remote: boolean) {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, {
    electronAPI: { remote, env: { platform: 'linux' }, projects: { openInApps } },
  });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
}

async function render() {
  await act(async () => {
    root.render(
      <WorkspaceBadge project={{ id: 'p1', name: 'demo' }} conversationId="c1" path="/root/demo">
        <span />
      </WorkspaceBadge>
    );
  });
  await act(async () => {});
}

beforeEach(() => openInApps.mockReset());
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('WorkspaceBadge', () => {
  it('lists host apps on the desktop', async () => {
    setup(false);
    openInApps.mockResolvedValue([{ id: 'vscode', name: 'VS Code', kind: 'editor' }]);
    await render();
    expect(openInApps).toHaveBeenCalled();
    expect(container.textContent).toContain('VS Code');
    expect(container.textContent).toContain('Copy Path');
  });

  it('remote clients only offer Copy Path and never ask the host for apps', async () => {
    setup(true);
    openInApps.mockResolvedValue({ ok: false, error: 'unsupported-remote' });
    await render();
    expect(openInApps).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Editors');
    expect(container.textContent).not.toContain('Open in');
    expect(container.textContent).toContain('Copy Path');
  });
});
