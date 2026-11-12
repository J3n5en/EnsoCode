import type { BotChat } from '@shared/types/bot';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloneGroupDialog } from './CloneGroupDialog';

const harness = vi.hoisted(() => ({ cloneChat: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/bots', () => ({
  useBotsStore: (select: (state: unknown) => unknown) => select({ bots: [], chats: [] }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select({ projects: [] }),
}));
vi.mock('@/components/ui/toast', () => ({ addToast: vi.fn() }));
vi.mock('./BotFields', () => ({
  FieldLabel: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('@/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Dialog: Wrap,
    DialogContent: Wrap,
    DialogDescription: Wrap,
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

const chat = {
  id: 'group-1',
  kind: 'group',
  title: 'Team',
  members: [],
  bossBotId: null,
  workspace: { kind: 'member-home' },
  routing: { mode: 'boss', maxHops: 4, maxTurnsPerBot: 2 },
} as unknown as BotChat;

let root: Root;
let container: HTMLElement;
const press = (key: string, isComposing: boolean) =>
  act(async () => {
    const input = container.querySelector('input');
    if (!input) throw new Error('Missing title input');
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { key: { value: key }, isComposing: { value: isComposing } });
    input.dispatchEvent(event);
  });

beforeEach(async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.cloneChat.mockReset().mockReturnValue(new Promise(() => {}));
  Object.assign(window, { electronAPI: { bots: { cloneChat: harness.cloneChat } } });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () =>
    root.render(createElement(CloneGroupDialog, { chat, onOpenChange: vi.fn() }))
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('CloneGroupDialog 群名输入框回车', () => {
  // 真实场景：macOS 中文输入法按回车确认候选词时，keydown 是 key=Enter、isComposing=true
  it('输入法组字中按回车不克隆', async () => {
    await press('Enter', true);
    expect(harness.cloneChat).not.toHaveBeenCalled();
  });

  it('克隆进行中连按回车只克隆一次', async () => {
    await press('Enter', false);
    await press('Enter', false);
    expect(harness.cloneChat).toHaveBeenCalledTimes(1);
  });
});
