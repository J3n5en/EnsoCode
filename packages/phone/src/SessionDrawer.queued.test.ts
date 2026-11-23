import type { CatalogEntry, ProjectEntry } from '@enso/pair';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDrawer } from './SessionDrawer';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params
        ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? ''))
        : key,
    locale: 'zh',
  }),
}));
vi.mock('./theme', () => ({
  getThemePreference: () => 'auto',
  setThemePreference: () => {},
  subscribeTheme: () => () => {},
}));

const storage = vi.hoisted(() => {
  vi.stubGlobal('__COMMIT__', 'test');
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  });
  return data;
});

const projects: ProjectEntry[] = [{ id: 'p1', name: 'web', path: '/w' }];
const queued: CatalogEntry = {
  id: 'q1',
  title: '排队的活',
  projectName: 'web',
  projectId: 'p1',
  status: 'queued',
  queuePosition: 2,
};

describe('SessionDrawer 排队会话', () => {
  beforeEach(() => storage.clear());

  it('列表里用橙色闹钟标出位次', () => {
    const html = renderToStaticMarkup(
      createElement(SessionDrawer, {
        open: true,
        projects,
        catalog: [queued],
        activeId: null,
        canCreate: false,
        devices: [],
        activeDevicePairId: null,
        connected: true,
        connectionLabel: '',
        pushEnabled: false,
        pushBusy: false,
        pushError: null,
        pushAvailability: 'ok',
        pushConfigReady: true,
        onTogglePush: () => {},
        onClose: () => {},
        onSelect: () => {},
        onNewConversation: () => {},
        onSwitchDevice: () => {},
        onAddDevice: () => {},
        onRenameDevice: () => {},
        onUnpairDevice: () => {},
      })
    );
    expect(html).toContain('data-enso="conversation-queued"');
    expect(html).toContain('data-conversation-id="q1"');
    expect(html).toContain('lucide-alarm-clock');
    expect(html).toContain('2');
  });
});
