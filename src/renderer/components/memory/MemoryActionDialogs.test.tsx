import type { MemoryDeletionImpact, MemoryDetail } from '@shared/memory/dto';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// base-ui 弹层依赖真实布局与 portal；这里只验证数据流，弹窗换成打开即渲染的薄壳
vi.mock('@/components/ui/dialog', () => {
  const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogClose: ({ children }: { children?: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    DialogContent: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogPanel: ({ children, ...rest }: { children?: ReactNode }) => (
      <div {...rest}>{children}</div>
    ),
    DialogTitle: pass,
  };
});
// base-ui 的输入控件在 linkedom 里收不到 input 事件，换成原生元素
// base-ui 的输入控件在 linkedom 里收不到 change，换成原生元素并用 input 事件驱动
vi.mock('@/components/ui/input', () => ({
  Input: ({ size: _size, onChange, ...props }: ComponentProps<'input'> & { size?: unknown }) =>
    createElement('input', { ...props, onInput: onChange }),
}));
vi.mock('@/components/ui/textarea', () => ({
  Textarea: ({ onChange, ...props }: ComponentProps<'textarea'>) =>
    createElement('textarea', { ...props, onInput: onChange }),
}));
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '') : key,
  }),
}));

const {
  deletionImpactLines,
  draftToPatch,
  MemoryDeleteDialog,
  MemoryEditDialog,
  MemoryRowActions,
} = await import('./MemoryActionDialogs');

const t = (key: string, params?: Record<string, string>) =>
  params ? key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '') : key;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const noImpact: MemoryDeletionImpact = {
  deleted: [{ id: 'm1', title: 'T', spaceId: 'global', role: 'target' }],
  bridges: [],
  relations: [],
  crystalsUpdated: [],
  crystalsDemoted: [],
  releasedSources: 0,
};

const detail = (over: Partial<MemoryDetail> = {}): MemoryDetail => ({
  id: 'm1',
  title: 'Deploy window',
  contentSummary: 'deploy on tuesday',
  content: 'deploy on tuesday',
  unitType: 'fact',
  spaceId: 'global',
  spaceLabel: 'Global',
  importance: 0.6,
  isCrystal: false,
  isLatest: true,
  lifecycleState: 'active',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  appearances: 0,
  lastHitAt: null,
  hitCount: 0,
  archiveCandidateAt: null,
  eventStart: null,
  eventEnd: null,
  temporalPrecision: null,
  embeddingModel: null,
  evolves: [],
  entityNames: [],
  crystalSources: [],
  ...over,
});

let root: Root;
let container: HTMLElement;
let memory: Record<string, ReturnType<typeof vi.fn>>;

const q = (selector: string) => container.querySelector(selector) as HTMLElement | null;
const click = (el: HTMLElement | null) =>
  act(() => {
    el?.click();
  });
