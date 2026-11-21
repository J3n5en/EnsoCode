import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? '')),
  }),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => '0:0' }));
vi.mock('@/stores/backgroundTasksView', () => ({
  useBackgroundTasksView: () => false,
  openBackgroundTasks: () => {},
}));

const { BackgroundTasksButtonView } = await import('./BackgroundTasksButton');

const render = (running: number, idle: number, active = false) =>
  renderToStaticMarkup(
    createElement(BackgroundTasksButtonView, { running, idle, active, onClick: () => {} })
  );

describe('BackgroundTasksButtonView', () => {
  it('没有在跑的任务时不渲染', () => {
    expect(render(0, 0)).toBe('');
  });

  it('小图标入口：角标是在跑加闲置的总数，悬停提示写明后台任务', () => {
    const html = render(3, 1);
    expect(html).toContain('data-enso="background-tasks-entry"');
    expect(html).toMatch(/data-slot="background-tasks-count"[^>]*>4<\/span>/);
    expect(html).toContain('title="Background tasks (4)');
    expect(html).not.toContain('>Background tasks<');
  });

  it('有疑似闲置时角标带标记，全部在跑时不带', () => {
    expect(render(0, 2)).toContain('data-idle="true"');
    expect(render(2, 0)).not.toContain('data-idle');
  });

  it('总览打开时标记 active', () => {
    expect(render(1, 0, true)).toContain('data-active="true"');
    expect(render(1, 0)).not.toContain('data-active');
  });

  it('超过 99 显示 99+', () => {
    expect(render(120, 0)).toContain('>99+</span>');
  });
});
