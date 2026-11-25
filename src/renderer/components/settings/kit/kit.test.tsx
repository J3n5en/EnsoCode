import { MotionGlobalConfig } from 'framer-motion';
import { parseHTML } from 'linkedom';
import * as React from 'react';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettingsDangerAction,
  SettingsEmptyState,
  SettingsExpandableRow,
  SettingsInput,
  SettingsPage,
  SettingsPreview,
  SettingsRow,
  SettingsSearch,
  SettingsSection,
  SettingsSegmented,
  SettingsSubRow,
  SettingsSwitch,
} from '.';
import { countBoxesInSource, findNestedBoxes } from './boxes';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    className: _className,
    ...rest
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    className?: string;
  } & Record<string, unknown>) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked === true}
      onClick={() => onCheckedChange?.(checked !== true)}
      {...rest}
    />
  ),
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    variant,
    size: _size,
    ...props
  }: ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" data-variant={variant} {...props} />
  ),
}));
vi.mock('@/components/ui/input', () => ({
  // linkedom 下 React 收不到 change，按 input 事件转发
  Input: ({
    size: _size,
    unstyled: _unstyled,
    onChange,
    ...props
  }: Omit<ComponentProps<'input'>, 'size'> & { size?: string; unstyled?: boolean }) => (
    <input {...props} onInput={onChange as ComponentProps<'input'>['onInput']} />
  ),
}));
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: Pass,
    SelectPopup: Pass,
    SelectValue: () => null,
    SelectItem: Pass,
    SelectTrigger: ({ size: _size, ...props }: ComponentProps<'button'> & { size?: string }) => (
      <button type="button" data-slot="select-trigger" {...props} />
    ),
  };
});
vi.mock('@/components/ui/alert-dialog', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogPopup: Pass,
    AlertDialogHeader: Pass,
    AlertDialogFooter: Pass,
    AlertDialogTitle: Pass,
    AlertDialogDescription: Pass,
  };
});

let root: Root;
let container: HTMLElement;
let doc: Document;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

const byText = (selector: string, text: string) => {
  const found = [...container.querySelectorAll(selector)].find((el) =>
    el.textContent?.includes(text)
  );
  expect(found, `${selector} ${text}`).not.toBeUndefined();
  return found as HTMLElement;
};

