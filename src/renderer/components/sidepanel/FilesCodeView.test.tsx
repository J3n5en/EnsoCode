import { parseHTML } from 'linkedom';
import { act, type ReactNode, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  pool: undefined as
    | undefined
    | {
        primeFileHighlightCache: ReturnType<typeof vi.fn>;
        getFileResultCache: ReturnType<typeof vi.fn>;
        isInitialized: ReturnType<typeof vi.fn>;
        initialize: ReturnType<typeof vi.fn>;
      },
  renders: [] as {
    edit?: boolean;
    disableWorkerPool?: boolean;
    file: { name: string; contents: string; cacheKey?: string };
    pool: unknown;
  }[],
}));

vi.mock('./filesHighlightPool', () => ({ filesHighlightPool: () => harness.pool }));
vi.mock('@pierre/diffs/react', async () => {
  const { createContext } = await import('react');
  const WorkerPoolContext = createContext<unknown>(undefined);
  return {
    WorkerPoolContext,
    Virtualizer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    File: (props: {
      edit?: boolean;
      disableWorkerPool?: boolean;
      file: { name: string; contents: string; cacheKey?: string };
    }) => {
      harness.renders.push({ ...props, pool: useContext(WorkerPoolContext) });
      return <pre data-edit={String(Boolean(props.edit))}>{props.file.contents}</pre>;
    },
  };
});

import { FilesCodeView, fileCacheKey } from './FilesCodeView';

let root: Root;
let container: HTMLElement;

function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function render(contents = 'export const a = 1;\n') {
  await act(async () =>
    root.render(
      <FilesCodeView name="a.ts" initialContents={contents} editorOptions={{}} options={{}} />
    )
  );
}

const lastRender = () => harness.renders.at(-1);

function fakePool(overrides: Partial<NonNullable<typeof harness.pool>> = {}) {
  return {
    primeFileHighlightCache: vi.fn(() => Promise.resolve()),
    getFileResultCache: vi.fn(() => undefined),
    isInitialized: vi.fn(() => true),
    initialize: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.pool = undefined;
  harness.renders = [];
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('fileCacheKey', () => {
  it('同名同内容得同一个 key，内容或文件名变了 key 就变', () => {
    const key = fileCacheKey('a.ts', 'const a = 1;');
    expect(fileCacheKey('a.ts', 'const a = 1;')).toBe(key);
    expect(fileCacheKey('a.ts', 'const a = 2;')).not.toBe(key);
    expect(fileCacheKey('b.ts', 'const a = 1;')).not.toBe(key);
    expect(fileCacheKey('a.ts', '')).not.toBe(fileCacheKey('a.ts', ' '));
  });
});

describe('FilesCodeView', () => {
  it('worker 高亮完成前只读显示，完成后才挂编辑器，全程走 worker 池', async () => {
    const prime = deferred();
    harness.pool = fakePool({ primeFileHighlightCache: vi.fn(() => prime.promise) });
    await render();
    expect(lastRender()?.edit).toBe(false);
    expect(lastRender()?.disableWorkerPool).toBeUndefined();
    expect(lastRender()?.pool).toBe(harness.pool);
    const file = lastRender()?.file;
    expect(file?.cacheKey).toBe(fileCacheKey('a.ts', 'export const a = 1;\n'));
    expect(harness.pool.primeFileHighlightCache).toHaveBeenCalledWith(file);
    await act(async () => prime.resolve());
    expect(lastRender()?.edit).toBe(true);
  });

  it('worker 已有该内容的高亮缓存时首帧即可编辑', async () => {
    harness.pool = fakePool({ getFileResultCache: vi.fn(() => ({ result: {}, options: {} })) });
    await render();
    expect(harness.renders[0]?.edit).toBe(true);
  });

  it('高亮失败也放开编辑，不让文件停在只读', async () => {
    const prime = deferred();
    harness.pool = fakePool({ primeFileHighlightCache: vi.fn(() => prime.promise) });
    await render();
    await act(async () => prime.reject(new Error('worker down')));
    expect(lastRender()?.edit).toBe(true);
  });

  it('worker 池初始化完成前不挂 File：拿不到纯文本 AST 时先挂会让虚拟列表锚点跳到文件末尾', async () => {
    let ready: () => void = () => {};
    harness.pool = fakePool({
      isInitialized: vi.fn(() => false),
      initialize: vi.fn(() => new Promise<void>((done) => (ready = done))),
    });
    await render();
    expect(harness.renders).toHaveLength(0);
    await act(async () => ready());
    expect(lastRender()?.file.contents).toBe('export const a = 1;\n');
  });

  it('没有 worker 池时直接可编辑', async () => {
    await render();
    expect(harness.renders[0]?.edit).toBe(true);
  });

  it('编辑器改动回灌的文本不换 File 的文件对象：编辑器自己持有文档，不触发整文件重渲染', async () => {
    harness.pool = fakePool();
    await render('const a = 1;\n');
    const file = lastRender()?.file;
    await render('const a = 12;\n');
    expect(lastRender()?.file).toBe(file);
    expect(lastRender()?.edit).toBe(true);
    expect(harness.pool.primeFileHighlightCache).toHaveBeenCalledTimes(1);
  });
});
