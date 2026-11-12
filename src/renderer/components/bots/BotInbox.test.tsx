import { parseHTML } from 'linkedom';
import { act, type ComponentProps, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotInbox } from './BotInbox';

const harness = vi.hoisted(() => ({
  respondAsk: vi.fn(),
  item: {
    kind: 'ask',
    conversationId: 'conv-1',
    chatId: 'chat-1',
    botId: 'bot-1',
    request: { requestId: 'ask-1', question: 'Which branch?' },
  },
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/bots', () => ({
  useBotsStore: (select: (state: unknown) => unknown) =>
    select({
      inbox: [],
      chats: [],
      bots: [],
      delegations: [],
      routines: [],
      setView: () => {},
    }),
}));
vi.mock('@/stores/bots/inbox', () => ({
  inboxSections: () => ({
    pending: [harness.item],
    budgets: [],
    routines: [],
    silences: [],
    interrupted: [],
    blocked: [],
    count: 1,
  }),
}));
vi.mock('@/stores/bots/delegations', () => ({ formatElapsed: () => '' }));
vi.mock('@/stores/memoryReview', () => ({ usePendingMemoryWrites: () => [] }));
vi.mock('./BotAvatar', () => ({ BotAvatar: () => null }));
vi.mock('./DelegationCard', () => ({
  DelegationBadge: () => null,
  failureText: () => '',
  retryDelegation: () => {},
  useNow: () => 0,
}));
vi.mock('./MemoryWriteCard', () => ({ MemoryWriteCard: () => null }));
vi.mock('./RoutineCards', () => ({ RoutineAlertCard: () => null }));
vi.mock('./SessionHistoryDialog', () => ({ SessionHistoryDialog: () => null }));
vi.mock('./SilenceNote', () => ({ QuietFor: () => null }));
vi.mock('./TaskReply', () => ({ replyToTask: () => {}, TaskReply: () => null }));
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
const input = () => {
  const found = container.querySelector('input');
  if (!found) throw new Error('Missing answer input');
  return found;
};
const type = (value: string) =>
  act(async () => {
    input().value = value;
    input().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const press = (key: string, isComposing: boolean) =>
  act(async () => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { key: { value: key }, isComposing: { value: isComposing } });
    input().dispatchEvent(event);
  });

beforeEach(async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.respondAsk.mockReset().mockReturnValue(new Promise(() => {}));
  Object.assign(window, { electronAPI: { agent: { respondAsk: harness.respondAsk } } });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => root.render(createElement(BotInbox)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('BotInbox 提问卡片的自定义回复', () => {
  // 真实场景：macOS 中文输入法按回车确认候选词时，keydown 是 key=Enter、isComposing=true
  it('输入法组字中按回车不发送回复', async () => {
    await type('主干');
    await press('Enter', true);
    expect(harness.respondAsk).not.toHaveBeenCalled();
  });

  it('回复发送中连按回车只发送一次', async () => {
    await type('main');
    await press('Enter', false);
    await press('Enter', false);
    expect(harness.respondAsk.mock.calls).toEqual([['conv-1', 'ask-1', 'main']]);
  });
});