function typeInto(el: HTMLElement | null, value: string) {
  act(() => {
    const input = el as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // 类型下拉（base-ui Select）渲染时会用到这两个 DOM 构造器
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('Element', dom.window.Element);
  memory = {
    detail: vi.fn(async () => detail()),
    update: vi.fn(async () => ({ ok: true })),
    deletePreview: vi.fn(async () => noImpact),
    delete: vi.fn(async () => ({ ok: true })),
  };
  (dom.window as unknown as Record<string, unknown>).electronAPI = { memory };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('draftToPatch', () => {
  const draft = { title: 'T', content: 'body', unitType: 'fact' as const, importance: '0.8' };
  it('带上标题、正文、类型和数值重要度', () => {
    expect(draftToPatch(draft)).toEqual({
      patch: { title: 'T', content: 'body', unitType: 'fact', importance: 0.8 },
    });
  });
  it.each(['', ' ', '1.5', '-0.1', 'abc'])('重要度 %j 不在 0–1 时拒绝', (importance) => {
    expect(draftToPatch({ ...draft, importance })).toEqual({
      error: 'Importance must be between 0 and 1.',
    });
  });
  it('正文为空时拒绝', () => {
    expect(draftToPatch({ ...draft, content: '  ' })).toEqual({
      error: 'Content cannot be empty.',
    });
  });
});

describe('MemoryRowActions', () => {
  it('常驻编辑与删除两个按钮，各自带上这一行的 id', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    await act(async () => {
      root.render(<MemoryRowActions id="m9" onEdit={onEdit} onDelete={onDelete} />);
    });
    click(q('[data-memory-action="row-edit"]'));
    click(q('[data-memory-action="row-delete"]'));
    expect(onEdit).toHaveBeenCalledWith('m9');
    expect(onDelete).toHaveBeenCalledWith('m9');
    expect(q('[data-memory-action="row-delete"]')?.getAttribute('aria-label')).toBe(
      'Delete permanently'
    );
  });
});

describe('MemoryDeleteDialog', () => {
  it('先拿影响预览，确认前不删；确认后逐条删除并回调', async () => {
    const preview = deferred<MemoryDeletionImpact | null>();
    memory.deletePreview.mockReturnValueOnce(preview.promise);
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    const ids = ['m1', 'm2'];
    await act(async () => {
      root.render(<MemoryDeleteDialog ids={ids} onClose={onClose} onDeleted={onDeleted} />);
    });
    expect(memory.deletePreview).toHaveBeenCalledWith(['m1', 'm2']);
    const confirm = () => q('[data-memory-action="confirm-delete"]') as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    expect(q('[data-memory-delete-impact]')?.textContent).toContain('Checking what this affects');

    await act(async () => preview.resolve(noImpact));
    expect(q('[data-memory-delete-impact]')?.textContent).toContain(
      'No other memories are affected.'
    );
    expect(confirm().disabled).toBe(false);
    expect(memory.delete).not.toHaveBeenCalled();

    await act(async () => {
      confirm().click();
    });
    expect(memory.delete.mock.calls).toEqual([['m1'], ['m2']]);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onDeleted).toHaveBeenCalledWith(ids);
  });

  it('找不到记忆时不给确认', async () => {
    memory.deletePreview.mockResolvedValueOnce(null);
    await act(async () => {
      root.render(<MemoryDeleteDialog ids={['gone']} onClose={() => {}} />);
    });
    expect(q('[data-memory-delete-impact]')?.textContent).toContain('Memory not found.');
    expect((q('[data-memory-action="confirm-delete"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ids 为空时不打开也不请求预览', async () => {
    await act(async () => {
      root.render(<MemoryDeleteDialog ids={null} onClose={() => {}} />);
    });
    expect(q('[data-testid="dialog"]')).toBeNull();
    expect(memory.deletePreview).not.toHaveBeenCalled();
  });
});

describe('MemoryEditDialog', () => {
  it('拉详情填表，保存时带上四个字段并回调', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MemoryEditDialog memoryId="m1" onClose={onClose} onSaved={onSaved} />);
    });
    expect(memory.detail).toHaveBeenCalledWith('m1');
    expect((q('[data-memory-field="title"]') as HTMLInputElement).value).toBe('Deploy window');
    typeInto(q('[data-memory-field="content"]'), 'release on friday');
    typeInto(q('[data-memory-field="importance"]'), '0.9');
    await act(async () => {
      q('[data-memory-action="save"]')?.click();
    });
    expect(memory.update).toHaveBeenCalledWith('m1', {
      title: 'Deploy window',
      content: 'release on friday',
      unitType: 'fact',
      importance: 0.9,
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith('m1');
  });

  it('重要度不合法时不提交，留在表单里提示', async () => {
    await act(async () => {
      root.render(<MemoryEditDialog memoryId="m1" onClose={() => {}} />);
    });
    typeInto(q('[data-memory-field="importance"]'), '3');
    await act(async () => {
      q('[data-memory-action="save"]')?.click();
    });
    expect(memory.update).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Importance must be between 0 and 1.');
  });

  it('Main 拒绝时显示原因，不关闭', async () => {
    memory.update.mockResolvedValueOnce({ ok: false, error: 'blocked: prompt injection' });
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MemoryEditDialog memoryId="m1" onClose={onClose} />);
    });
    await act(async () => {
      q('[data-memory-action="save"]')?.click();
    });
    expect(container.textContent).toContain('blocked: prompt injection');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('记忆已不存在时直接关闭', async () => {
    memory.detail.mockResolvedValueOnce(null);
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MemoryEditDialog memoryId="gone" onClose={onClose} />);
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(q('[data-testid="dialog"]')).toBeNull();
  });
});

describe('deletionImpactLines', () => {
  const empty = {
    deleted: [{ id: 'm1', title: 'T', spaceId: 'global', role: 'target' as const }],
    bridges: [],
    relations: [],
    crystalsUpdated: [],
    crystalsDemoted: [],
    releasedSources: 0,
  };
  it('没有连带影响时明确说不影响其他记忆', () => {
    expect(deletionImpactLines(empty, t)).toEqual(['No other memories are affected.']);
  });
  it('逐条说明历史版本、版本链、关系和结晶的处理', () => {
    const lines = deletionImpactLines(
      {
        ...empty,
        deleted: [...empty.deleted, { id: 'm0', title: 'Old', spaceId: 'global', role: 'history' }],
        bridges: [{ olderId: 'a', newerId: 'b' }],
        relations: [{ memoryId: 'r', title: 'Rel', relation: 'enriches' }],
        crystalsUpdated: [{ id: 'c1', title: 'C1', remaining: 3 }],
        crystalsDemoted: [{ id: 'c2', title: 'C2', remaining: 2 }],
        releasedSources: 4,
      },
      t
    );
    expect(lines).toEqual([
      'Also deletes 1 older versions it replaced: “Old”',
      'The older and newer versions around it are linked directly, so the history stays continuous.',
      'Removes the relation links to “Rel”; those memories are kept.',
      'Crystal “C1” loses this source and keeps 3 sources.',
      'Crystal “C2” would be left with 2 sources, so it becomes a normal memory. Its content is kept.',
      'This is a crystal: its 4 source memories are kept, only the links are removed.',
    ]);
  });
});
