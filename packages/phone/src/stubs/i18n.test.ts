import { afterEach, describe, expect, it, vi } from 'vitest';
import { useI18n } from './i18n';

describe('phone useI18n', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('t 跨调用身份稳定，避免 MermaidRenderer 等依赖 t 的 effect 反复重绘', () => {
    expect(useI18n().t).toBe(useI18n().t);
  });

  it('uses the shared six-state Chinese labels while preserving waiting reasons', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' });
    vi.resetModules();
    const { t } = (await import('./i18n')).useI18n();
    expect(
      ['Free', 'Planning', 'Busy', 'Needs you', 'Stuck', 'Finished'].map((key) => t(key))
    ).toEqual(['空闲', '思考', '执行', '等待', '异常', '完成']);
    expect(t('Your approval: {{title}}', { title: 'pnpm test' })).toBe('你批准：pnpm test');
    expect(t('Your answer: {{title}}', { title: 'Which?' })).toBe('你回答：Which?');
  });
});
