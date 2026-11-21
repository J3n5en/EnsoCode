import type { SecretaryBoard, SecretaryCard } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, params?: Record<string, string | number>) =>
  params
    ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? ''))
    : `[${key}]`;

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: translate }) }));
vi.mock('@/components/ui/preview-card', () => ({
  PreviewCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  PreviewCardTrigger: ({ children }: { children: ReactNode }) => (
    <span data-enso="trigger">{children}</span>
  ),
  PreviewCardPopup: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick: (event: { stopPropagation: () => void }) => void;
  }) => (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 测试替身
    <div data-enso="popup" onClick={onClick}>
      {children}
    </div>
  ),
}));

import {
  runningByOrigin,
  SecretaryDispatchBadge,
  SecretaryRunningOriginsCard,
} from './SecretaryRunningOrigins';

const session = (
  conversationId: string,
  secretaryConversationId: string,
  over: Record<string, unknown> = {}
): SecretaryCard => ({
  kind: 'session',
  conversationId,
  projectId: 'p1',
  projectName: 'enso',
  title: `活 ${conversationId}`,
  state: 'running',
  startedAt: 1,
  stateSince: 1,
  secretaryConversationId,
  ...over,
});

const pending = (id: string, secretaryConversationId: string): SecretaryCard => ({
  kind: 'pending',
  projectName: 'enso',
  pending: {
    id,
    projectId: 'p1',
    secretaryConversationId,
    createdAt: 1,
    updatedAt: 1,
    status: 'waiting',
    after: ['c1'],
    draft: { projectId: 'p1', prompt: 'x', title: '等依赖', worktree: false },
  },
});

const board = (over: Partial<SecretaryBoard>): SecretaryBoard => ({
  needsYou: [],
  running: [],
  done: [],
  todos: [],
  ...over,
});

const knownIds = (...ids: string[]) => {
  const set = new Set(ids);
  return (id: string) => set.has(id);
};

describe('runningByOrigin', () => {
  it('按发起会话分组计数，等依赖的派发也算在跑', () => {
    const result = runningByOrigin(
      board({ running: [session('c1', 's1'), session('c2', 's2'), pending('p1', 's1')] }),
      knownIds('s1', 's2')
    );
    expect(result.counts).toEqual({ s1: 2, s2: 1 });
    expect(
      result.groups.map((group) => [group.secretaryConversationId, group.cards.length])
    ).toEqual([
      ['s1', 2],
      ['s2', 1],
    ]);
  });

  it('终态（含遗留后台任务）与等你处理的不算在跑', () => {
    const result = runningByOrigin(
      board({
        running: [session('c1', 's1')],
        needsYou: [session('c2', 's1', { state: 'waiting' })],
        done: [
          session('c3', 's2', {
            state: 'idle',
            result: 'goal-complete',
            leftoverTasks: { count: 1 },
          }) as SecretaryBoard['done'][number],
        ],
      }),
      knownIds('s1', 's2')
    );
    expect(result.counts).toEqual({ s1: 1 });
    expect(result.counts.s2).toBeUndefined();
  });

  it('没有发起会话或发起会话已不在的记录归到未知来源，不计到任何会话', () => {
    const legacy = session('c1', undefined as unknown as string);
    const blank = session('c2', '');
    const gone = session('c3', 'deleted');
    const result = runningByOrigin(
      board({ running: [legacy, session('c4', 's1'), blank, gone] }),
      knownIds('s1')
    );
    expect(result.counts).toEqual({ s1: 1 });
    expect(result.groups.at(-1)).toEqual({
      secretaryConversationId: null,
      cards: [legacy, blank, gone],
    });
  });
});

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('SecretaryDispatchBadge', () => {
  it('没有在跑的派发时不显示，有就显示件数', async () => {
    await act(async () => root.render(<SecretaryDispatchBadge count={undefined} />));
    expect(container.querySelector('[data-enso="secretary-dispatch-running"]')).toBeNull();
    await act(async () => root.render(<SecretaryDispatchBadge count={2} />));
    const badge = container.querySelector('[data-enso="secretary-dispatch-running"]');
    expect(badge?.textContent).toBe('2');
    expect(badge?.getAttribute('title')).toBe('2 dispatched tasks running');
  });
});

describe('SecretaryRunningOriginsCard', () => {
  it('列出每件属于哪条会话，点会话跳过去且不冒泡到头部；未知来源不可点', async () => {
    const onSelect = vi.fn();
    const onOuter = vi.fn();
    const { groups } = runningByOrigin(
      board({ running: [session('c1', 's1'), session('c2', 'gone')] }),
      knownIds('s1')
    );
    await act(async () =>
      root.render(
        // biome-ignore lint/a11y/useKeyWithClickEvents: 测试替身
        <div onClick={onOuter}>
          <SecretaryRunningOriginsCard
            label="2 running"
            groups={groups}
            titleOf={(id) => (id === 's1' ? '多秘书功能' : undefined)}
            onSelect={onSelect}
          />
        </div>
      )
    );
    const rows = [...container.querySelectorAll('[data-enso="secretary-running-origin"]')];
    expect(rows.map((row) => row.textContent)).toEqual([
      '多秘书功能1活 c1',
      '[Unknown source]1活 c2',
    ]);
    expect(rows[1]?.firstElementChild?.tagName).toBe('DIV');
    const jump = rows[0]?.firstElementChild as unknown as HTMLElement;
    act(() => jump.click());
    expect(onSelect).toHaveBeenCalledWith('s1');
    expect(onOuter).not.toHaveBeenCalled();
  });

  it('点在跑的某件弹窗看它，不跳转，并记下所属秘书会话', async () => {
    const { useSessionPeek } = await import('@/stores/sessionPeek');
    useSessionPeek.setState({ conversationId: null, from: null });
    const onSelect = vi.fn();
    const { groups } = runningByOrigin(board({ running: [session('c1', 's1')] }), knownIds('s1'));
    await act(async () =>
      root.render(
        <SecretaryRunningOriginsCard
          label="1 running"
          groups={groups}
          titleOf={() => '多秘书功能'}
          onSelect={onSelect}
        />
      )
    );
    const card = container.querySelector(
      '[data-enso="secretary-running-origin-card"]'
    ) as unknown as HTMLElement;
    expect(card.textContent).toBe('活 c1');
    act(() => card.click());
    expect(useSessionPeek.getState().conversationId).toBe('c1');
    // 侧栏不在秘书会话里：弹窗记下这件属于哪条秘书会话，「打开会话」后返回到它
    expect(useSessionPeek.getState().from).toBe('s1');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
