import { parseHTML } from 'linkedom';
import { act, type ChangeEvent, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileOpeningSettings } from './FileOpeningSettings';

const harness = vi.hoisted(() => ({
  rules: [] as { extension: string; target: string; applicationPath?: string }[],
  setRules: vi.fn(),
  picker: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ fileOpenRules: harness.rules, setFileOpenRules: harness.setRules }),
}));
vi.mock('@/components/ui/toast', () => ({ addToast: harness.toast }));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock('@/components/ui/input', () => ({
  Input: ({ onChange, ...props }: ComponentProps<'input'>) => (
    <input
      {...props}
      onInput={(event) =>
        onChange?.({ ...event, target: event.currentTarget } as ChangeEvent<HTMLInputElement>)
      }
    />
  ),
}));
vi.mock('@/components/ui/select', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: ({
      items,
      value,
      onValueChange,
    }: {
      items: Record<string, string>;
      value: string;
      onValueChange: (value: string) => void;
    }) => (
      <div data-target-value={value}>
        {Object.entries(items).map(([target, label]) => (
          <button
            key={target}
            type="button"
            data-target={target}
            onClick={() => onValueChange(target)}
          >
            {label}
          </button>
        ))}
      </div>
    ),
    SelectTrigger: Wrap,
    SelectValue: () => null,
    SelectPopup: Wrap,
    SelectItem: Wrap,
  };
});

let root: Root;
let container: HTMLElement;
const render = async () => {
  await act(async () => root.render(<FileOpeningSettings />));
};
const button = (text: string) => {
  const found = [...container.querySelectorAll('button')].find(
    (element) => element.textContent === text
  );
  expect(found).not.toBeUndefined();
  return found;
};
const click = async (text: string) => {
  await act(async () => button(text)?.click());
};
const enter = async (value: string) => {
  const input = container.querySelector('input[aria-label="File extension"]');
  expect(input).not.toBeNull();
  await act(async () => {
    if (!input) return;
    (input as HTMLInputElement).value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};

beforeEach(async () => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, { electronAPI: { dialog: { selectFile: harness.picker } } });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  vi.clearAllMocks();
  harness.rules = [];
  harness.setRules.mockImplementation((rules) => {
    harness.rules = rules;
  });
  harness.picker.mockResolvedValue('C:/Applications/editor.exe');
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('FileOpeningSettings', () => {
  it('显示默认行为和可执行文件安全说明，并规范化新扩展名', async () => {
    expect(container.textContent).toContain('By default, supported files open inside EnsoCode');
    expect(container.textContent).toContain('Executable and installer files are always revealed');
    await enter(' MD ');
    await click('Add');
    expect(harness.rules).toEqual([{ extension: '.md', target: 'internal' }]);
    await render();
    expect(container.textContent).toContain('.md');
  });

  it('拒绝无效扩展名和不支持的内部格式，不污染已保存设置', async () => {
    await enter('../exe');
    await click('Add');
    expect(harness.rules).toEqual([]);
    expect(container.textContent).toContain('Enter a valid file extension');
    await enter('.unknown');
    await click('Add');
    expect(harness.rules).toEqual([]);
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        description: 'This extension does not support internal preview.',
      })
    );
  });

  it('应用路径仅通过系统 picker，取消不保存；选择后可以持久化并删除', async () => {
    await enter('.md');
    await click('Selected application');
    harness.picker.mockResolvedValueOnce(null);
    await click('Choose application');
    await click('Add');
    expect(harness.rules).toEqual([]);
    await click('Choose application');
    expect(harness.picker).toHaveBeenCalledWith();
    expect(container.querySelectorAll('input')).toHaveLength(1);
    await click('Add');
    expect(harness.rules).toEqual([
      { extension: '.md', target: 'application', applicationPath: 'C:/Applications/editor.exe' },
    ]);
    await render();
    expect(container.textContent).toContain('C:/Applications/editor.exe');
    await click('Delete');
    expect(harness.rules).toEqual([]);
  });

  it('重新读取规则后可直接编辑目标；阻止重复扩展名', async () => {
    harness.rules = [{ extension: '.txt', target: 'reveal' }];
    await render();
    expect(container.textContent).toContain('.txt');
    await click('System default application');
    expect(harness.rules).toEqual([{ extension: '.txt', target: 'system' }]);
    await enter(' TXT ');
    await click('Add');
    expect(harness.rules).toHaveLength(1);
    expect(container.textContent).toContain('This extension already has an opening rule.');
  });

  it('源码扩展名支持 internal，禁止外部执行不等于禁止内部阅读', async () => {
    harness.rules = [{ extension: '.ts', target: 'internal' }];
    await render();
    expect(container.querySelector('[data-target-value]')?.getAttribute('data-target-value')).toBe(
      'internal'
    );
    harness.rules = [];
    await render();
    await enter('.ts');
    await click('Add');
    expect(harness.rules).toEqual([{ extension: '.ts', target: 'internal' }]);
  });

  it('已有规则遇到不合法 picker 结果时不被整组清空，错误可见', async () => {
    const original = [{ extension: '.txt', target: 'reveal' }];
    harness.rules = original;
    harness.picker.mockResolvedValueOnce('relative-editor.exe');
    await render();
    await click('Selected application');
    expect(harness.rules).toEqual(original);
    expect(harness.setRules).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
