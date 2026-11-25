import { parseHTML } from 'linkedom';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, vi } from 'vitest';

/**
 * 设置迁移的行为钉子：真实 settings store 渲染整组页面，逐个控件记录
 * 所在行、当前值、点每个选项写进 store / electronAPI 的内容。迁移只换外观，快照不能变。
 * 页面要在 beforeAll 之后动态 import，下面的 mock 才生效。
 */

const calls: string[] = [];

vi.mock('@/i18n', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useI18n: () => ({ t: (key: string) => key, language: 'en' }),
}));
vi.mock('@/components/ui/toast', () => ({ addToast: () => {}, toastManager: { add: () => {} } }));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked === true}
      disabled={disabled}
      onClick={() => onCheckedChange?.(checked !== true)}
    />
  ),
}));
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
  }) => (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked === true}
      onClick={() => onCheckedChange?.(checked !== true)}
    />
  ),
}));
vi.mock('@/components/ui/select', () => {
  type Ctx = { value: unknown; onValueChange?: (v: unknown) => void; items: boolean };
  const SelectCtx = React.createContext<Ctx>({ value: null, items: false });
  const option = (ctx: Ctx, value: unknown) => (
    <button
      key={String(value)}
      type="button"
      role="option"
      aria-selected={Object.is(ctx.value, value)}
      onClick={() => ctx.onValueChange?.(value)}
    />
  );
  return {
    Select: ({
      value,
      onValueChange,
      items,
      children,
    }: {
      value?: unknown;
      onValueChange?: (v: unknown) => void;
      items?: Record<string, unknown> | { value: unknown }[];
      children?: React.ReactNode;
    }) => {
      const ctx = { value, onValueChange, items: !!items };
      const keys = Array.isArray(items) ? items.map((i) => i.value) : Object.keys(items ?? {});
      return (
        <SelectCtx.Provider value={ctx}>
          <div data-pin="select">
            {keys.map((k) => option(ctx, k))}
            {children}
          </div>
        </SelectCtx.Provider>
      );
    },
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectSeparator: () => null,
    SelectGroupLabel: () => null,
    SelectGroup: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectPopup: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value }: { value: unknown }) => {
      const ctx = React.useContext(SelectCtx);
      return ctx.items ? null : option(ctx, value);
    },
  };
});
vi.mock('@/components/ui/radio-group', () => {
  const RadioCtx = React.createContext<{ value: unknown; onValueChange?: (v: unknown) => void }>({
    value: null,
  });
  const Radio = ({ value }: { value: unknown }) => {
    const ctx = React.useContext(RadioCtx);
    return (
      <button
        type="button"
        role="radio"
        aria-checked={Object.is(ctx.value, value)}
        onClick={() => ctx.onValueChange?.(value)}
      />
    );
  };
  return {
    RadioGroup: ({
      value,
      onValueChange,
      children,
    }: {
      value?: unknown;
      onValueChange?: (v: unknown) => void;
      children?: React.ReactNode;
    }) => (
      <RadioCtx.Provider value={{ value, onValueChange }}>
        <div role="radiogroup">{children}</div>
      </RadioCtx.Provider>
    ),
    Radio,
    RadioGroupItem: Radio,
  };
});
vi.mock('@/components/ui/slider', () => ({
  Slider: ({ value }: { value?: unknown }) => (
    <output data-pin-slider data-pin-value={JSON.stringify(value)} />
  ),
  SliderValue: () => null,
}));

type Result = unknown | ((args: unknown[]) => unknown);
export type PinConfig = {
  pages: () => Promise<Record<string, React.ComponentType>>;
  /** electronAPI 读接口的返回值；其余调用返回 null */
  results?: Record<string, Result>;
  props?: Record<string, unknown>;
};

const resolve = (result: Result, args: unknown[]) =>
  typeof result === 'function' ? (result as (a: unknown[]) => unknown)(args) : (result ?? null);

let root: Root;
let container: HTMLElement;
let store: typeof import('@/stores/settings').useSettingsStore;
let pages: Record<string, React.ComponentType>;

const plain = (state: object) =>
  JSON.parse(JSON.stringify(state, (_k, v) => (typeof v === 'function' ? undefined : v))) as Record<
    string,
    unknown
  >;

function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  return out;
}

