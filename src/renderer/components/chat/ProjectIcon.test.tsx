import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectIconsStore } from '@/stores/projectIcons';
import { ProjectIcon } from './ProjectIcon';

vi.mock('@shared/projectIcon', () => ({
  projectIconColor: (key: string) => (key === 'p1' ? '#112233' : '#445566'),
  projectIconInitial: (name: string) => Array.from(name)[0]?.toUpperCase() ?? '?',
}));

vi.mock('@shared/localImage', () => ({
  projectIconUrl: (projectId: string, revision: string) =>
    `local-image://project-icon/${projectId}?v=${revision}`,
}));

const getIcon = vi.fn();

let container: HTMLElement;
let root: Root;

function setup() {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, { electronAPI: { projects: { getIcon } } });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
}

beforeEach(() => {
  getIcon.mockReset();
  getIcon.mockResolvedValue({ revision: '', kind: 'none' });
  useProjectIconsStore.setState({ icons: {}, pending: new Set() });
  setup();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  vi.unstubAllGlobals();
});

describe('ProjectIcon', () => {
  it('未返回前先画色块，颜色跟 projectId，首字母跟显示名', async () => {
    let resolveIcon: (info: { revision: string; kind: 'none' }) => void = () => undefined;
    getIcon.mockReturnValue(
      new Promise((resolve) => {
        resolveIcon = resolve;
      })
    );
    await act(async () => {
      root.render(<ProjectIcon projectId="p1" displayName="alpha" size={16} />);
    });
    const fallback = container.querySelector('[data-enso="project-icon"]') as HTMLElement;
    expect(fallback.dataset.kind).toBe('fallback');
    expect(fallback.textContent).toBe('A');
    expect(fallback.style.backgroundColor).toBe('#112233');
    expect(fallback.style.borderRadius).toBe('4px');
    expect(fallback.style.fontSize).toBe('8px');
    expect(getIcon).toHaveBeenCalledTimes(1);
    expect(getIcon).toHaveBeenCalledWith('p1');
    await act(async () => {
      resolveIcon({ revision: '', kind: 'none' });
    });
  });

  it('同一项目挂两次只拉一次', async () => {
    let resolveIcon: (info: { revision: string; kind: 'none' }) => void = () => undefined;
    getIcon.mockReturnValue(
      new Promise((resolve) => {
        resolveIcon = resolve;
      })
    );
    await act(async () => {
      root.render(
        <div>
          <ProjectIcon projectId="p1" displayName="alpha" size={16} />
          <ProjectIcon projectId="p1" displayName="alpha" size={16} />
        </div>
      );
    });
    expect(getIcon).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveIcon({ revision: '', kind: 'none' });
    });
  });

  it('scanned 用原图且不裁圆角，加载失败退回色块', async () => {
    getIcon.mockResolvedValue({ revision: 'rev-1', kind: 'scanned' });
    await act(async () => {
      root.render(<ProjectIcon projectId="p1" displayName="alpha" size={16} />);
    });
    await act(async () => {
      await getIcon.mock.results[0]?.value;
    });
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('local-image://project-icon/p1?v=rev-1');
    expect(img.getAttribute('draggable')).toBe('false');
    expect(img.style.objectFit).toBe('contain');
    expect(img.style.borderRadius).toBe('');
    await act(async () => {
      img.dispatchEvent(new window.Event('error'));
    });
    const fallback = container.querySelector('[data-enso="project-icon"]') as HTMLElement;
    expect(fallback.dataset.kind).toBe('fallback');
    expect(fallback.textContent).toBe('A');
    expect(container.querySelector('img')).toBeNull();
  });

  it('set 写入 custom 后换 src，不再请求', async () => {
    getIcon.mockResolvedValue({ revision: '', kind: 'none' });
    await act(async () => {
      root.render(<ProjectIcon projectId="p1" displayName="alpha" size={16} />);
    });
    await act(async () => {
      await getIcon.mock.results[0]?.value;
    });
    await act(async () => {
      useProjectIconsStore.getState().set('p1', { revision: 'up-1', kind: 'custom' });
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'local-image://project-icon/p1?v=up-1'
    );
    expect(getIcon).toHaveBeenCalledTimes(1);
  });
});
