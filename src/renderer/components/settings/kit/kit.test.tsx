import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettingsDangerAction,
  SettingsExpandableRow,
  SettingsInput,
  SettingsPage,
  SettingsPreview,
  SettingsRow,
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
    onChange,
    ...props
  }: Omit<ComponentProps<'input'>, 'size'> & { size?: string }) => (
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