export function setupPin(config: PinConfig) {
  const results = config.results ?? {};
  const props = config.props ?? {};
  beforeAll(async () => {
    const dom = parseHTML(
      '<!doctype html><html><head></head><body><div id="root"></div></body></html>'
    );
    const record =
      (path: string) =>
      (...args: unknown[]) => {
        // store 自己的落盘由 store diff 覆盖，这里只记页面直接发起的调用
        if (!path.startsWith('electronAPI.settings.')) {
          calls.push(`${path}(${JSON.stringify(args).slice(1, -1)})`);
        }
        if (/\.on[A-Z]/.test(path)) return () => {};
        return Promise.resolve(resolve(results[path], args));
      };
    const api = (path: string): unknown =>
      new Proxy(record(path), {
        get: (_t, key) =>
          key === 'then'
            ? undefined
            : `${path}.${String(key)}` in props
              ? props[`${path}.${String(key)}`]
              : api(`${path}.${String(key)}`),
      });
    Object.assign(dom.window, {
      electronAPI: api('electronAPI'),
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('navigator', { language: 'en-US', platform: 'MacIntel', userAgent: 'node' });
    vi.stubGlobal(
      'localStorage',
      dom.window.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} }
    );
    for (const name of [
      'HTMLElement',
      'Element',
      'Node',
      'HTMLInputElement',
      'Event',
      'CustomEvent',
      'getComputedStyle',
    ] as const) {
      const value = (dom as unknown as Record<string, unknown>)[name];
      if (value) vi.stubGlobal(name, value);
    }
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    store = (await import('@/stores/settings')).useSettingsStore;
    pages = await config.pages();
    container = dom.document.getElementById('root') as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () =>
      root.render(
        Object.entries(pages).map(([id, Page]) => (
          <section key={id} data-pin-page={id}>
            <Page />
          </section>
        ))
      )
    );
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  });

  afterAll(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  return {
    get container() {
      return container;
    },
    get store() {
      return store;
    },
    rows: () =>
      [
        ...new Set(
          [...container.querySelectorAll('[data-settings-row]')].map((el) =>
            el.getAttribute('data-settings-row')
          )
        ),
      ].sort(),
    probe,
    settle: () => act(async () => new Promise((r) => setTimeout(r, 20))),
  };
}

type Control = { row: string | null; kind: string; current: unknown; effects: unknown[] };

export async function click(el: HTMLElement) {
  await act(async () => el.click());
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

/** pressGroups：把 aria-pressed 按钮按父元素当成一组单选（秘书页的芯片） */
async function probe({ pressGroups = false } = {}): Promise<Control[]> {
  const initial = store.getState();
  const base = plain(initial);
  const reset = async () => {
    await act(async () => store.setState(initial, true));
    calls.length = 0;
  };
  const rowOf = (el: Element) =>
    el.closest('[data-settings-row]')?.getAttribute('data-settings-row') ?? null;
  const effect = async (el: HTMLElement) => {
    await reset();
    await click(el);
    const out = { store: diff(base, plain(store.getState())), api: [...calls].sort() };
    await reset();
    return out;
  };
  const out: Control[] = [];
  const find = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[];

  for (const el of find('[role="switch"], [role="checkbox"]')) {
    if (el.hasAttribute('disabled')) continue;
    out.push({
      row: rowOf(el),
      kind: el.getAttribute('role') ?? '',
      current: el.getAttribute('aria-checked'),
      effects: [await effect(el)],
    });
  }
  const groups = new Set<Element>();
  for (const el of find('[role="option"], [role="radio"]')) {
    groups.add(el.closest('[data-pin="select"], [role="radiogroup"]') as Element);
  }
  if (pressGroups) {
    for (const el of find('button[aria-pressed]')) groups.add(el.parentElement as Element);
  }
  for (const group of groups) {
    const options = [
      ...group.querySelectorAll(':scope > button[aria-pressed], [role="option"], [role="radio"]'),
    ] as HTMLElement[];
    const effects: { selected: boolean; store: unknown; api: string[] }[] = [];
    for (const option of options) {
      const selected =
        (option.getAttribute('aria-selected') ??
          option.getAttribute('aria-checked') ??
          option.getAttribute('aria-pressed')) === 'true';
      effects.push({ selected, ...(await effect(option)) });
    }
    // 选中项点了不写；用其余选项写的 key 回读它的当前值，选项顺序与标签无关
    const keys = [...new Set(effects.flatMap((e) => Object.keys(e.store as object)))].sort();
    out.push({
      row: rowOf(group),
      kind: 'choice',
      current: Object.fromEntries(keys.map((k) => [k, base[k]])),
      ...(pressGroups && {
        selected: options
          .filter((o) => o.getAttribute('aria-pressed') === 'true')
          .map((o) => o.textContent?.trim()),
      }),
      effects: effects
        .filter((e) => !e.selected)
        .map((e) => JSON.stringify({ store: e.store, api: e.api }))
        .sort(),
    });
  }
  for (const el of find('[data-pin-slider]')) {
    out.push({
      row: rowOf(el),
      kind: 'slider',
      current: el.getAttribute('data-pin-value'),
      effects: [],
    });
  }
  for (const el of find('input:not([type="hidden"]):not([type="file"]), textarea')) {
    out.push({
      row: rowOf(el),
      kind: el.tagName.toLowerCase(),
      current: (el as HTMLInputElement).value ?? null,
      effects: [],
    });
  }
  return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
