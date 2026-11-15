import type {
  MemoryDetail,
  MemoryListItem,
  MemoryListQuery,
  MemoryListResult,
  PendingEvolvesReviewDto,
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
import { MemoryDeleteDialog, MemoryEditDialog } from '@/components/memory/MemoryActionDialogs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTitle } from '@/components/ui/dialog';
import { InputGroupInput } from '@/components/ui/input-group';
import { Select } from '@/components/ui/select';
import {
  emptyReason,
  groupPendingReviews,
  isPristineEmpty,
  MemoryLibrary,
  MemoryRows,
  PENDING_REVIEW_ALERT,
  PENDING_REVIEW_GROUP_AT,
  PendingReviewSection,
  PendingWritesSection,
  scopeFilter,
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

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '') : key,
  }),
}));

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
    appearances: 3,
    lastHitAt: '2025-01-02T00:00:00.000Z',
    hitCount: 3,
    archiveCandidateAt: null,
    ...overrides,
  };
}

function review(overrides: Partial<PendingEvolvesReviewDto> = {}): PendingEvolvesReviewDto {
  return {
    edge: {
      id: 'e1',
      olderId: 'older-id-1234',
      newerId: 'newer-id-5678',
      relation: 'challenges',
      confidence: 1,
      reason: 'Contradicts the earlier note',
      reviewState: 'pending',
      reviewedAt: null,
      createdAt: '2025-01-03T00:00:00.000Z',
    },
    older: item({
      id: 'older-id-1234',
      title: 'Workflow removed; do not add back',
      contentSummary: 'The scripted workflow was deleted on purpose',
      spaceId: 'project-A',
      spaceLabel: 'Project A',
    }),
    newer: item({
      id: 'newer-id-5678',
      title: 'Wants a DeepSeek-style workflow',
      contentSummary: 'User asked for a scripted workflow again',
      spaceId: 'project-A',
      spaceLabel: 'Project A',
    }),
    ...overrides,
  };
}

const edge = review();

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

