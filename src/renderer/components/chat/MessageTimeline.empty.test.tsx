import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageTimeline } from './MessageTimeline';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => false }));
vi.mock('@/stores/sessions/timeline', () => ({
  historyPageChrome: () => 'none',
  shouldPrefetchOlderHistory: () => false,
}));
vi.mock('@/components/secretary/useSecretaryFace', () => ({ useSecretaryFace: () => null }));
vi.mock('@/components/secretary/SecretaryAvatar', () => ({ SecretaryAvatar: () => null }));
vi.mock('@/components/ui/button', () => ({
  Button: (props: Record<string, unknown>) => createElement('button', { type: 'button', ...props }),
}));
vi.mock('react-virtuoso', () => ({ Virtuoso: () => null }));
vi.mock('./chatHost', () => ({ useChatHost: () => null }));
vi.mock('./NavRail', () => ({ NavRail: () => null }));
vi.mock('./WelcomeSuggestions', () => ({
  WelcomeSuggestions: (props: { variant?: string }) =>
    createElement('div', { 'data-variant': props.variant ?? 'project' }),
}));
vi.mock('./useFoldedTimeline', () => ({ useFoldedTimeline: (items: unknown) => items }));
vi.mock('./TimelineRow', () => ({
  TimelineRow: () => null,
  ReplyHeader: () => null,
  RetryTurnButton: () => null,
  isCompactRow: () => false,
  isToolStepRow: () => false,
}));

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function renderEmpty(props: Record<string, unknown> = {}) {
  await act(async () =>
    root.render(
      createElement(MessageTimeline, {
        items: [],
        busy: false,
        running: false,
        emptyTitle: 'MyProject',
        onSuggestion: () => {},
        virtualize: false,
        ...props,
      })
    )
  );
}

describe('MessageTimeline 空会话状态', () => {
  it('默认副标题是 agent 语境，建议卡片是项目语境', async () => {
    await renderEmpty();
    expect(container.textContent).toContain('Ask the agent…');
    expect(container.textContent).not.toContain('Tell the secretary what to take care of…');
    expect(container.querySelector('[data-variant="project"]')).toBeTruthy();
    expect(container.querySelector('[data-variant="secretary"]')).toBeNull();
    expect(container.textContent).toContain('MyProject');
  });

  it('secretary 变体：副标题和建议卡片换成秘书语境，标题是秘书名', async () => {
    await renderEmpty({ emptyVariant: 'secretary', emptyTitle: '爱酱' });
    expect(container.textContent).toContain('Tell the secretary what to take care of…');
    expect(container.textContent).not.toContain('Ask the agent…');
    expect(container.querySelector('[data-variant="secretary"]')).toBeTruthy();
    expect(container.textContent).toContain('爱酱');
    expect(container.textContent).not.toContain('MyProject');
  });

  it('显式传的 emptyDescription 优先于变体默认', async () => {
    await renderEmpty({ emptyVariant: 'secretary', emptyDescription: 'custom line' });
    expect(container.textContent).toContain('custom line');
    expect(container.textContent).not.toContain('Tell the secretary what to take care of…');
  });

  it('不传 onSuggestion 就不出建议卡片', async () => {
    await act(async () =>
      root.render(
        createElement(MessageTimeline, {
          items: [],
          busy: false,
          running: false,
          emptyTitle: '爱酱',
          emptyVariant: 'secretary',
          virtualize: false,
        })
      )
    );
    expect(container.querySelector('[data-variant]')).toBeNull();
  });
});
