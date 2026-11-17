import { parseHTML } from 'linkedom';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MentionFolderId, MentionSearchGroups } from '@/hooks/useMentionSearch';
import { MentionPicker } from './MentionPicker';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

let mobile = false;
vi.mock('@/hooks/useViewport', () => ({ useIsMobile: () => mobile }));

const groups: MentionSearchGroups = {
  agents: [
    {
      kind: 'agent-type',
      id: 'builtin:worker',
      typeKey: 'builtin:worker',
      label: 'Worker',
      displayName: 'Worker',
      description: 'Implements a self-contained coding subtask',
      source: 'builtin',
      locked: false,
      canDisable: true,
      canEdit: false,
    },
  ],
  members: [],
  files: [{ kind: 'file', id: 'src/a.ts', label: 'a.ts', relativePath: 'src/a.ts' }],
  chats: [],
};

function renderPicker(props: {
  openFolderId?: MentionFolderId | null;
  flyoutSide?: 'left' | 'right';
}) {
  return renderToStaticMarkup(
    <MentionPicker
      groups={groups}
      query=""
      activeIndex={0}
      onActiveIndexChange={() => {}}
      openFolderId={props.openFolderId ?? null}
      folderIndex={0}
      onOpenFolderIdChange={() => {}}
      onFolderIndexChange={() => {}}
      onSelect={() => {}}
      flyoutSide={props.flyoutSide}
    />
  );
}

function PickerHarness() {
  const [openFolderId, setOpenFolderId] = useState<MentionFolderId | null>(null);
  const [folderIndex, setFolderIndex] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  return (
    <MentionPicker
      groups={groups}
      query=""
      activeIndex={activeIndex}
      onActiveIndexChange={setActiveIndex}
      openFolderId={openFolderId}
      folderIndex={folderIndex}
      onOpenFolderIdChange={setOpenFolderId}
      onFolderIndexChange={setFolderIndex}
      onSelect={() => {}}
    />
  );
}

describe('MentionPicker 移动端', () => {
  it('窄屏贴着输入框上方铺满宽度，不贴屏幕底部', () => {
    mobile = true;
    const html = renderPicker({});
    expect(html).toContain('data-slot="mention-picker"');
    expect(html).toContain('absolute inset-x-0 bottom-full');
    expect(html).toContain('max-h-[50dvh]');
    expect(html).toContain('w-full');
    expect(html).not.toContain('fixed');
    expect(html).not.toContain('bottom-0');
    expect(html).not.toContain('data-slot="mention-flyout"');
  });

  it('展开文件夹后主列表换成该文件夹条目，点返回回到根列表', async () => {
    mobile = true;
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.HTMLElement.prototype.scrollIntoView = () => {};
    const container = window.document.getElementById('root') as unknown as HTMLElement;
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(<PickerHarness />);
    });

    const folderButton = [...container.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('Agents')
    );
    if (!folderButton) throw new Error('Missing Agents folder');
    await act(async () => folderButton.click());

    expect(container.querySelector('[data-slot="mention-sheet-back"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="mention-flyout"]')).toBeNull();
    expect(container.textContent).toContain('Worker');
    expect(container.textContent).not.toContain('a.ts');

    const back = container.querySelector('[data-slot="mention-sheet-back"]');
    if (!(back instanceof window.HTMLElement)) throw new Error('Missing back button');
    await act(async () => back.click());

    expect(container.querySelector('[data-slot="mention-sheet-back"]')).toBeNull();
    expect(container.textContent).toContain('Agents');
    expect(container.textContent).toContain('a.ts');
    expect(container.textContent).not.toContain('Worker');

    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
});

describe('MentionPicker 桌面端', () => {
  it('保持 absolute bottom-full 与左右飞出的 flyout', () => {
    mobile = false;
    const html = renderPicker({ openFolderId: 'agents' });
    expect(html).toContain('data-slot="mention-picker"');
    expect(html).toContain('absolute bottom-full');
    expect(html).toContain('absolute bottom-full z-10 mb-1.5 max-w-full');
    expect(html).not.toContain('inset-x-0');
    expect(html).toContain('data-slot="mention-flyout"');
    expect(html).toContain('left-full');
    expect(html).toContain('Worker');
    expect(html).toContain('Agents');
    expect(html).not.toContain('data-slot="mention-sheet-back"');
  });

  it('flyoutSide=left 时仍向左飞出', () => {
    mobile = false;
    const html = renderPicker({ openFolderId: 'agents', flyoutSide: 'left' });
    expect(html).toContain('right-full');
    expect(html).not.toContain('left-full');
  });
});

describe('MentionPicker 移动端静态展开', () => {
  beforeEach(() => {
    mobile = true;
  });
  afterEach(() => {
    mobile = false;
  });

  it('openFolderId 时主列表被替换，没有左右 flyout', () => {
    const html = renderPicker({ openFolderId: 'agents' });
    expect(html).toContain('data-slot="mention-sheet-back"');
    expect(html).toContain('Worker');
    expect(html).not.toContain('data-slot="mention-flyout"');
    expect(html).not.toContain('left-full');
    expect(html).not.toContain('right-full');
    expect(html).not.toContain('a.ts');
  });
});
