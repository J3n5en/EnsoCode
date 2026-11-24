import type { GitFile } from '@shared/types/git';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GitFileDirectory, GitFileList } from './GitFileList';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent: vi.fn(), detachEvent: vi.fn() });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const nestedFiles: GitFile[] = [
  { path: 'src/a/one.ts', status: 'modified' },
  { path: 'src/a/deep/two.ts', status: 'modified' },
  { path: 'src/b/three.ts', status: 'deleted' },
  { path: 'README.md', status: 'modified' },
];

describe('GitFileList 目录右键扩展', () => {
  it('树状视图按目录递归汇总所有嵌套文件并交给 renderDirectory', async () => {
    const seen = new Map<string, string[]>();
    const renderDirectory = (directory: GitFileDirectory, trigger: ReactElement) => {
      seen.set(
        directory.path,
        directory.files.map((file) => file.path)
      );
      return (
        <div data-wrapped-dir={directory.path} data-file-count={directory.files.length}>
          {trigger}
        </div>
      );
    };
    await act(async () =>
      root.render(
        <GitFileList files={nestedFiles} tree renderDirectory={renderDirectory}>
          {(file) => <span data-file={file.path}>{file.path}</span>}
        </GitFileList>
      )
    );

    expect(seen.get('src')).toEqual(['src/a/one.ts', 'src/a/deep/two.ts', 'src/b/three.ts']);
    expect(seen.get('src/a')).toEqual(['src/a/one.ts', 'src/a/deep/two.ts']);
    expect(seen.get('src/a/deep')).toEqual(['src/a/deep/two.ts']);
    expect(seen.get('src/b')).toEqual(['src/b/three.ts']);
    expect(
      container.querySelector('[data-wrapped-dir="src"]')?.getAttribute('data-file-count')
    ).toBe('3');
  });

  it('折叠父目录后，父目录节点仍保留完整的子文件列表', async () => {
    const seen = new Map<string, string[]>();
    await act(async () =>
      root.render(
        <GitFileList
          files={nestedFiles}
          tree
          renderDirectory={(directory, trigger) => {
            seen.set(
              directory.path,
              directory.files.map((file) => file.path)
            );
            return trigger;
          }}
        >
          {(file) => <span data-file={file.path}>{file.path}</span>}
        </GitFileList>
      )
    );
    const srcButton = container.querySelector('button[title="src"]') as HTMLButtonElement | null;
    expect(srcButton).not.toBeNull();
    seen.clear();
    await act(async () => srcButton?.click());
    expect(seen.get('src')).toEqual(['src/a/one.ts', 'src/a/deep/two.ts', 'src/b/three.ts']);
    expect(container.querySelector('[data-file="src/a/one.ts"]')).toBeNull();
  });

  it('列表视图不渲染目录节点，也不调用 renderDirectory', async () => {
    const renderDirectory = vi.fn((_directory: GitFileDirectory, trigger: ReactElement) => trigger);
    await act(async () =>
      root.render(
        <GitFileList files={nestedFiles} tree={false} renderDirectory={renderDirectory}>
          {(file) => <span data-file={file.path}>{file.path}</span>}
        </GitFileList>
      )
    );
    expect(renderDirectory).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-file]').length).toBe(nestedFiles.length);
  });

  it('同名前缀目录分开汇总，目录本身不作为文件出现', async () => {
    const seen = new Map<string, string[]>();
    await act(async () =>
      root.render(
        <GitFileList
          files={[
            { path: 'src/a/x.ts', status: 'modified' },
            { path: 'src/ab/y.ts', status: 'modified' },
            { path: 'src/a.ts', status: 'modified' },
          ]}
          tree
          renderDirectory={(directory, trigger) => {
            seen.set(
              directory.path,
              directory.files.map((file) => file.path)
            );
            return trigger;
          }}
        >
          {(file) => <span data-file={file.path}>{file.path}</span>}
        </GitFileList>
      )
    );
    expect([...seen.keys()].sort()).toEqual(['src', 'src/a', 'src/ab']);
    expect(seen.get('src/a')).toEqual(['src/a/x.ts']);
    expect(seen.get('src/ab')).toEqual(['src/ab/y.ts']);
    expect(seen.get('src')).toEqual(['src/a/x.ts', 'src/ab/y.ts', 'src/a.ts']);
  });
});
