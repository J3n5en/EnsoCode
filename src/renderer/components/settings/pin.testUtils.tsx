import { AsyncLocalStorage } from 'node:async_hooks';
import { MotionGlobalConfig } from 'framer-motion';
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
  pages: () => Promise<Record<string, React.ComponentType>> | Record<string, React.ComponentType>;
  /** electronAPI 读接口的返回值；其余调用返回 null */
  results?: Record<string, Result>;
  props?: Record<string, unknown>;
};

const resolve = (result: Result, args: unknown[]) =>
  typeof result === 'function' ? (result as (a: unknown[]) => unknown)(args) : (result ?? null);

/**
 * 排空并让 act 冲刷 effect。钉子里所有 IPC mock 都是已解决的 Promise，effect 链
 * （加载 → setState → 渲染 → 再加载）纯由微任务驱动，await act 本身就会递归
 * 冲刷微任务队列，一轮即收敛；这里多留一轮给 React 并发调度的 fallback。
 * 不能用固定墙钟毫秒数等待：等待时长与链的真实进度无关，机器忙时链没跑完
 * 就拍快照，是初值漂移的来源。
 */
const DRAIN_ROUNDS = 3;
async function drain(rounds = DRAIN_ROUNDS) {
  // 多余的 act 调用只是事件循环上的排队开销：act 队列全局共享，高负载下
  // 每个控件多花几轮就是几秒，还会与迟到的并发 act 互相警告「overlapping act()」。
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/**
 * 页面自己发起的后台轮询（资源采样、记忆任务/统计）与初始加载、控件重置后的重载，
 * 都会在测量窗口之外随时调用 electronAPI；它们何时落进哪个窗口全凭时序，是快照里
 * 「时有时无」噪音的来源。测量窗口用世代归因：只有点控件本身触发的调用才进记录，
 * 其余一律排除——排除逻辑与时序无关，因而是确定性的。
 */
const als = new AsyncLocalStorage<{ gen: number }>();
let currentGen = 0;

/**
 * 每个测试文件在独立 worker 里运行，环境桩必须在 settings store 与页面模块
 * 求值之前装好（它们的模块顶层会触摸 window / electronAPI）。因此整个环境
 * 在本模块求值时就绪：mock 结果由 setupPin 在收集阶段写入 activeConfig，
 * 而收集与 store/页面的动态 import 都在文件求值期完成——beforeAll 钩子里
 * 只剩渲染本身，模块加载不再占用钩子的 10s 预算。
 */
const activeConfig: { results: Record<string, Result>; props: Record<string, unknown> } = {
  // store 在 setupPin 收集配置之前就已求值，初始投影读取不能拿到 null
  results: { 'electronAPI.sourceAuthority.read': { projects: [], conversations: [] } },
  props: {},
};
const dom = parseHTML(
  '<!doctype html><html><head></head><body><div id="pin-root"></div></body></html>'
);
const record =
  (path: string) =>
  (...args: unknown[]) => {
    // store 自己的落盘由 store diff 覆盖，这里只记页面直接发起的调用
    // 测量窗口之外的调用（初始加载、后台轮询、重置后的重载）不记录
    if (!path.startsWith('electronAPI.settings.') && als.getStore()?.gen === currentGen) {
      calls.push(`${path}(${JSON.stringify(args).slice(1, -1)})`);
    }
    if (/\.on[A-Z]/.test(path)) return () => {};
    return Promise.resolve(resolve(activeConfig.results[path], args));
  };
const api = (path: string): unknown =>
  new Proxy(record(path), {
    get: (_t, key) =>
      key === 'then'
        ? undefined
        : `${path}.${String(key)}` in activeConfig.props
          ? activeConfig.props[`${path}.${String(key)}`]
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

// 顶层 await：store 模块的求值（连带其依赖树）在文件求值期完成，
// 不占 beforeAll 钩子的时间预算
const { useSettingsStore } = await import('@/stores/settings');

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
  // 收集阶段写 mock 配置：同文件后续动态 import 的页面模块读到同一套 electronAPI。
  // 同一文件多个 setupPin（分组场景）共享配置——它们本来就用同一份 config。
  Object.assign(activeConfig.results, config.results ?? {});
  Object.assign(activeConfig.props, config.props ?? {});
  const container = dom.document.createElement('div') as unknown as HTMLElement;
  dom.document.body.appendChild(container);
  let root: Root;
  // 分组折叠用了 framer-motion 的 heightVariants，pin 快照只认结构不认动效进度，
  // 收集阶段跳过动画，快照不随 rAF 时序漂。
  const prevSkipAnimations = MotionGlobalConfig.skipAnimations;
  beforeAll(async () => {
    MotionGlobalConfig.skipAnimations = true;
    const pages = await config.pages();
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
    await drain();
  });

  afterAll(async () => {
    await act(async () => root?.unmount());
    container.remove();
    MotionGlobalConfig.skipAnimations = prevSkipAnimations;
  });
  return {
    get container() {
      return container;
    },
    get store() {
      return useSettingsStore;
    },
    rows: () =>
      [
        ...new Set(
          [...container.querySelectorAll('[data-settings-row]')].map((el) =>
            el.getAttribute('data-settings-row')
          )
        ),
      ].sort(),
    probe: (opts?: { pressGroups?: boolean }) => probe(container, opts),
    settle: () => drain(),
  };
}

type Control = { row: string | null; kind: string; current: unknown; effects: unknown[] };

export async function click(el: HTMLElement) {
  // 一个 act 即冲刷完整链：点击 → promise → setState → 渲染 → effect 链，
  // React 19 的 act 递归排空微任务队列，不需要额外的墙钟或轮次等待。
  await act(async () => el.click());
}

/** pressGroups：把 aria-pressed 按钮按父元素当成一组单选（秘书页的芯片） */
async function probe(container: HTMLElement, { pressGroups = false } = {}): Promise<Control[]> {
  const initial = useSettingsStore.getState();
  const base = plain(initial);
  const reset = async () => {
    await act(async () => useSettingsStore.setState(initial, true));
    // 重置触发的重载链已由 act 冲刷完毕，这里清掉它的调用记录，
    // 测量窗口只看点控件本身触发的调用
    calls.length = 0;
  };
  const rowOf = (el: Element) =>
    el.closest('[data-settings-row]')?.getAttribute('data-settings-row') ?? null;
  const effect = async (el: HTMLElement) => {
    await reset();
    // 开一代新的测量窗口：只有点击直接触发的 electronAPI 调用（含其 effect
    // 链的后续）带着这个世代；窗口外的一切后台与迟到调用都被排除。
    const out = await als.run({ gen: ++currentGen }, async () => {
      await click(el);
      return { store: diff(base, plain(useSettingsStore.getState())), api: [...calls].sort() };
    });
    // 收尾重置是语义的一部分：每个控件都从基线状态出发测量，否则点击写穿的
    // 值会留在 DOM 里，下一控件的「当前值/效果」都偏离基线
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
          .filter(
            (o) => (o.getAttribute('aria-pressed') ?? o.getAttribute('aria-checked')) === 'true'
          )
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