function setupLibrary(pending: PendingEvolvesReviewDto[] = [edge]) {
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
    evolvesPending: vi.fn(async () => pending),
    evolvesReview: vi.fn(async () => ({ ok: true })),
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
          ui.select(2, 'project-B');
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
      expect(ui.props(Select, 2).items).toContainEqual({ value: 'project-B', label: 'Project B' });
      expect(ui.html()).toContain(edge.edge.reason);
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

  it('row edit and delete go straight to the shared dialogs, without opening the detail', async () => {
    const { ui, reply, memory } = setupLibrary();
    await reply(0, ['Initial']);
    expect(ui.props(MemoryEditDialog).memoryId).toBeNull();
    expect(ui.props(MemoryDeleteDialog).ids).toBeNull();
    ui.props(MemoryRows).onEdit?.('Initial');
    ui.render();
    expect(ui.props(MemoryEditDialog).memoryId).toBe('Initial');
    ui.props(MemoryRows).onDelete?.('Initial');
    ui.render();
    expect(ui.props(MemoryDeleteDialog).ids).toEqual(['Initial']);
    expect(memory.detail).not.toHaveBeenCalled();
    expect(ui.props(Dialog).open).toBe(false);
  });

  it('the bulk delete button is styled as destructive and opens the impact confirm', async () => {
    const { ui, reply } = setupLibrary();
    await reply(0, ['Initial']);
    ui.props(MemoryRows).onToggle?.('Initial');
    ui.render();
    const bulk = ui.elements(Button).find((node) => node.props.children === 'Delete permanently');
    expect(bulk?.props.variant).toBe('destructive-outline');
    ui.click('Delete permanently');
    expect(ui.props(MemoryDeleteDialog).ids).toEqual(['Initial']);
  });

  it('批量审阅：全选后一次提交所选矛盾，逐条落库并清空勾选', async () => {
    const second = review({ edge: { ...edge.edge, id: 'e2' } });
    const { ui, memory, reply } = setupLibrary([edge, second]);
    await reply(0, ['Initial']);
    expect(ui.props(PendingReviewSection).items).toHaveLength(2);
    ui.props(PendingReviewSection).onToggleAll(true);
    ui.render();
    const selected = ui.props(PendingReviewSection).selected;
    expect([...selected]).toEqual(['e1', 'e2']);
    ui.props(PendingReviewSection).onReview([...selected], 'accepted');
    await Promise.resolve();
    await Promise.resolve();
    expect(memory.evolvesReview.mock.calls).toEqual([
      ['e1', 'accepted'],
      ['e2', 'accepted'],
    ]);
    ui.render();
    expect(ui.props(PendingReviewSection).selected.size).toBe(0);
  });

  it('单条审阅只提交这一条，忽略记为 rejected', async () => {
    const second = review({ edge: { ...edge.edge, id: 'e2' } });
    const { ui, memory, reply } = setupLibrary([edge, second]);
    await reply(0, ['Initial']);
    ui.props(PendingReviewSection).onReview(['e2'], 'rejected');
    await Promise.resolve();
    await Promise.resolve();
    expect(memory.evolvesReview.mock.calls).toEqual([['e2', 'rejected']]);
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
  it('shows inline edit and delete on every row only when the caller handles them', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' })];
    const withActions = renderToStaticMarkup(
      createElement(MemoryRows, {
        t,
        onOpen: () => {},
        onEdit: () => {},
        onDelete: () => {},
        items,
      })
    );
    expect(withActions.match(/data-memory-action="row-edit"/g)).toHaveLength(2);
    expect(withActions.match(/data-memory-action="row-delete"/g)).toHaveLength(2);
    const readOnly = renderToStaticMarkup(
      createElement(MemoryRows, { t, onOpen: () => {}, items })
    );
    expect(readOnly).not.toContain('row-edit');
  });

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
    expect(html).toContain('Retrieved 3 times');
    expect(html).not.toContain('hits');
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
  const section = (overrides: Partial<Parameters<typeof PendingReviewSection>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(PendingReviewSection, {
        t,
        items: [edge],
        selected: new Set<string>(),
        onToggle: () => {},
        onToggleAll: () => {},
        onReview: () => {},
        onOpen: () => {},
        ...overrides,
      })
    );

  it('lists Bot memory writes awaiting approval with target space and redaction note', () => {
    expect(
      renderToStaticMarkup(
        createElement(PendingWritesSection, { t, writes: [], onReview: () => {} })
      )
    ).toBe('');
    const html = renderToStaticMarkup(
      createElement(PendingWritesSection, {
        t,
        onReview: () => {},
        writes: [
          {
            id: 'p1',
            kind: 'capture',
            spaceId: 'global',
            spaceLabel: 'Global',
            originLabel: '成员：Alice',
            title: 'Staging key',
            content: 'api_key=[REDACTED]',
            botId: 'b1',
            chatId: null,
            redacted: true,
            createdAt: '2026-10-05T00:00:00.000Z',
          },
        ],
      })
    );
    expect(html).toContain('Alice');
    expect(html).toContain('Global');
    expect(html).toContain('api_key=[REDACTED]');
    expect(html).toContain('Secrets redacted');
    expect(html).toContain('Approve');
    expect(html).toContain('Reject');
  });

  it('shows both memories by title and summary instead of bare ids', () => {
    const html = section();
    expect(html).toContain('Workflow removed; do not add back');
    expect(html).toContain('The scripted workflow was deleted on purpose');
    expect(html).toContain('Wants a DeepSeek-style workflow');
    expect(html).toContain('User asked for a scripted workflow again');
    // 空间与时间：判断这条矛盾发生在哪、什么时候
    expect(html).toContain('Project A');
    expect(html).toContain('2025-01-03');
    // 不再用 id 前缀当标题
    expect(html).not.toContain('older-id-1234 →');
  });

  it('勾选后才出现批量操作，一次处理所选矛盾', () => {
    const html = section({ selected: new Set(['e1']) });
    expect(html).toContain('1 selected');
    expect(html).toContain('Accept selected');
    expect(html).toContain('Dismiss selected');
    expect(html).toContain('Clear selection');
    // 没勾选时不占地方
    expect(section()).not.toContain('Accept selected');
  });

  it('states what accepting and dismissing actually do', () => {
    const html = section();
    expect(html).toContain('Needs review');
    expect(html).toContain('challenges');
    expect(html).toContain('Contradicts the earlier note');
    expect(html).toContain(
      'Reviewing only records your judgement. Nothing is deleted and no memory is superseded.'
    );
    expect(html).toContain(
      'Accept: recorded as a confirmed contradiction. Both memories stay and stay searchable — you just stop being asked.'
    );
    expect(html).toContain(
      'Dismiss: recorded as not a contradiction. Both memories stay unchanged and you stop being asked.'
    );
    // 拒绝按钮的文案不能暗示删除
    expect(html).toContain('Dismiss');
    expect(html).not.toContain('Delete');
  });

  it('says so when the model recorded no reason', () => {
    const html = section({
      items: [{ ...edge, edge: { ...edge.edge, reason: null } }],
    });
    expect(html).toContain('No reason recorded for this pair.');
  });

  it('explains the empty state instead of leaving a blank block', () => {
    const html = section({ items: [] });
    expect(html).toContain('Needs review');
    expect(html).toContain(
      'Nothing to review. When a new memory contradicts an existing one, the pair shows up here.'
    );
    expect(html).not.toContain('Accept');
  });

  it('warns once the backlog passes the alert threshold', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        review({
          edge: {
            ...edge.edge,
            id: `e${index}`,
            createdAt: `2025-01-0${(index % 9) + 1}T00:00:00.000Z`,
          },
        })
      );
    expect(section({ items: many(PENDING_REVIEW_ALERT) })).not.toContain(
      'contradictions are waiting for review'
    );
    const html = section({ items: many(PENDING_REVIEW_ALERT + 1) });
    expect(html).toContain(
      `${PENDING_REVIEW_ALERT + 1} contradictions are waiting for review. Clear them in bulk so real conflicts do not get buried.`
    );
  });

  it('groups by space only when the list gets long', () => {
    const short = groupPendingReviews([edge, review({ edge: { ...edge.edge, id: 'e2' } })]);
    expect(short).toHaveLength(1);
    expect(short[0].label).toBe('');
    const long = Array.from({ length: PENDING_REVIEW_GROUP_AT + 1 }, (_, index) =>
      review({
        edge: { ...edge.edge, id: `e${index}` },
        older: item({
          id: `o${index}`,
          spaceId: index % 2 === 0 ? 'project-A' : 'global',
          spaceLabel: index % 2 === 0 ? 'Project A' : 'Global',
        }),
      })
    );
    const groups = groupPendingReviews(long);
    expect(groups.map((group) => group.label)).toEqual(['Global', 'Project A']);
    expect(groups.reduce((sum, group) => sum + group.items.length, 0)).toBe(long.length);
    // 组内最新的矛盾在前
    expect(groups[0].items[0].edge.createdAt >= groups[0].items[1].edge.createdAt).toBe(true);
  });
});

describe('scopeFilter', () => {
  const spaces = [
    { id: 'global', kind: 'global' as const },
    { id: 'proj:a', kind: 'project' as const },
    { id: 'proj:b', kind: 'project' as const },
    { id: 'proj:s', kind: 'secretary' as const },
  ];
  it('具体空间优先，只选类别时带上该类别全部空间，未选不过滤', () => {
    expect(scopeFilter('project', 'proj:b', spaces)).toEqual({ spaceId: 'proj:b' });
    expect(scopeFilter('project', null, spaces)).toEqual({ spaceIds: ['proj:a', 'proj:b'] });
    expect(scopeFilter('secretary', null, spaces)).toEqual({ spaceIds: ['proj:s'] });
    expect(scopeFilter('chat', null, spaces)).toEqual({ spaceIds: [] });
    expect(scopeFilter(null, null, spaces)).toEqual({});
  });
});
