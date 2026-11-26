import { parseHTML } from 'linkedom';
import { act, type ReactNode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceBadge } from './WorkspaceBadge';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/secretary/useSecretaryFace', () => ({
  useSecretaryFace: (conversationId?: string) =>
    conversationId === 'secretary-conv'
      ? {
          name: '爱酱',
          color: '#6366F1',
          image: 'local-image://secretary-avatar/avatar.png?v=5&h=a22fb6cf&s=default',
        }
      : null,
}));
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

async function render(
  project: { id: string; name: string; path: string; alias?: string } = {
    id: 'p1',
    name: 'demo',
    path: '/root/demo',
  }
) {
  await act(async () => {
    root.render(
      <WorkspaceBadge project={project} conversationId="c1" path="/root/demo">
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

  it('shows the project alias instead of the stored name', async () => {
    setup(false);
    openInApps.mockResolvedValue([]);
    await render({ id: 'p1', name: 'demo', path: '/root/demo', alias: '线上' });
    expect(container.textContent).toContain('线上');
    expect(container.textContent).not.toContain('demo');
  });

  it('秘书项目显示所属秘书的头像与名字，而不是项目 fallback 的首字母', async () => {
    setup(false);
    openInApps.mockResolvedValue([]);
    await act(async () => {
      root.render(
        <WorkspaceBadge
          project={{ id: 'p-sec', name: 'Secretary', path: '/sec', kind: 'secretary' }}
          conversationId="secretary-conv"
          path="/sec"
        >
          <span />
        </WorkspaceBadge>
      );
    });
    await act(async () => {});
    // 名字显示秘书名（爱酱），不是项目名 Secretary
    expect(container.textContent).toContain('爱酱');
    // 头像走秘书头像（data-image），不是项目 fallback（data-kind="fallback" 或首字母 S）
    const face = container.querySelector('[data-enso="workspace-secretary-face"]');
    expect(face).not.toBeNull();
    // 项目 fallback 不应再出现
    expect(container.querySelector('[data-enso="project-icon"][data-kind="fallback"]')).toBeNull();
  });
});
