import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectCodeTrustBar } from './ProjectCodeTrustBar';

const i18n = vi.hoisted(() => ({ t: (key: string) => key }));
const settings = vi.hoisted(() => ({
  state: {
    projects: [] as { id: string; trustedProjectCode?: string[] }[],
    setProjectTrustedCode: (_projectId: string, _sources: string[]) => {},
  },
}));
vi.mock('@/i18n', () => ({ useI18n: () => i18n }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select(settings.state),
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<'button'> & { size?: string; variant?: string }) =>
    createElement('button', { type: 'button', ...props }, children),
}));

const ALERT_TEXT =
  'This project ships pi extension code that runs with your permissions. It was not loaded. Trust it only if you trust this repository.';

let root: Root;
let container: HTMLElement;
const codeSources = vi.fn();
const setProjectTrustedCode = vi.fn();

const render = (projectId: string) =>
  act(async () =>
    root.render(createElement(ProjectCodeTrustBar, { projectId, conversationId: 'conv-1' }))
  );

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  codeSources.mockReset();
  setProjectTrustedCode.mockReset();
  settings.state = {
    projects: [{ id: 'A' }, { id: 'B' }],
    setProjectTrustedCode: (projectId, sources) => {
      setProjectTrustedCode(projectId, sources);
      settings.state.projects = settings.state.projects.map((project) =>
        project.id === projectId ? { ...project, trustedProjectCode: sources } : project
      );
    },
  };
  Object.assign(window, { electronAPI: { projects: { codeSources } } });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('ProjectCodeTrustBar', () => {
  it('未信任的项目代码显示提示条与来源名', async () => {
    codeSources.mockResolvedValue(['.pi/extensions/trellis']);
    await render('A');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain(ALERT_TEXT);
    expect(container.textContent).toContain('.pi/extensions/trellis');
  });

  it('切换到无扩展的项目时，检测结果返回前不沿用上一个项目的提示', async () => {
    let resolveB: (list: string[]) => void = () => {};
    codeSources.mockImplementation(({ projectId }: { projectId: string }) =>
      projectId === 'A'
        ? Promise.resolve(['.pi/extensions/trellis'])
        : new Promise<string[]>((resolve) => {
            resolveB = resolve;
          })
    );
    await render('A');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await render('B');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('.pi/extensions/trellis');

    await act(async () => resolveB([]));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('点击信任并加载后记入信任列表并转为已信任状态', async () => {
    codeSources.mockResolvedValue(['.pi/extensions/trellis']);
    await render('A');
    const button = [...container.querySelectorAll('button')].find(
      (el) => el.textContent === 'Trust and load'
    );
    if (!button) throw new Error('Missing button: Trust and load');
    await act(async () => button.click());
    expect(setProjectTrustedCode).toHaveBeenCalledWith('A', ['.pi/extensions/trellis']);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});
