import { DEFAULT_GIT_COMMIT_PROMPT } from '@shared/gitCommitMessage';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  state: {
    gitCommitModel: null as { providerId: string; modelId: string } | null,
    gitCommitPromptCustomized: false,
    setGitCommitModel: vi.fn(),
    setGitCommitPromptCustomized: vi.fn(),
  },
  providers: [
    { id: 'p1', name: 'P1', models: [{ id: 'a1' }, { id: 'a2' }] },
    { id: 'p2', name: 'P2', models: [{ id: 'b0', enabled: false }, { id: 'b1' }] },
  ],
  git: {
    readCommitPrompt: vi.fn(),
    writeCommitPrompt: vi.fn(async () => ({ ok: true })),
    resetCommitPrompt: vi.fn(async () => ({ ok: true })),
  },
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select(harness.state),
}));
vi.mock('@/stores/modelDirectory/useProviders', () => ({
  useOneShotProviders: () => harness.providers,
}));
vi.mock('@/components/ui/toast', () => ({ addToast: vi.fn() }));
vi.mock('@/components/ui/textarea', () => ({
  Textarea: ({ size: _size, ...props }: ComponentProps<'textarea'> & { size?: string }) => (
    <textarea {...props} />
  ),
}));
vi.mock('./kit', () => ({
  SettingsSection: ({ children, rowId }: { children?: ReactNode; rowId?: string }) => (
    <section data-settings-row={rowId}>{children}</section>
  ),
  SettingsRow: ({ children, label }: { children?: ReactNode; label: string }) => (
    <div data-row={label}>{children}</div>
  ),
  SettingsButton: ({ variant: _v, ...props }: ComponentProps<'button'> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
  SettingsSelect: (props: {
    value: string;
    options: { value: string; label: string }[];
    disabled?: boolean;
    onValueChange: (value: string) => void;
  }) => (
    <div data-select={props.value} data-disabled={String(Boolean(props.disabled))}>
      {props.options.map((option) => (
        <button
          type="button"
          key={option.value}
          data-option={option.value}
          onClick={() => props.onValueChange(option.value)}
        />
      ))}
    </div>
  ),
}));

import { GitCommitSettings } from './GitCommitSettings';

let root: Root;
let container: HTMLElement;
const row = (label: string) => container.querySelector(`[data-row="${label}"]`) as HTMLElement;
const click = async (element: Element | null) => {
  await act(async () => (element as HTMLElement).click());
};
async function render() {
  await act(async () => root.render(<GitCommitSettings />));
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, { electronAPI: { git: harness.git } });
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent: vi.fn(), detachEvent: vi.fn() });
  harness.state.gitCommitModel = null;
  harness.state.gitCommitPromptCustomized = false;
  harness.git.readCommitPrompt.mockResolvedValue({ ok: true, text: 'custom', custom: true });
  vi.clearAllMocks();
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('GitCommitSettings', () => {
  it('深链行号存在；未选供应商时模型下拉禁用', async () => {
    await render();
    expect(container.querySelector('[data-settings-row="providers.gitCommit"]')).not.toBeNull();
    expect(row('Model').querySelector('[data-select]')?.getAttribute('data-disabled')).toBe('true');
  });

  it('切换供应商联动选中该供应商第一个可用模型', async () => {
    await render();
    await click(row('Provider').querySelector('[data-option="p2"]'));
    expect(harness.state.setGitCommitModel).toHaveBeenCalledWith({
      providerId: 'p2',
      modelId: 'b1',
    });
  });

  it('模型列表只含所选供应商的可用模型', async () => {
    harness.state.gitCommitModel = { providerId: 'p2', modelId: 'b1' };
    await render();
    const options = [...row('Model').querySelectorAll('[data-option]')].map((el) =>
      el.getAttribute('data-option')
    );
    expect(options).toEqual(['b1']);
  });

  it('未自定义时展示默认提示词，保存与恢复默认均不可点', async () => {
    await render();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      DEFAULT_GIT_COMMIT_PROMPT
    );
    const buttons = [...container.querySelectorAll('button:not([data-option])')];
    expect(buttons.map((button) => (button as HTMLButtonElement).disabled)).toEqual([true, true]);
  });

  it('恢复默认：删文件、清标记、回到默认文本', async () => {
    harness.state.gitCommitPromptCustomized = true;
    await render();
    const [reset] = [...container.querySelectorAll('button:not([data-option])')];
    await click(reset);
    expect(harness.git.resetCommitPrompt).toHaveBeenCalled();
    expect(harness.state.setGitCommitPromptCustomized).toHaveBeenCalledWith(false);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      DEFAULT_GIT_COMMIT_PROMPT
    );
  });

  it('已自定义时展示文件内容', async () => {
    harness.state.gitCommitPromptCustomized = true;
    await render();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('custom');
  });
});
