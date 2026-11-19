import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FileTreeMenu } from './fileTreeMenu';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/context-menu', () => {
  const Wrap = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ContextMenu: Wrap,
    ContextMenuPopup: Wrap,
    ContextMenuSeparator: () => null,
    ContextMenuTrigger: () => null,
    ContextMenuItem: ({ children }: { children?: React.ReactNode }) => <i>{children}</i>,
  };
});

function items(local: boolean): string[] {
  const noop = () => undefined;
  const html = renderToStaticMarkup(
    <FileTreeMenu
      target={{ kind: 'file', rel: 'src/a.ts', name: 'a.ts' }}
      local={local}
      onNewFile={noop}
      onNewFolder={noop}
      onBrowser={noop}
      onCopyPath={noop}
      onCopyRel={noop}
      onCopyFile={noop}
      onReveal={noop}
    >
      <span />
    </FileTreeMenu>
  );
  return [...html.matchAll(/<i>(.*?)<\/i>/g)].map((m) => m[1]);
}

const HOST_OPS = ['Copy', 'Open in Browser'];

describe('FileTreeMenu 宿主桌面操作', () => {
  it('可用宿主桌面时显示复制文件、在浏览器打开、定位', () => {
    const list = items(true);
    for (const label of HOST_OPS) expect(list).toContain(label);
    expect(list.some((label) => /^(Reveal in|Open Containing)/.test(label))).toBe(true);
  });

  it('不可用宿主桌面时隐藏这些项，复制路径仍保留', () => {
    const list = items(false);
    for (const label of HOST_OPS) expect(list).not.toContain(label);
    expect(list.some((label) => /^(Reveal in|Open Containing)/.test(label))).toBe(false);
    expect(list).toEqual(expect.arrayContaining(['Copy Path', 'Copy Relative Path']));
  });
});
