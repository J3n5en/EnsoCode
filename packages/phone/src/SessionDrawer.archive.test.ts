import type { CatalogEntry, ProjectEntry, ProjectGroupEntry } from '@enso/pair';
import { ALL_GROUP_ID, UNGROUPED_GROUP_ID } from '@shared/projectGroups';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDrawer } from './SessionDrawer';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'zh' }) }));
vi.mock('./theme', () => ({
  getThemePreference: () => 'auto',
  setThemePreference: () => {},
  subscribeTheme: () => () => {},
}));

// SessionDrawer 依赖的模块在导入时就读 localStorage
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

const groups: ProjectGroupEntry[] = [
  { id: 'g1', name: '前端', order: 0 },
  { id: 'g2', name: '后端', order: 1 },
];
const projects: ProjectEntry[] = [
  { id: 'p1', name: 'web', path: '/w', groupId: 'g1' },
  { id: 'p2', name: 'api', path: '/a', groupId: 'g2' },
];
const entry = (id: string, projectId: string, archived = false): CatalogEntry => ({
  id,
  title: id,
  projectName: projectId,
  projectId,
  status: 'idle',
  archived,
});
const catalog = [entry('a', 'p1', true), entry('b', 'p1', true), entry('c', 'p2')];

const render = (selected: string) => {
  storage.set('enso-phone-selected-project-group', selected);
  return renderToStaticMarkup(
    createElement(SessionDrawer, {
      open: true,
      projects,
      groups,
      catalog,
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
};

const archivedButton = (html: string) =>
  /<button[^>]*data-slot="archived-button"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';

describe('SessionDrawer 归档入口', () => {
  beforeEach(() => storage.clear());

  it.each([
    [ALL_GROUP_ID, 2],
    ['g1', 2],
    ['g2', 0],
    [UNGROUPED_GROUP_ID, 0],
  ])('分组 %s 都常驻入口，按分组计数', (selected, count) => {
    const button = archivedButton(render(selected));
    expect(button).not.toBe('');
    expect(button).toContain(`>${count}</span>`);
    expect(button.includes('data-empty="true"')).toBe(count === 0);
  });
});
