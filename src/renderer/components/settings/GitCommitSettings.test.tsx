import { DEFAULT_GIT_COMMIT_PROMPT, GIT_COMMIT_SETTINGS_ROW } from '@shared/gitCommitMessage';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  state: {
    gitCommitModel: null as { providerId: string; modelId: string } | null,
    gitCommitPromptCustomized: false,
    setGitCommitModel: vi.fn(),
    setGitCommitPromptCustomized: vi.fn(),
  },
  route: null as { link: { category: string; rowId: string } | null; linkSeq: number } | null,
  providers: [
    { id: 'p1', name: 'P1', models: [{ id: 'a1', label: 'Alpha' }, { id: 'a2' }] },
    { id: 'p2', name: 'P2', models: [{ id: 'b0', enabled: false }, { id: 'b1' }] },
  ],
  pickerProps: null as Record<string, unknown> | null,
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
vi.mock('@/stores/appView', () => ({
  useAppViewStore: (select: (state: unknown) => unknown) => select({ settings: harness.route }),
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
vi.mock('@/components/chat/ModelPicker', () => ({
  MODEL_PICKER_FORM_TRIGGER_CLASS: 'form-trigger',
  ModelPicker: (props: Record<string, unknown>) => {
    harness.pickerProps = props;
    return <i data-picker="true" />;
  },
}));
vi.mock('./kit', () => ({
  SettingsSection: ({ children, rowId }: { children?: ReactNode; rowId?: string }) => (
    <section data-settings-row={rowId}>{children}</section>
  ),
  SettingsRow: ({
    children,
    label,
    rowId,
    status,
  }: {
    children?: ReactNode;
    label: string;
    rowId?: string;
    status?: ReactNode;
  }) => (
    <div data-row={label} data-settings-row={rowId}>
      {status}
      {children}
    </div>
  ),
  SettingsExpandableRow: function Expandable({
    rowId,
    label,
    control,
    children,
    open,
    onOpenChange,
  }: {
    rowId?: string;
    label: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) {
    const [own, setOwn] = useState(false);
    const isOpen = open ?? own;
    return (
      <div data-expandable="true" data-settings-row={rowId}>
        <button
          type="button"
          data-toggle="true"
          onClick={() => {
            setOwn(!isOpen);
            onOpenChange?.(!isOpen);
          }}
        >
          {label}
        </button>
        <div data-summary="true">{control}</div>
        {isOpen && <div data-region="true">{children}</div>}
      </div>
    );
  },
  SettingsButton: ({ variant: _v, ...props }: ComponentProps<'button'> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
}));

import { GitCommitSettings } from './GitCommitSettings';

let root: Root;
let container: HTMLElement;
const click = async (element: Element | null) => {
  await act(async () => (element as HTMLElement).click());
};
const summary = () => container.querySelector('[data-summary]')?.textContent ?? '';
const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement | null;
const actionButtons = () => [...container.querySelectorAll('[data-row="Prompt"] button')];
async function render() {
  await act(async () => root.render(<GitCommitSettings />));
}
async function toggle() {
  await click(container.querySelector('[data-toggle]'));
}
const linkTo = (rowId: string, linkSeq: number) => {
  harness.route = { link: { category: 'providers', rowId }, linkSeq };
};

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, { electronAPI: { git: harness.git } });
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent: vi.fn(), detachEvent: vi.fn() });
  // linkedom 的 textarea 没有 defaultValue：React 挂载时靠它写初始文本，展开后才挂载的文本框会是空的
  Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, 'defaultValue', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return this.textContent ?? '';
    },
    set(this: HTMLTextAreaElement, value: string) {
      this.textContent = value;
    },
  });
  harness.state.gitCommitModel = null;
  harness.state.gitCommitPromptCustomized = false;
  harness.route = null;
  harness.pickerProps = null;
  vi.clearAllMocks();
  harness.git.readCommitPrompt.mockResolvedValue({ ok: true, text: 'custom', custom: true });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('GitCommitSettings', () => {
  it('默认折叠：深链锚点在，提示词与模型选择都不渲染', async () => {
    await render();
    expect(
      container.querySelector(`[data-settings-row="${GIT_COMMIT_SETTINGS_ROW}"]`)
    ).not.toBeNull();
    expect(textarea()).toBeNull();
    expect(container.querySelector('[data-picker]')).toBeNull();
  });

  it('折叠摘要：未选模型显示未配置', async () => {
    await render();
    expect(summary()).toBe('Not configured');
  });

  it('折叠摘要：已选模型显示 供应商 / 模型名，无 label 时用模型 id', async () => {
    harness.state.gitCommitModel = { providerId: 'p1', modelId: 'a1' };
    await render();
    expect(summary()).toBe('P1 / Alpha');
    harness.state.gitCommitModel = { providerId: 'p2', modelId: 'b1' };
    await render();
    expect(summary()).toBe('P2 / b1');
  });

  it('折叠摘要：供应商没了或模型被停用都显示不可用', async () => {
    harness.state.gitCommitModel = { providerId: 'gone', modelId: 'x' };
    await render();
    expect(summary()).toBe('Selected model is unavailable');
    harness.state.gitCommitModel = { providerId: 'p2', modelId: 'b0' };
    await render();
    expect(summary()).toBe('Selected model is unavailable');
  });

  it.each([GIT_COMMIT_SETTINGS_ROW, 'providers.gitCommitModel'])(
    '深链指向 %s 时自动展开',
    async (rowId) => {
      linkTo(rowId, 1);
      await render();
      expect(textarea()).not.toBeNull();
      expect(
        container.querySelector('[data-settings-row="providers.gitCommitModel"]')
      ).not.toBeNull();
    }
  );

  it('深链指向别的行不展开；之后来一条指向本行的深链会展开', async () => {
    linkTo('providers.providers', 1);
    await render();
    expect(textarea()).toBeNull();
    linkTo(GIT_COMMIT_SETTINGS_ROW, 2);
    await render();
    expect(textarea()).not.toBeNull();
  });

  it('手动收起后，同一深链再次打开（linkSeq 递增）会重新展开', async () => {
    linkTo(GIT_COMMIT_SETTINGS_ROW, 1);
    await render();
    await toggle();
    expect(textarea()).toBeNull();
    await render();
    expect(textarea()).toBeNull();
    linkTo(GIT_COMMIT_SETTINGS_ROW, 2);
    await render();
    expect(textarea()).not.toBeNull();
  });

  it('设置搜索命中模型行（只有 revealRowId，没有深链）也会展开', async () => {
    await act(async () => root.render(<GitCommitSettings revealRowId="providers.providers" />));
    expect(textarea()).toBeNull();
    await act(async () =>
      root.render(<GitCommitSettings revealRowId="providers.gitCommitModel" />)
    );
    expect(textarea()).not.toBeNull();
  });

  it('展开后模型选择器：无推理控件，选中写入，清除写 null', async () => {
    harness.state.gitCommitModel = { providerId: 'p1', modelId: 'a2' };
    await render();
    await toggle();
    expect(harness.pickerProps?.showReasoningControls).toBe(false);
    expect(harness.pickerProps?.providerId).toBe('p1');
    expect(harness.pickerProps?.modelId).toBe('a2');
    const onSelect = harness.pickerProps?.onSelect;
    if (typeof onSelect === 'function') onSelect('p2', 'b1');
    expect(harness.state.setGitCommitModel).toHaveBeenCalledWith({
      providerId: 'p2',
      modelId: 'b1',
    });
    const clear = [...container.querySelectorAll('[data-row="Model"] button')].find(
      (button) => button.textContent === 'Clear'
    );
    await click(clear ?? null);
    expect(harness.state.setGitCommitModel).toHaveBeenLastCalledWith(null);
  });

  it('未选模型时没有清除入口', async () => {
    await render();
    await toggle();
    expect(container.querySelector('[data-row="Model"] button')).toBeNull();
  });

  it('展开后所选模型不可用时给出提示，选择器不带失效的选中项', async () => {
    harness.state.gitCommitModel = { providerId: 'gone', modelId: 'x' };
    await render();
    await toggle();
    expect(container.querySelector('[data-row="Model"]')?.textContent).toContain(
      'The selected model is unavailable. Choose another one.'
    );
    expect(harness.pickerProps?.providerId).toBe('');
    expect(harness.pickerProps?.modelId).toBe('');
  });

  it('未自定义时展示默认提示词，保存与恢复默认均不可点', async () => {
    await render();
    await toggle();
    expect(textarea()?.value).toBe(DEFAULT_GIT_COMMIT_PROMPT);
    expect(actionButtons().map((button) => (button as HTMLButtonElement).disabled)).toEqual([
      true,
      true,
    ]);
  });

  it('恢复默认：删文件、清标记、回到默认文本', async () => {
    harness.state.gitCommitPromptCustomized = true;
    await render();
    await toggle();
    const [reset] = actionButtons();
    await click(reset ?? null);
    expect(harness.git.resetCommitPrompt).toHaveBeenCalled();
    expect(harness.state.setGitCommitPromptCustomized).toHaveBeenCalledWith(false);
    expect(textarea()?.value).toBe(DEFAULT_GIT_COMMIT_PROMPT);
  });

  it('已自定义时展示文件内容', async () => {
    harness.state.gitCommitPromptCustomized = true;
    await render();
    await toggle();
    expect(textarea()?.value).toBe('custom');
  });
});
