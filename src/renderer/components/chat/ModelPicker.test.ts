import type { ModelProvider } from '@shared/types';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ModelPicker } from './ModelPicker';

interface WrapperProps {
  children?: ReactNode;
}

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      Object.entries(params ?? {}).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
        key
      ),
  }),
}));

vi.mock('@/stores/modelMeta', () => ({
  useModelMeta: () => ({}),
}));

vi.mock('@/components/ui/menu', () => {
  const Wrap = ({ children }: WrapperProps) => createElement('div', null, children);
  return {
    Menu: Wrap,
    MenuGroup: Wrap,
    MenuGroupLabel: Wrap,
    MenuItem: Wrap,
    MenuPopup: Wrap,
    MenuSub: Wrap,
    MenuSubPopup: Wrap,
    MenuSubTrigger: Wrap,
    MenuTrigger: Wrap,
  };
});

vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: WrapperProps) => createElement('span', null, children),
}));

vi.mock('@/components/ui/slider', () => ({
  Slider: () => createElement('i', { 'data-slider': 'true' }),
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: () => createElement('i', { 'data-switch': 'true' }),
}));

const providers: ModelProvider[] = [
  {
    id: 'api',
    name: 'API entry',
    api: 'openai-completions',
    apiKey: 'secret',
    baseUrl: 'https://example.test/v1',
    enabled: true,
    models: [{ id: 'model', label: 'Chosen model' }],
  },
];

const commonProps = {
  providers,
  providerId: 'api',
  modelId: 'model',
  reasoningEnabled: true,
  thinkingLevel: 'medium' as const,
  onSelect: vi.fn(),
  onReasoningChange: vi.fn(),
  onThinkingChange: vi.fn(),
};

describe('ModelPicker reasoning controls mode', () => {
  it('keeps reasoning and thinking controls by default for ChatView', () => {
    const html = renderToStaticMarkup(createElement(ModelPicker, commonProps));
    expect(html).toContain('Reasoning');
    expect(html).toContain('Med');
    expect(html).toContain('data-slider="true"');
  });

  it('hides session-only reasoning and thinking controls for default model settings', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, { ...commonProps, showReasoningControls: false })
    );
    expect(html).toContain('Chosen model');
    expect(html).not.toContain('Reasoning');
    expect(html).not.toContain('data-slider="true"');
    expect(html).not.toContain('data-switch="true"');
  });
});
