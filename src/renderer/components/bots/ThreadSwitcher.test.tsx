import type { BotChat } from '@shared/types/bot';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadSwitcher } from './ThreadSwitcher';

const harness = vi.hoisted(() => ({ renameThread: vi.fn() }));
const group = {
  id: 'group-1',
  kind: 'group',
  title: 'Team',
  members: [],
  createdAt: 1,
} as unknown as BotChat;
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/bots', () => {
  const state = { chats: [], sessions: {}, timelines: {}, queue: {}, reads: {}, bots: [] };
  return {
    useBotsStore: Object.assign((select: (s: unknown) => unknown) => select(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/stores/bots/selectors', () => ({
  chatSummary: () => ({ preview: '', activityAt: 0, running: false, marker: 0, key: '' }),
}));
vi.mock('@/stores/bots/unread', () => ({ isUnread: () => false }));
vi.mock('@/components/ui/toast', () => ({ addToast: vi.fn() }));
vi.mock('@/components/chat/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/ui/menu', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Menu: Wrap,
    MenuTrigger: Wrap,
    MenuPopup: Wrap,
    MenuGroup: Wrap,
    MenuGroupLabel: Wrap,
    MenuSeparator: () => null,
    MenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
      createElement('button', { type: 'button', onClick }, children),
  };
});
vi.mock('@/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Dialog: Wrap,
    DialogContent: Wrap,
    DialogFooter: Wrap,
    DialogHeader: Wrap,
    DialogPanel: Wrap,
    DialogTitle: Wrap,
  };
});
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<'button'> & {
    size?: string;
    variant?: string;
  }) => createElement('button', { type: 'button', ...props }, children),
}));
vi.mock('@/components/ui/input', () => ({
  Input: ({ onChange, ...props }: ComponentProps<'input'>) =>
    createElement('input', { ...props, onInput: onChange }),
}));

let root: Root;
let container: HTMLElement;
const press = (key: string, isComposing: boolean) =>
  act(async () => {
    const input = container.querySelector('input');
    if (!input) throw new Error('Missing rename input');
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { key: { value: key }, isComposing: { value: isComposing } });
    input.dispatchEvent(event);
  });

beforeEach(async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.renameThread.mockReset().mockReturnValue(new Promise(() => {}));
  Object.assign(window, { electronAPI: { bots: { renameThread: harness.renameThread } } });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => root.render(createElement(ThreadSwitcher, { group, thread: group })));
  const rename = [...container.querySelectorAll('button')].find(
    (el) => el.textContent === 'Rename topic'
  );
  if (!rename) throw new Error('Missing Rename topic');
  await act(async () => rename.click());
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('ThreadSwitcher 重命名话题', () => {
  // 真实场景：macOS 中文输入法按回车确认候选词时，keydown 是 key=Enter、isComposing=true
  it('输入法组字中按回车不保存', async () => {
    await press('Enter', true);
    expect(harness.renameThread).not.toHaveBeenCalled();
  });

  it('组字结束后按回车保存', async () => {
    await press('Enter', false);
    expect(harness.renameThread).toHaveBeenCalledWith('group-1', 'Main topic');
  });
});
