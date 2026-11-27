import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgyCliSettings } from './AgyCliSettings';
import { ProviderSetupWizard } from './ProviderSetupWizard';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ providers: [], agy: undefined, addProviders: vi.fn(), setAgy: vi.fn() }),
}));
vi.mock('@/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: Wrap,
    DialogHeader: Wrap,
    DialogTitle: Wrap,
    DialogDescription: Wrap,
    DialogPanel: Wrap,
    DialogFooter: Wrap,
  };
});

describe('agy cli 入口', () => {
  it('添加服务商向导里列出 agy cli（实验）', () => {
    const markup = renderToStaticMarkup(<ProviderSetupWizard open onOpenChange={vi.fn()} />);
    expect(markup).toContain('agy cli (experimental)');
  });

  it('设置卡片标题标明实验', () => {
    expect(renderToStaticMarkup(<AgyCliSettings />)).toContain('agy cli (experimental)');
  });
});
