import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { saveActiveDeviceId, saveDevices, saveLastSession } from './storage';

vi.mock('./ChatScreen', () => ({
  ChatScreen: ({ sessionId }: { sessionId: string }) => `CODE_VIEW:${sessionId}`,
}));
vi.mock('./client', () => ({ PairClient: class {} }));
vi.mock('./GroupChatScreen', () => ({ GroupChatScreen: () => 'GROUP_VIEW' }));
vi.mock('./SessionDrawer', () => ({ SessionDrawer: () => createElement('aside') }));
vi.mock('./BotDrawerPanel', () => ({ BotDrawerPanel: () => null }));
vi.mock('./PairScreen', () => ({ PairScreen: () => null }));
vi.mock('./NewSessionSheet', () => ({ NewSessionSheet: () => null }));
vi.mock('./SessionConfigSheet', () => ({ SessionConfigSheet: () => null }));
vi.mock('./stubs/electron-api', () => ({ setPhoneAgentActions: () => {} }));
vi.mock('./stubs/sessions-store', () => ({ setQueueActions: () => {} }));
vi.mock('./push', () => ({
  isPushSupported: () => false,
  isStandalone: () => false,
  PHONE_PUSH_ENABLED_KEY: 'enso-phone-push',
}));

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
  vi.stubGlobal('window', { location: { hash: '', search: '', pathname: '/' } });
  vi.stubGlobal('history', { replaceState: () => {} });
  vi.stubGlobal('navigator', { userAgent: 'test' });
  saveDevices([
    {
      pairId: 'p1',
      token: 't',
      contentKey: 'k',
      deviceName: 'phone',
      relayUrl: 'https://relay',
      pairedAt: 1,
      label: 'Desktop',
    },
  ]);
  saveActiveDeviceId('p1');
  saveLastSession('p1', 'old-code');
  localStorage.setItem('enso-phone-last-bot-chat:p1', 'group-a');
});
afterEach(() => vi.unstubAllGlobals());

it('does not show Code while the restored Bot directory is still loading', () => {
  const html = renderToStaticMarkup(createElement(App));
  expect(html).not.toContain('CODE_VIEW:old-code');
  expect(html).toContain('恢复 Bot 聊天');
});

it('lets an explicit launch session override the restored Bot chat', () => {
  window.location.search = '?session=notification';
  expect(renderToStaticMarkup(createElement(App))).toContain('CODE_VIEW:notification');
});

it.each(['', '?session=notification'])(
  'fixes the whole sidebar-and-content shell, not the conversation alone, in standalone (%s)',
  (search) => {
    window.location.search = search;
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    const rule = css.match(
      /@media\s*\(display-mode:\s*standalone\)\s*\{\s*\.([\w-]+)\s*\{([^}]+)\}/
    );
    expect(rule).not.toBeNull();
    expect(rule?.[2]).toMatch(/position:\s*fixed/);
    expect(rule?.[2]).toMatch(/inset:\s*0/);
    const html = renderToStaticMarkup(createElement(App));
    const rootClasses = html.match(/^<div class="([^"]+)"/)?.[1].split(' ');
    expect(rootClasses).toContain(rule?.[1]);
    expect(html).toContain('<aside>');
    expect(html).toContain(search ? 'CODE_VIEW:notification' : '恢复 Bot 聊天');
  }
);
