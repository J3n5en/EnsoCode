import type { ChildRunSummary } from '@shared/types/agent';
import { parseHTML } from 'linkedom';
import { act, createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildRunsButton } from './ChildRunsButton';

const listChildRuns = vi.hoisted(() => vi.fn());
const readChildRun = vi.hoisted(() => vi.fn());
const selectTab = vi.hoisted(() => vi.fn());

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: Object.assign(() => ({}), { getState: () => ({ selectTab }) }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: { agentTypes: { id: string; name: string }[] }) => unknown) =>
    select({
      agentTypes: [{ id: 'ecc3cc9e-f9f5-54b3-bbd2-0b8dd0d0c654', name: 'Poteto' }],
    }),
}));
vi.mock('@/components/ui/popover', () => {
  const PopoverState = createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(
    null
  );
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => {
      const [inner, setInner] = useState(false);
      const actual = open ?? inner;
      const setOpen = (next: boolean) => {
        setInner(next);
        onOpenChange?.(next);
      };
      return (
        <PopoverState.Provider value={{ open: actual, setOpen }}>{children}</PopoverState.Provider>
      );
    },
    PopoverTrigger: ({
      children,
      ...props
    }: React.ComponentProps<'button'> & { children?: ReactNode }) => {
      const state = useContext(PopoverState);
      return (
        <button type="button" {...props} onClick={() => state?.setOpen(!state.open)}>
          {children}
        </button>
      );
    },
    PopoverPopup: ({ children }: { children: ReactNode }) =>
      useContext(PopoverState)?.open ? <div>{children}</div> : null,
  };
});
vi.mock('@/components/bots/SessionHistoryDialog', () => ({
  SessionHistoryDialog: ({
    conversationId,
    read,
    botSession,
  }: {
    conversationId: string | null;
    read?: (beforeIndex?: number) => Promise<unknown>;
    botSession?: boolean;
  }) => {
    useEffect(() => {
      if (conversationId && read) void read();
    }, [conversationId, read]);
    return conversationId ? (
      <div data-history={conversationId} data-bot={String(botSession)} />
    ) : null;
  },
}));

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = `${PARENT}::cw-ended`;

let container: HTMLElement;
let root: Root;

const ended: ChildRunSummary = {
  childId: CHILD,
  name: 'Scout',
  agentType: 'builtin:scout',
  startedAt: Date.now() - 60_000,
  live: false,
  available: true,
};

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, {
    electronAPI: { agent: { listChildRuns, readChildRun } },
  });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  listChildRuns.mockReset();
  readChildRun.mockReset();
  selectTab.mockReset();
  readChildRun.mockResolvedValue({ ok: true, messages: [], baseIndex: 0 });
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

async function render(items: ChildRunSummary[]) {
  listChildRuns.mockResolvedValue({ ok: true, items });
  await act(async () => {
    root.render(<ChildRunsButton parentId={PARENT} coworkerIds={[]} />);
  });
  await act(async () => {
    await listChildRuns.mock.results.at(-1)?.value;
  });
}

describe('ChildRunsButton', () => {
  it('没有子代理记录时不渲染按钮', async () => {
    await render([]);
    expect(container.querySelector('[aria-label="Subagent history"]')).toBeNull();
    expect(listChildRuns).toHaveBeenCalledWith(PARENT);
  });

  it('按钮上显示记录数量', async () => {
    await render([ended, { ...ended, childId: `${PARENT}::cw-second`, name: 'Worker' }]);
    const trigger = container.querySelector('[aria-label="Subagent history"]');
    expect(trigger?.textContent).toBe('2');
  });

  it('点已结束的记录用父会话和 childId 读取', async () => {
    await render([ended]);
    const trigger = container.querySelector('[aria-label="Subagent history"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      (trigger as HTMLButtonElement).click();
    });
    const row = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Scout')
    );
    expect(row).toBeTruthy();
    await act(async () => {
      row?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(readChildRun).toHaveBeenCalledWith(PARENT, CHILD, undefined);
    expect(container.querySelector('[data-history]')?.getAttribute('data-history')).toBe(CHILD);
    expect(container.querySelector('[data-history]')?.getAttribute('data-bot')).toBe('false');
    expect(selectTab).not.toHaveBeenCalled();
  });

  it('行上显示任务标题；没有标题时去掉哈希，自定义类型显示配置名', async () => {
    await render([
      {
        ...ended,
        name: 'exp-invite-0cd21319',
        title: '探测邀请接口',
        agentType: 'custom:ecc3cc9e-f9f5-54b3-bbd2-0b8dd0d0c654',
      },
      {
        ...ended,
        childId: `${PARENT}::cw-sqli`,
        name: 'exp-sqli3-371654bd',
        agentType: 'builtin:scout',
      },
    ]);
    const trigger = container.querySelector('[aria-label="Subagent history"]');
    await act(async () => {
      (trigger as HTMLButtonElement).click();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('探测邀请接口');
    expect(text).not.toContain('exp-invite-0cd21319');
    expect(text).toContain('exp-sqli3');
    expect(text).not.toContain('exp-sqli3-371654bd');
    expect(text).toContain('Poteto');
    expect(text).not.toContain('custom');
    expect(text).toContain('scout');
  });
});