beforeEach(() => {
  MotionGlobalConfig.skipAnimations = true;
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  doc = dom.document as unknown as Document;
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  MotionGlobalConfig.skipAnimations = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SettingsRow', () => {
  it('分段控件的选项在触屏下至少 44px 宽，滚动框上下放出 44px 热区不被裁掉', async () => {
    await render(
      <SettingsRow rowId="x.level" label="Level">
        <SettingsSegmented
          value="a"
          onValueChange={() => {}}
          options={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ]}
        />
      </SettingsRow>
    );
    const option = container.querySelector('[role="radio"]') as HTMLElement;
    expect(option.className.split(' ')).toContain('pointer-coarse:min-w-[44px]');
    const scroller = option.parentElement as HTMLElement;
    expect(scroller.className).toContain('overflow-x-auto');
    expect(scroller.className.split(' ')).toEqual(
      expect.arrayContaining(['pointer-coarse:py-[12px]', 'pointer-coarse:-my-[12px]'])
    );
  });

  it('标签与说明通过 id 关联到控件，深链行号落在行上', async () => {
    const onChange = vi.fn();
    await render(
      <SettingsRow label="Record app logs" description="Off by default." rowId="logs.app">
        <SettingsSwitch checked={false} onCheckedChange={onChange} />
      </SettingsRow>
    );
    const label = byText('label', 'Record app logs') as HTMLLabelElement;
    const control = doc.getElementById(label.getAttribute('for') ?? '');
    expect(control?.getAttribute('role')).toBe('switch');
    expect(control?.getAttribute('aria-labelledby')).toBe(label.id);
    const description = doc.getElementById(control?.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe('Off by default.');
    expect(container.querySelector('[data-settings-row="logs.app"]')?.contains(control)).toBe(true);
    await act(async () => control?.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('同一页多行的 id 互不相同', async () => {
    await render(
      <>
        <SettingsRow label="A">
          <SettingsSwitch checked onCheckedChange={() => {}} />
        </SettingsRow>
        <SettingsRow label="B">
          <SettingsSwitch checked onCheckedChange={() => {}} />
        </SettingsRow>
      </>
    );
    const ids = [...container.querySelectorAll('[role="switch"]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(Boolean)).toBe(true);
  });

  it('分段控件是带标签的单选组，点选写回取值', async () => {
    const onChange = vi.fn();
    await render(
      <SettingsRow label="Level">
        <SettingsSegmented
          value="error"
          onValueChange={onChange}
          options={[
            { value: 'error', label: 'Errors only' },
            { value: 'warn', label: 'Warnings and errors' },
          ]}
        />
      </SettingsRow>
    );
    const group = container.querySelector('[role="radiogroup"]');
    const label = byText('label', 'Level');
    expect(group?.getAttribute('aria-labelledby')).toBe(label.id);
    const radios = [...container.querySelectorAll('[role="radio"]')];
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    await act(async () => (radios[1] as HTMLElement).click());
    expect(onChange).toHaveBeenCalledWith('warn');
  });

  it('文本框停止输入 600ms 后保存，控件左侧显示「已保存」1.5 秒后消失', async () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    await render(
      <SettingsRow label="Name">
        <SettingsInput value="a" onCommit={onCommit} />
      </SettingsRow>
    );
    const input = container.querySelector('input') as HTMLInputElement;
    const label = byText('label', 'Name');
    expect(input.id).toBe(label.getAttribute('for'));
    await act(async () => {
      let proto = Object.getPrototypeOf(input);
      while (proto && !Object.getOwnPropertyDescriptor(proto, 'value')) {
        proto = Object.getPrototypeOf(proto);
      }
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, 'ab');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('ab');
    expect(onCommit).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Saved');
    await act(async () => vi.advanceTimersByTime(600));
    expect(onCommit).toHaveBeenCalledWith('ab');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Saved');
    await act(async () => vi.advanceTimersByTime(1500));
    expect(container.textContent).not.toContain('Saved');
  });
});

describe('SettingsSearch', () => {
  const type = async (input: HTMLInputElement, value: string) =>
    act(async () => {
      let proto = Object.getPrototypeOf(input);
      while (proto && !Object.getOwnPropertyDescriptor(proto, 'value')) {
        proto = Object.getPrototypeOf(proto);
      }
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const pressEscape = async (input: HTMLInputElement) =>
    act(async () => {
      input.dispatchEvent(
        Object.assign(new window.Event('keydown', { bubbles: true, cancelable: true }), {
          key: 'Escape',
        })
      );
    });

  function Harness({ onOuterEscape }: { onOuterEscape: () => void }) {
    const [value, setValue] = React.useState('');
    return (
      <div onKeyDown={(event) => event.key === 'Escape' && onOuterEscape()}>
        <SettingsSearch value={value} onValueChange={setValue} placeholder="Search settings" />
      </div>
    );
  }

  it('边输边筛；有字时 Esc 只清空不往外冒（不会顺带退出设置），空了再 Esc 才往外传', async () => {
    const outer = vi.fn();
    await render(<Harness onOuterEscape={outer} />);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('placeholder')).toBe('Search settings');
    expect(input.getAttribute('aria-label')).toBe('Search settings');
    await type(input, 'proxy');
    expect(input.value).toBe('proxy');
    await pressEscape(input);
    expect(input.value).toBe('');
    expect(outer).not.toHaveBeenCalled();
    await pressEscape(input);
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('不画带框容器', async () => {
    await render(<SettingsSearch value="" onValueChange={() => {}} placeholder="Search" />);
    expect(findNestedBoxes(container)).toEqual([]);
  });

  it('按下方向键把焦点交给结果列表', async () => {
    const onArrowDown = vi.fn();
    await render(
      <SettingsSearch
        value="proxy"
        onValueChange={() => {}}
        placeholder="Search"
        onArrowDown={onArrowDown}
      />
    );
    const input = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(
        Object.assign(new window.Event('keydown', { bubbles: true, cancelable: true }), {
          key: 'ArrowDown',
        })
      );
    });
    expect(onArrowDown).toHaveBeenCalledTimes(1);
  });

  it('有输入时显示清空按钮，点击后清空并保持焦点', async () => {
    await render(<Harness onOuterEscape={() => {}} />);
    expect(container.querySelector('button[aria-label="Clear search"]')).toBeNull();
    const input = container.querySelector('input') as HTMLInputElement;
    await type(input, 'proxy');
    const clearBtn = container.querySelector(
      'button[aria-label="Clear search"]'
    ) as HTMLButtonElement | null;
    expect(clearBtn).not.toBeNull();
    const focusSpy = vi.spyOn(input, 'focus');
    await act(async () => clearBtn?.click());
    expect(input.value).toBe('');
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="Clear search"]')).toBeNull();
  });
});

describe('SettingsSegmented', () => {
  it('支持图标，初始挂载直接定位不滑入，切换选项时启用滑动过渡，ResizeObserver 更新不滑动', async () => {
    let roCallback: (() => void) | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          roCallback = cb;
        }
        observe() {}
        disconnect() {}
      }
    );
    const IconA = () => <svg data-testid="icon-a" />;
    const IconB = () => <svg data-testid="icon-b" />;
    const options = [
      { value: 'a', label: 'First', icon: IconA },
      { value: 'b', label: 'Second', icon: IconB },
    ] as const;

    const setGeometry = () => {
      const radios = [...container.querySelectorAll('[role="radio"]')] as HTMLElement[];
      Object.defineProperty(radios[0], 'offsetLeft', { configurable: true, value: 0 });
      Object.defineProperty(radios[0], 'offsetWidth', { configurable: true, value: 60 });
      Object.defineProperty(radios[1], 'offsetLeft', { configurable: true, value: 64 });
      Object.defineProperty(radios[1], 'offsetWidth', { configurable: true, value: 72 });
    };

    function SegHarness() {
      const [val, setVal] = React.useState<'a' | 'b'>('a');
      return <SettingsSegmented value={val} onValueChange={setVal} options={options} />;
    }

    await render(<SegHarness />);
    expect(container.querySelector('[data-testid="icon-a"]')).not.toBeNull();
    setGeometry();
    // Trigger initial measurement via ResizeObserver callback (simulating layout pass)
    await act(async () => roCallback?.());
    let pill = container.querySelector('[data-slot="segmented-indicator"]') as HTMLElement | null;
    expect(pill).not.toBeNull();
    expect(pill?.style.width).toBe('60px');
    expect(pill?.style.transform).toBe('translateX(0px)');
    expect(pill?.className).not.toContain('transition-[transform,width]');

    // Switching value enables slide transition
    const radios = [...container.querySelectorAll('[role="radio"]')] as HTMLElement[];
    await act(async () => radios[1].click());
    pill = container.querySelector('[data-slot="segmented-indicator"]') as HTMLElement | null;
    expect(pill?.style.width).toBe('72px');
    expect(pill?.style.transform).toBe('translateX(64px)');
    expect(pill?.className).toContain('transition-[transform,width]');

    // ResizeObserver updates position without slide animation
    await act(async () => roCallback?.());
    pill = container.querySelector('[data-slot="segmented-indicator"]') as HTMLElement | null;
    expect(pill?.className).not.toContain('transition-[transform,width]');
  });
});

describe('SettingsEmptyState & SettingsSection', () => {
  it('SettingsEmptyState 渲染图标、标题、说明与操作，SettingsSection bare 不包分组容器', async () => {
    const DummyIcon = () => <svg data-testid="empty-icon" />;
    await render(
      <>
        <SettingsSection bare title="Bare">
          <div>content</div>
        </SettingsSection>
        <SettingsSection title="Grouped">
          <SettingsEmptyState
            icon={DummyIcon}
            title="Nothing here"
            description="Try adding one"
            actions={<button type="button">Add</button>}
          />
        </SettingsSection>
      </>
    );
    const groups = container.querySelectorAll('[data-slot="settings-group"]');
    expect(groups).toHaveLength(1);
    expect(container.querySelector('[data-slot="settings-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="empty-icon"]')).not.toBeNull();
    expect(container.textContent).toContain('Nothing here');
    expect(container.textContent).toContain('Try adding one');
    expect(findNestedBoxes(container)).toEqual([]);
  });
});

describe('SettingsExpandableRow', () => {
  it('点名字是展开，不经 label 去切右侧开关', async () => {
    const onChange = vi.fn();
    await render(
      <SettingsExpandableRow
        label="Plugin A"
        control={<SettingsSwitch checked={false} onCheckedChange={onChange} />}
      >
        <SettingsSubRow label="detail" />
      </SettingsExpandableRow>
    );
    const name = byText('label span', 'Plugin A');
    const click = new (window as unknown as { Event: typeof Event }).Event('click', {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => name.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(container.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe(
      'true'
    );
    expect(container.textContent).toContain('detail');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('默认收起，展开后子行缩进显示在同一列表里而不是内嵌卡片', async () => {
    await render(
      <SettingsSection title="Providers">
        <SettingsExpandableRow label="OpenAI" description="3 models">
          <SettingsSubRow label="gpt-5" />
          <SettingsSubRow label="gpt-5-mini" />
        </SettingsExpandableRow>
      </SettingsSection>
    );
    const toggle = container.querySelector('button[aria-expanded]') as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('gpt-5');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const region = doc.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(region?.textContent).toContain('gpt-5-mini');
    expect(region?.querySelectorAll('[data-slot="settings-row"]').length).toBe(2);
    expect(findNestedBoxes(container)).toEqual([]);
    await act(async () => toggle.click());
    expect(container.textContent).not.toContain('gpt-5');
  });

  it('受控时由外部决定展开，点箭头只回调', async () => {
    const onOpenChange = vi.fn();
    const mount = (open: boolean) =>
      render(
        <SettingsExpandableRow label="Advanced" open={open} onOpenChange={onOpenChange}>
          <SettingsSubRow label="Proxy" />
        </SettingsExpandableRow>
      );
    await mount(true);
    expect(container.textContent).toContain('Proxy');
    const toggle = container.querySelector('button[aria-expanded]') as HTMLElement;
    await act(async () => toggle.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(container.textContent).toContain('Proxy');
    await mount(false);
    expect(container.textContent).not.toContain('Proxy');
  });
});

describe('SettingsDangerAction', () => {
  const mount = (onConfirm: () => void, irreversible?: boolean) =>
    render(
      <SettingsSection tone="danger" title="Danger zone">
        <SettingsDangerAction
          label="Reset secretary"
          description="Clears the profile."
          actionLabel="Reset"
          confirmTitle='Reset "Alice"?'
          confirmLabel="Reset now"
          irreversible={irreversible}
          onConfirm={onConfirm}
        />
      </SettingsSection>
    );

  it('第一次点击只弹确认，取消不执行', async () => {
    const onConfirm = vi.fn();
    await mount(onConfirm);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => byText('button', 'Reset').click());
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Reset "Alice"?'
    );
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => byText('button', 'Cancel').click());
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('确认后执行并关闭', async () => {
    const onConfirm = vi.fn(async () => {});
    await mount(onConfirm);
    await act(async () => byText('button', 'Reset').click());
    await act(async () => byText('button', 'Reset now').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('可恢复用描边红按钮，不可恢复用实心红按钮', async () => {
    await mount(vi.fn());
    expect(byText('button', 'Reset').dataset.variant).toBe('destructive-outline');
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(vi.fn(), true);
    expect(byText('button', 'Reset').dataset.variant).toBe('destructive');
  });
});

describe('SettingsPage', () => {
  it('页标题、说明与页级操作，整页没有带框容器', async () => {
    await render(
      <SettingsPage
        title="Logs"
        description="Recent errors."
        actions={<button type="button">x</button>}
      >
        <SettingsSection title="Recording">
          <SettingsRow label="A">
            <SettingsSwitch checked onCheckedChange={() => {}} />
          </SettingsRow>
        </SettingsSection>
      </SettingsPage>
    );
    expect(container.querySelector('h1')?.textContent).toBe('Logs');
    expect(container.querySelector('h2')?.textContent).toBe('Recording');
    expect(findNestedBoxes(container)).toEqual([]);
  });
});

describe('SettingsPreview', () => {
  it('预览对象带一层边框并标记放行，里面再画框照算', async () => {
    await render(
      <SettingsPreview className="p-4">
        <div className="rounded border">inner</div>
      </SettingsPreview>
    );
    const preview = container.querySelector('[data-settings-preview]') as HTMLElement;
    expect(preview.className).toContain('border');
    expect(preview.className).toContain('p-4');
    expect(findNestedBoxes(container)).toHaveLength(1);
  });

  it('页面源码用它画预览框不计入带框容器', () => {
    expect(countBoxesInSource('<SettingsPreview className="p-4">x</SettingsPreview>')).toBe(0);
  });
});
