import type {
  EvolvesEdgeDto,
  MemoryDetail,
  MemoryListItem,
  MemoryListQuery,
  MemoryListResult,
} from '@shared/memory/dto';
import {
  Children,
  type ComponentProps,
  createElement,
  type EffectCallback,
  type ElementType,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTitle } from '@/components/ui/dialog';
import { InputGroupInput } from '@/components/ui/input-group';
import { Select } from '@/components/ui/select';
import {
  emptyReason,
  isPristineEmpty,
  MemoryLibrary,
  MemoryRows,
  PendingReviewSection,
} from './MemoryLibrary';

const hooks = vi.hoisted(() => ({ current: null as LibraryHarness | null }));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (initial: unknown) =>
      // biome-ignore lint/correctness/useHookAtTopLevel: 仅组件测试启用 harness，SSR 子组件保留真实 hooks。
      hooks.current ? hooks.current.state(initial) : react.useState(initial),
    useRef: (initial: unknown) =>
      // biome-ignore lint/correctness/useHookAtTopLevel: 同上，测试适配层而非组件。
      hooks.current ? hooks.current.memo(() => ({ current: initial }), []) : react.useRef(initial),
    useCallback: (callback: () => unknown, deps: unknown[]) =>
      // biome-ignore lint/correctness/useHookAtTopLevel: 同上，测试适配层而非组件。
      hooks.current ? hooks.current.memo(() => callback, deps) : react.useCallback(callback, deps),
    useEffect: (effect: EffectCallback, deps: unknown[]) =>
      // biome-ignore lint/correctness/useHookAtTopLevel: 同上，测试适配层而非组件。
      hooks.current ? hooks.current.effect(effect, deps) : react.useEffect(effect, deps),
  };
});

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const t = (key: string, params?: Record<string, string>) =>
  params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '') : key;

function item(overrides: Partial<MemoryListItem> = {}): MemoryListItem {
  return {
    id: 'm1',
    title: 'Use Postgres',
    contentSummary: 'Chosen after benchmarking',
    unitType: 'decision',
    spaceId: 'global',
    spaceLabel: 'Global',
    importance: 0.6,
    isCrystal: false,
    isLatest: true,
    lifecycleState: 'active',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    accessCount: 3,
    ...overrides,
  };
}

const edge: EvolvesEdgeDto = {
  id: 'e1',
  olderId: 'older-id-1234',
  newerId: 'newer-id-5678',
  relation: 'challenges',
  confidence: 0.8,
  reason: 'Contradicts the earlier note',
  reviewState: 'pending',
  reviewedAt: null,
  createdAt: '2025-01-03T00:00:00.000Z',
};

// Node 环境下保留 hook 身份、依赖比较和 cleanup；交互走 JSX，不依赖 state 下标。
class LibraryHarness {
  private cells: { value?: unknown; deps?: unknown[]; cleanup?: () => void }[] = [];
  private cursor = 0;
  private effects: (() => void)[] = [];
  private tree: ReactNode = null;
  private mounted = true;
  private revision = 0;
  writesAfterUnmount = 0;

