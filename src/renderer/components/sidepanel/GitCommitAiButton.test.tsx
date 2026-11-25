import type { GenerateCommitMessageResult } from '@shared/gitCommitMessage';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  settings: { gitCommitModel: null as { providerId: string; modelId: string } | null },
  providers: [{ id: 'p1', name: 'P1', models: [{ id: 'm1' }] }],
  generate: vi.fn(),
  abort: vi.fn(async () => ({ ok: true })),
  addToast: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select(harness.settings),
}));
vi.mock('@/stores/modelDirectory/useProviders', () => ({
  useUsableProviders: () => harness.providers,
}));
vi.mock('@/stores/appView', () => ({ openSettings: harness.openSettings }));
vi.mock('@/components/ui/toast', () => ({ addToast: harness.addToast }));
vi.mock('@/components/chat/ConfirmDialog', () => ({
  ConfirmDialog: (props: { open: boolean; onConfirm: () => void; title: string }) =>
    props.open ? (
      <button type="button" data-confirm-ok="" onClick={props.onConfirm}>
        {props.title}
      </button>
    ) : null,
}));

import { GitCommitAiButton } from './GitCommitAiButton';

let root: Root;
let container: HTMLElement;
const onGenerated = vi.fn();
const onRunningChange = vi.fn();

function render(message = '') {
  act(() => {
    root.render(
      <GitCommitAiButton
        request={{ conversationId: 'c', projectId: 'p' }}
        message={message}
        disabled={false}
        onGenerated={onGenerated}
        onRunningChange={onRunningChange}
      />
    );
  });
}
const button = () => container.querySelector('[data-git-ai-generate]') as HTMLButtonElement;
const click = async (element: Element | null) => {
  await act(async () => {
    (element as HTMLElement).click();
  });
};

function deferred() {
  let resolve: (value: GenerateCommitMessageResult) => void = () => {};
  const promise = new Promise<GenerateCommitMessageResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  vi.stubGlobal('document', document);
  vi.stubGlobal(
    'window',
    Object.assign(window, {
      electronAPI: {
        git: { generateCommitMessage: harness.generate, abortCommitMessage: harness.abort },
      },
    })
  );
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  harness.settings.gitCommitModel = { providerId: 'p1', modelId: 'm1' };
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('GitCommitAiButton', () => {
  it('未配置：不发请求，提示并可跳转到模型中心对应分区', async () => {
    harness.settings.gitCommitModel = null;
    render();
    await click(button());
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    const action = harness.addToast.mock.calls[0][0].actions[0];
    action.onClick();
    expect(harness.openSettings).toHaveBeenCalledWith({
      category: 'providers',
      rowId: 'providers.gitCommit',
    });
  });

  it('模型失效同样拦截', async () => {
    harness.settings.gitCommitModel = { providerId: 'p1', modelId: 'gone' };
    render();
    await click(button());
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.addToast).toHaveBeenCalled();
  });

  it('loading 中再次点击即取消，结果不回填', async () => {
    const pending = deferred();
    harness.generate.mockReturnValueOnce(pending.promise);
    render();
    await click(button());
    const requestId = harness.generate.mock.calls[0][0].requestId;
    expect(harness.generate).toHaveBeenCalledWith({
      conversationId: 'c',
      projectId: 'p',
      requestId,
    });
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(onRunningChange).toHaveBeenLastCalledWith(true);
    await click(button());
    expect(harness.abort).toHaveBeenCalledWith({ requestId });
    expect(button().getAttribute('aria-busy')).toBe('false');
    await act(async () => {
      pending.resolve({ ok: true, message: 'feat: late', source: 'staged', truncated: false });
    });
    expect(onGenerated).not.toHaveBeenCalled();
    expect(onRunningChange).toHaveBeenLastCalledWith(false);
  });

  it('成功回填清洗后的消息', async () => {
    harness.generate.mockResolvedValueOnce({
      ok: true,
      message: 'feat: x',
      source: 'staged',
      truncated: false,
    });
    render();
    await click(button());
    expect(onGenerated).toHaveBeenCalledWith('feat: x');
    expect(button().getAttribute('aria-busy')).toBe('false');
  });

  it('失败弹出具体错误', async () => {
    harness.generate.mockResolvedValueOnce({
      ok: false,
      code: 'model-error',
      error: '401 bad key',
    });
    render();
    await click(button());
    expect(onGenerated).not.toHaveBeenCalled();
    expect(harness.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', description: '401 bad key' })
    );
  });

  it('没有改动时提示', async () => {
    harness.generate.mockResolvedValueOnce({ ok: false, code: 'no-changes', error: 'x' });
    render();
    await click(button());
    expect(harness.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'No changes to commit.' })
    );
  });

  it('输入框非空时先二次确认再覆盖', async () => {
    harness.generate.mockResolvedValueOnce({
      ok: true,
      message: 'feat: x',
      source: 'staged',
      truncated: false,
    });
    render('my own message');
    await click(button());
    expect(harness.generate).not.toHaveBeenCalled();
    await click(container.querySelector('[data-confirm-ok]'));
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(onGenerated).toHaveBeenCalledWith('feat: x');
  });

  it('进行中卸载：取消请求并通知父级解除锁定', async () => {
    harness.generate.mockReturnValueOnce(deferred().promise);
    render();
    await click(button());
    const requestId = harness.generate.mock.calls[0][0].requestId;
    act(() => root.render(<span />));
    expect(harness.abort).toHaveBeenCalledWith({ requestId });
    expect(onRunningChange).toHaveBeenLastCalledWith(false);
  });
});
