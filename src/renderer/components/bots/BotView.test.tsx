import { parseHTML } from 'linkedom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotView } from './BotView';
import type { GoalPick } from './GoalOnboarding';

const mocks = vi.hoisted(() => ({
  openDirect: vi.fn(),
  seedBotDraft: vi.fn(),
  onPick: undefined as undefined | ((pick: GoalPick) => Promise<void>),
  newMember: false,
  newTeam: false,
}));
vi.mock('@/stores/bots', () => {
  const state = {
    bots: [{ id: 'bot-1' }],
    chats: [],
    loaded: true,
    view: null,
    setView: vi.fn(),
    openDirect: mocks.openDirect,
  };
  return {
    useBotPendingCount: () => 0,
    useBotsStore: Object.assign((select: (state: unknown) => unknown) => select(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/app/WindowChrome', () => ({ useWindowChromeKind: () => 'mac' }));
vi.mock('./BotComposer', () => ({ seedBotDraft: mocks.seedBotDraft }));
vi.mock('./BotChatView', () => ({ BotChatView: () => null }));
vi.mock('./BotInbox', () => ({ BotInbox: () => null }));
vi.mock('./BotSearchDialog', () => ({ BotSearchButton: () => null, BotSearchDialog: () => null }));
vi.mock('./BotSidebar', () => ({ BotSidebar: () => null, CountBadge: () => null }));
vi.mock('./NewGroupDialog', () => ({ NewGroupDialog: () => null }));
vi.mock('./NewBotDialog', () => ({
  NewBotDialog: ({ open }: { open: boolean }) => {
    mocks.newMember = open;
    return null;
  },
}));
vi.mock('./NewTeamDialog', () => ({
  NewTeamDialog: ({ open }: { open: boolean }) => {
    mocks.newTeam = open;
    return null;
  },
}));
vi.mock('./GoalOnboarding', () => ({
  GoalOnboarding: ({ onPick }: { onPick: (pick: GoalPick) => Promise<void> }) => {
    mocks.onPick = onPick;
    return null;
  },
}));
vi.mock('@/components/ui/dialog', () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement('div', null, children);
  return {
    Dialog: wrapper,
    DialogContent: wrapper,
    DialogDescription: wrapper,
    DialogHeader: wrapper,
    DialogPanel: wrapper,
    DialogTitle: wrapper,
  };
});

let root: Root;
describe('BotView goal handoff', () => {
  beforeEach(async () => {
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.openDirect.mockReset().mockResolvedValue('direct-1');
    mocks.seedBotDraft.mockReset();
    root = createRoot(window.document.getElementById('root') as unknown as HTMLElement);
    await act(async () =>
      root.render(
        createElement(BotView, {
          sidebarWidth: 200,
          collapsed: true,
          onToggleCollapse: () => {},
          onResize: () => {},
        })
      )
    );
    await act(async () =>
      window.document.querySelector<HTMLButtonElement>('button[title="Start from a goal"]')?.click()
    );
    expect(mocks.onPick).toBeTypeOf('function');
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  it('opens the existing direct chat before seeding only its draft, without creating a member or team', async () => {
    let resolve: (chatId: string) => void = () => {};
    mocks.openDirect.mockImplementation(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        })
    );
    const result = mocks.onPick?.({ botId: 'bot-1', firstMessage: ' Draft only ' });
    expect(mocks.openDirect).toHaveBeenCalledWith('bot-1');
    expect(mocks.seedBotDraft).not.toHaveBeenCalled();
    await act(async () => {
      resolve('direct-1');
      await result;
    });
    expect(mocks.seedBotDraft).toHaveBeenCalledWith('direct-1', 'Draft only');
    expect(mocks.newMember).toBe(false);
    expect(mocks.newTeam).toBe(false);
  });
  it('does not seed a draft when opening the chat fails', async () => {
    mocks.openDirect.mockResolvedValue(null);
    await expect(mocks.onPick?.({ botId: 'bot-1', firstMessage: 'Draft' })).rejects.toThrow();
    expect(mocks.seedBotDraft).not.toHaveBeenCalled();
  });
  it('opens the original new-member dialog for create-new-instead', async () => {
    await act(async () => {
      await mocks.onPick?.({ firstMessage: 'Draft' });
    });
    expect(mocks.newMember).toBe(true);
    expect(mocks.newTeam).toBe(false);
    expect(mocks.openDirect).not.toHaveBeenCalled();
    expect(mocks.seedBotDraft).not.toHaveBeenCalled();
  });
});
