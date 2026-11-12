import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportSessionDialog } from './ImportSessionDialog';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: { getState: () => ({ addImportedConversation: vi.fn() }) },
}));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<'button'> & { size?: string; variant?: string }) =>
    createElement('button', { type: 'button', ...props }, children),
}));
vi.mock('@/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? createElement('div', null, children) : null,
    DialogContent: Wrap,
    DialogDescription: Wrap,
    DialogFooter: Wrap,
    DialogHeader: Wrap,
    DialogPanel: Wrap,
    DialogTitle: Wrap,
  };
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const session = (path: string, title: string) => ({
  path,
  title,
  updatedAt: 0,
  messageCount: 1,
});
const source = (sessions: ReturnType<typeof session>[]) => ({
  sourceId: 'claude',
  sourceName: 'Claude',
  sessions,
});
const project = (id: string) => ({ id, name: id, path: `/work/${id}` }) as never;

let root: Root;
let container: HTMLElement;
const scan = vi.fn();
const read = vi.fn();
const render = (value: unknown) =>
  act(async () =>
    root.render(createElement(ImportSessionDialog, { project: value as never, onClose: vi.fn() }))
  );
const click = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find((el) =>
    el.textContent?.startsWith(text)
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
};

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  scan.mockReset();
  read.mockReset();
  Object.assign(window, { electronAPI: { sessionImport: { scan, read, import: vi.fn() } } });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('ImportSessionDialog 预览与扫描的先后', () => {
  // 真实场景：先点大会话 X 再点小会话 Y，Y 先读完、X 后读完，高亮 Y 却预览 X
  it('先点的会话后读完时，不覆盖当前选中会话的预览', async () => {
    scan.mockResolvedValue([
      source([session('/x.jsonl', 'Big X'), session('/y.jsonl', 'Small Y')]),
    ]);
    const big = deferred<unknown>();
    const small = deferred<unknown>();
    read.mockImplementation((_source: string, path: string) =>
      path === '/x.jsonl' ? big.promise : small.promise
    );
    await render(project('a'));
    await click('Big X');
    await click('Small Y');
    await act(async () => small.resolve([{ role: 'user', text: 'from Y' }]));
    await act(async () => big.resolve([{ role: 'user', text: 'from X' }]));
    expect(container.textContent).toContain('from Y');
    expect(container.textContent).not.toContain('from X');
  });

  it('切换项目后旧项目的扫描结果迟到时不覆盖新项目的会话列表', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    scan.mockImplementation((path: string) =>
      path === '/work/a' ? first.promise : second.promise
    );
    await render(project('a'));
    await render(project('b'));
    await act(async () => second.resolve([source([session('/b.jsonl', 'Session of B')])]));
    await act(async () => first.resolve([source([session('/a.jsonl', 'Session of A')])]));
    expect(container.textContent).toContain('Session of B');
    expect(container.textContent).not.toContain('Session of A');
  });
});
