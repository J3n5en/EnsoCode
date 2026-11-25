import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WelcomeSuggestions } from './WelcomeSuggestions';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const titles = () =>
  [...container.querySelectorAll('[data-slot="welcome-suggestion"] .font-medium')].map(
    (el) => el.textContent
  );

describe('WelcomeSuggestions', () => {
  it('默认是项目语境的卡片', async () => {
    await act(async () => root.render(createElement(WelcomeSuggestions, { onPick: () => {} })));
    expect(titles()).toEqual([
      'Map the project',
      'Find potential issues',
      'Add unit tests',
      'Summarize recent changes',
    ]);
  });

  it('secretary 变体用秘书语境的卡片', async () => {
    await act(async () =>
      root.render(createElement(WelcomeSuggestions, { onPick: () => {}, variant: 'secretary' }))
    );
    expect(titles()).toEqual([
      "Check today's progress",
      'Assign a task',
      'Organize the to-do list',
      'Clean up merged branches',
    ]);
  });

  it('点卡片把提示词交给 onPick', async () => {
    let picked = '';
    await act(async () =>
      root.render(
        createElement(WelcomeSuggestions, {
          onPick: (text: string) => (picked = text),
          variant: 'secretary',
        })
      )
    );
    const first = container.querySelector('[data-slot="welcome-suggestion"]');
    if (!first) throw new Error('Missing suggestion card');
    await act(async () => (first as HTMLElement).click());
    expect(picked).toBe("Summarize today's progress and list anything waiting on me.");
  });
});