  state(initial: unknown) {
    const index = this.cursor++;
    this.cells[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    const cell = this.cells[index];
    return [
      cell.value,
      (value: unknown) => {
        if (!this.mounted) this.writesAfterUnmount++;
        cell.value = typeof value === 'function' ? value(cell.value) : value;
      },
    ];
  }

  memo(factory: () => unknown, deps: unknown[]) {
    const index = this.cursor++;
    const cell = this.cells[index];
    if (!cell || deps.some((dep, i) => !Object.is(dep, cell.deps?.[i]))) {
      this.cells[index] = { value: factory(), deps };
    }
    return this.cells[index].value;
  }

  effect(effect: EffectCallback, deps: unknown[]) {
    const index = this.cursor++;
    const cell = this.cells[index];
    if (!cell || deps.some((dep, i) => !Object.is(dep, cell.deps?.[i]))) {
      this.effects.push(() => {
        cell?.cleanup?.();
        this.cells[index] = { deps, cleanup: effect() || undefined };
      });
    }
  }

  render(revision = this.revision) {
    this.revision = revision;
    this.cursor = 0;
    hooks.current = this;
    try {
      this.tree = MemoryLibrary({ revision });
    } finally {
      hooks.current = null;
    }
    for (const effect of this.effects.splice(0)) effect();
    return this;
  }

  unmount() {
    for (const cell of this.cells) cell.cleanup?.();
    this.mounted = false;
  }

  elements(type: unknown): ReactElement<Record<string, unknown>>[] {
    const found: ReactElement<Record<string, unknown>>[] = [];
    const visit = (node: ReactNode) => {
      Children.forEach(node, (child) => {
        if (!isValidElement<Record<string, unknown>>(child)) return;
        if (child.type === type) found.push(child);
        visit(child.props.children as ReactNode);
      });
    };
    visit(this.tree);
    return found;
  }

  props<T extends ElementType>(type: T, index = 0): ComponentProps<T> {
    return this.elements(type)[index].props as ComponentProps<T>;
  }

  query(value: string) {
    this.props(InputGroupInput).onChange?.({ target: { value } } as Parameters<
      NonNullable<ComponentProps<typeof InputGroupInput>['onChange']>
    >[0]);
    return this.render();
  }

  select(index: number, value: string) {
    const change = this.props(Select, index).onValueChange;
    change?.(value, {} as Parameters<NonNullable<typeof change>>[1]);
    return this.render();
  }

  click(label: string) {
    const button = this.elements(Button).find((node) => node.props.children === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    (button.props.onClick as () => void)();
    return this.render();
  }

  html() {
    return renderToStaticMarkup(this.tree);
  }

  rows() {
    return this.props(MemoryRows).items.map((row: MemoryListItem) => row.title);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setupLibrary() {
  const requests: {
    query: MemoryListQuery;
    response: ReturnType<typeof deferred<MemoryListResult>>;
  }[] = [];
  const details: ReturnType<typeof deferred<MemoryDetail | null>>[] = [];
  let onChanged = () => {};
  const unsubscribe = vi.fn();
  const memory = {
    list: vi.fn((query: MemoryListQuery) => {
      const response = deferred<MemoryListResult>();
      requests.push({ query, response });
      return response.promise;
    }),
    stats: vi.fn(async () => ({
      bySpace: { 'project-A': 1, 'project-B': 1 },
      spaceLabels: { 'project-A': 'Project A', 'project-B': 'Project B' },
      total: 2,
    })),
    evolvesPending: vi.fn(async () => [edge]),
    detail: vi.fn(() => {
      const response = deferred<MemoryDetail | null>();
      details.push(response);
      return response.promise;
    }),
    archive: vi.fn(async () => ({ ok: true })),
    onChanged: vi.fn((listener: () => void) => {
      onChanged = listener;
      return unsubscribe;
    }),
  };
  vi.stubGlobal('window', { electronAPI: { memory } });
  const ui = new LibraryHarness().render();
  const reply = async (index: number, titles: string[], extra: Partial<MemoryListResult> = {}) => {
    requests[index].response.resolve({
      items: titles.map((title) => item({ id: title, title })),
      total: titles.length,
      ...extra,
    });
    await Promise.resolve();
    ui.render();
  };
  return { ui, requests, details, memory, reply, changed: () => onChanged(), unsubscribe };
}

afterEach(() => {
  hooks.current = null;
  vi.unstubAllGlobals();
});

describe('MemoryLibrary response ordering', () => {
  it.each(['query', 'space', 'page', 'mode', 'changed', 'revision'] as const)(
    'keeps the latest rows and count after an older %s response',
    async (change) => {
      const { ui, reply, requests, changed } = setupLibrary();
      await reply(0, ['Initial'], { total: 75 });
      ui.query('older');
      switch (change) {
        case 'query':
          ui.query('newer');
          break;
        case 'space':
          ui.select(1, 'project-B');
          break;
        case 'page':
          ui.click('Next');
          break;
        case 'mode':
          ui.select(0, 'fast');
          break;
        case 'changed':
          changed();
          break;
        case 'revision':
          ui.render(1);
          break;
      }
      expect(requests).toHaveLength(3);
      await reply(2, ['Relevant first', 'Relevant second'], {
        total: change === 'mode' ? 2 : 60,
        approximate: change === 'mode',
        vectorsUsed: change !== 'mode',
      });
      const latest = ui.html();
      expect(latest.indexOf('Relevant first')).toBeLessThan(latest.indexOf('Relevant second'));
      if (change === 'mode') {
        expect(latest).toContain('vectors are skipped');
        expect(ui.elements(Button).some((node) => node.props.children === 'Next')).toBe(false);
      } else {
        expect(latest).toContain(change === 'page' ? '26–50 / 60' : '1–25 / 60');
      }
      await reply(1, ['Obsolete'], { total: 999 });
      expect(ui.rows()).toEqual(['Relevant first', 'Relevant second']);
      expect(ui.html()).toBe(latest);
    }
  );

  it('preserves the latest semantic ranking and vector status when a slower query finishes', async () => {
    const { ui, reply } = setupLibrary();
    await reply(0, ['Initial']);
    ui.query('slow');
    ui.select(0, 'fast');
    ui.query('fast');
    await reply(3, ['Most relevant', 'Less relevant'], { approximate: true, vectorsUsed: true });
    const latest = ui.html();
    expect(latest.indexOf('Most relevant')).toBeLessThan(latest.indexOf('Less relevant'));
    await reply(2, ['Obsolete semantic'], { approximate: true, vectorsUsed: false });
    expect(ui.html()).toBe(latest);
    expect(ui.html()).not.toContain('vectors are skipped');
    expect(ui.elements(Button).some((node) => node.props.children === 'Next')).toBe(false);
  });

  it('invalidates a slow semantic response when its query becomes whitespace', async () => {
    const { ui, reply, requests } = setupLibrary();
    await reply(0, ['Initial']);
    ui.query('slow semantic');
    ui.select(0, 'fast');
    ui.query('   ');
    expect(requests).toHaveLength(3);
    ui.render();
    expect(ui.html()).toContain('Type a query to search by meaning.');
    await reply(2, ['Late semantic'], { approximate: true, vectorsUsed: false });
    await reply(1, ['Late exact'], { total: 100 });
    expect(ui.rows()).toEqual([]);
    expect(ui.html()).toContain('Type a query to search by meaning.');
    expect(ui.html()).not.toContain('vectors are skipped');
    expect(ui.elements(Button).some((node) => node.props.children === 'Next')).toBe(false);
  });

  it.each([false, true])(
    'keeps statistics and reviews independent of list retrieval (empty semantic: %s)',
    async (emptySemantic) => {
      const { ui, memory } = setupLibrary();
      if (emptySemantic) ui.select(0, 'fast');
      await Promise.resolve();
      ui.render();
      expect(memory.list).toHaveBeenCalledOnce();
      expect(ui.props(Select, 1).items).toContainEqual({ value: 'project-B', label: 'Project B' });
      expect(ui.html()).toContain(edge.reason);
      expect(ui.rows()).toEqual([]);
    }
  );

  it('reloads the current filter after a mutation started under an older filter', async () => {
    const { ui, reply, requests, memory } = setupLibrary();
    await reply(0, ['Initial']);
    const archived = deferred<{ ok: boolean }>();
    memory.archive.mockReturnValueOnce(archived.promise);
    ui.props(MemoryRows).onToggle?.('Initial');
    ui.render().click('Archive selected');
    ui.query('current');
    await reply(1, ['Current result']);
    archived.resolve({ ok: true });
    await Promise.resolve();
    expect(requests.at(-1)?.query.query).toBe('current');
    await reply(2, ['Current refreshed']);
    expect(ui.rows()).toEqual(['Current refreshed']);
  });

  it('does not apply pending list, statistics, review or detail replies after unmount', async () => {
    const { ui, requests, details, unsubscribe } = setupLibrary();
    ui.props(MemoryRows).onOpen('m1');
    ui.unmount();
    requests[0].response.resolve({ items: [item()], total: 1 });
    details[0].resolve(null);
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(ui.writesAfterUnmount).toBe(0);
  });

  it.each([false, true])('ignores an older detail response (closed: %s)', async (closed) => {
    const { ui, details } = setupLibrary();
    ui.props(MemoryRows).onOpen('older');
    ui.props(MemoryRows).onOpen('newer');
    const detail: MemoryDetail = {
      ...item({ id: 'newer', title: 'Newer detail' }),
      content: 'Body',
      eventStart: null,
      eventEnd: null,
      temporalPrecision: null,
      embeddingModel: null,
      evolves: [],
      entityNames: [],
      crystalSources: [],
    };
    details[1].resolve(detail);
    await Promise.resolve();
    ui.render();
    expect(ui.props(Dialog).open).toBe(true);
    expect(ui.props(DialogTitle).children).toBe('Newer detail');
    if (closed) {
      const close = ui.props(Dialog).onOpenChange;
      close?.(false, {} as Parameters<NonNullable<typeof close>>[1]);
      ui.render();
    }
    details[0].resolve({ ...detail, id: 'older', title: 'Older detail' });
    await Promise.resolve();
    ui.render();
    expect(ui.props(Dialog).open).toBe(!closed);
    if (!closed) expect(ui.props(DialogTitle).children).toBe('Newer detail');
    expect(ui.elements(DialogTitle).some((node) => node.props.children === 'Older detail')).toBe(
      false
    );
  });
});

describe('emptyReason', () => {
  it('asks for a query in semantic mode instead of blaming the filters', () => {
    // 语义检索按相关度排序，没查询词后端直接返回空——说「没有符合筛选条件」是误导
    expect(emptyReason('fast', '', false, false)).toBe('needs-query');
    expect(emptyReason('deep', '   ', true, true)).toBe('needs-query');
  });

  it('falls back to the exact-mode distinction once a query exists', () => {
    expect(emptyReason('fast', 'redis', false, false)).toBe('library-empty');
    expect(emptyReason('deep', 'redis', true, true)).toBe('no-match');
    // 精确模式可以无查询词列全部，所以空查询不算 needs-query
    expect(emptyReason('exact', '', false, false)).toBe('library-empty');
    expect(emptyReason('exact', '', true, false)).toBe('no-match');
  });
});

describe('isPristineEmpty', () => {
  it('separates "library is empty" from "filters matched nothing"', () => {
    expect(isPristineEmpty(false, false)).toBe(true);
    expect(isPristineEmpty(false, true)).toBe(false);
    expect(isPristineEmpty(true, false)).toBe(false);
    // 统计尚未返回时不敢断言库是空的，按「无匹配」显示
    expect(isPristineEmpty(null, false)).toBe(false);
  });
});

describe('MemoryRows', () => {
  it('marks crystals and archived rows, and shows access counts', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryRows, {
        t,
        onOpen: () => {},
        items: [
          item({ id: 'c1', isCrystal: true, title: 'Retrieval fuses three channels' }),
          item({ id: 'a1', lifecycleState: 'archived', title: 'Old decision' }),
        ],
      })
    );
    expect(html).toContain('★');
    expect(html).toContain('Archived');
    expect(html).toContain('Retrieval fuses three channels');
    expect(html).toContain('3 hits');
    expect(html).toContain('decision');
  });

  it('shows the caller-provided empty label instead of a bare list', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryRows, {
        t,
        onOpen: () => {},
        items: [],
        emptyLabel: 'No memories match these filters.',
      })
    );
    expect(html).toContain('No memories match these filters.');
    expect(html).not.toContain('<li class="flex items-center gap-2 px-3 py-2">');
  });
});

describe('PendingReviewSection', () => {
  it('is absent when nothing is pending', () => {
    const html = renderToStaticMarkup(
      createElement(PendingReviewSection, { t, edges: [], onReview: () => {} })
    );
    expect(html).toBe('');
  });

  it('states that reviewing never deletes or supersedes anything', () => {
    const html = renderToStaticMarkup(
      createElement(PendingReviewSection, { t, edges: [edge], onReview: () => {} })
    );
    expect(html).toContain('Needs review');
    expect(html).toContain('challenges');
    expect(html).toContain('Contradicts the earlier note');
    expect(html).toContain(
      'Reviewing only records your judgement. Nothing is deleted and no memory is superseded.'
    );
    // 拒绝按钮的文案不能暗示删除
    expect(html).toContain('Dismiss');
    expect(html).not.toContain('Delete');
  });
});
