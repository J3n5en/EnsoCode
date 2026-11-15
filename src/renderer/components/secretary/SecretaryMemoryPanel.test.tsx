import type { MemoryListItem, MemoryListQuery } from '@shared/memory/dto';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  edit: null as string | null,
  remove: null as readonly string[] | null,
  onDeleted: null as ((ids: readonly string[]) => void) | null,
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '') : key,
    locale: 'zh',
  }),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (selector: (state: unknown) => unknown) =>
    selector({ secretary: { projectId: 'sec', profile: { name: '小安' } } }),
}));
// 弹窗本身由 MemoryActionDialogs.test 覆盖；这里只看面板把哪条交给了哪个弹窗
vi.mock('@/components/memory/MemoryActionDialogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/memory/MemoryActionDialogs')>();
  return {
    ...actual,
    MemoryEditDialog: ({ memoryId }: { memoryId: string | null }) => {
      h.edit = memoryId;
      return null;
    },
    MemoryDeleteDialog: ({
      ids,
      onDeleted,
    }: {
      ids: readonly string[] | null;
      onDeleted: (ids: readonly string[]) => void;
    }) => {
      h.remove = ids;
      h.onDeleted = onDeleted;
      return null;
    },
  };
});

const { SecretaryMemoryPanel } = await import('./SecretaryMemoryPanel');

const item = (id: string, spaceId: string): MemoryListItem => ({
  id,
  title: `title ${id}`,
  contentSummary: `summary ${id}`,
  unitType: 'fact',
  spaceId,
  spaceLabel: spaceId === 'proj:sec' ? '秘书' : 'enso-code',
  importance: 0.5,
  isCrystal: false,
  isLatest: true,
  lifecycleState: 'active',
  createdAt: '2025-01-01T00:00:00.000Z',
  lastHitAt: null,
  hitCount: 0,
  archiveCandidateAt: null,
  updatedAt: '2025-01-01T00:00:00.000Z',
  appearances: 0,
});

let root: Root;
let container: HTMLElement;
let memory: Record<string, ReturnType<typeof vi.fn>>;

const rows = () => [...container.querySelectorAll('[data-enso="secretary-memory-row"]')];
const inRow = (id: string, selector: string) =>
  container.querySelector(`[data-memory-id="${id}"] ${selector}`) as HTMLElement | null;

beforeEach(async () => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.edit = null;
  h.remove = null;
  memory = {
    list: vi.fn(async (query: MemoryListQuery) => ({
      items: query.spaceId
        ? [item('own1', 'proj:sec'), item('own2', 'proj:sec')]
        : [item('own1', 'proj:sec'), item('proj1', 'proj:p1')],
      total: 2,
    })),
    detail: vi.fn(async (id: string) => ({ ...item(id, 'proj:sec'), content: `full ${id}` })),
    archive: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
    update: vi.fn(async () => ({ ok: true })),
    onChanged: vi.fn(() => () => {}),
  };
  (dom.window as unknown as Record<string, unknown>).electronAPI = { memory };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root.render(<SecretaryMemoryPanel />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('SecretaryMemoryPanel 行内操作', () => {
  it('每条记忆（秘书自己的和项目来的）都直接带编辑与删除，不用先点开，平时叠在悬停蒙版里', () => {
    expect(rows().map((row) => row.getAttribute('data-memory-id'))).toEqual([
      'own1',
      'own2',
      'proj1',
    ]);
    for (const id of ['own1', 'own2', 'proj1']) {
      const layer = inRow(id, '[data-slot="hover-actions"]');
      expect(layer?.className).toContain('absolute');
      expect(layer?.querySelector('[data-memory-action="row-edit"]')).not.toBeNull();
      expect(layer?.querySelector('[data-memory-action="row-delete"]')).not.toBeNull();
      expect(layer?.parentElement?.className).toContain('group/row');
    }
    expect(container.querySelector('[data-enso="secretary-memory-detail"]')).toBeNull();
  });

  it('正文占满整行，时间跟在标题后面，不为右侧操作留列', () => {
    const open = inRow('own1', '[data-enso="secretary-memory-open"]');
    expect(open?.className).toContain('w-full');
    const summary = open?.querySelector('.line-clamp-2');
    expect(summary?.parentElement).toBe(open);
    expect(summary?.textContent).toContain('summary own1');
  });

  it('删除交给确认弹窗，点了不直接删', () => {
    act(() => {
      inRow('own2', '[data-memory-action="row-delete"]')?.click();
    });
    expect(h.remove).toEqual(['own2']);
    expect(memory.delete).not.toHaveBeenCalled();
  });

  it('编辑交给编辑弹窗，带上这一行的 id', () => {
    act(() => {
      inRow('proj1', '[data-memory-action="row-edit"]')?.click();
    });
    expect(h.edit).toBe('proj1');
    expect(memory.update).not.toHaveBeenCalled();
  });

  it('点开一行在它下面展开全文，删掉这条后收起', async () => {
    await act(async () => {
      inRow('own1', '[data-enso="secretary-memory-open"]')?.click();
    });
    const pane = inRow('own1', '[data-enso="secretary-memory-detail"]');
    expect(pane?.textContent).toContain('full own1');
    expect(pane?.textContent).not.toContain('Delete');
    act(() => h.onDeleted?.(['own1']));
    expect(container.querySelector('[data-enso="secretary-memory-detail"]')).toBeNull();
  });
});
