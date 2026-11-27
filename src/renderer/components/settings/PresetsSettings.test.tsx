import type { PresetImportDraft } from '@shared/presetImport';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  t: (key: string) => key,
  readSystemPrompt: vi.fn(async () => ({ ok: true as const, content: 'builtin role prompt' })),
  writeSystemPrompt: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: harness.t }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({
      presets: [],
      skills: [],
      mcpServers: [],
      instructions: [],
      defaultPresetId: 'default',
      addPreset: vi.fn(),
      updatePreset: vi.fn(),
      removePreset: vi.fn(),
      setDefaultPresetId: vi.fn(),
    }),
}));
vi.mock('@/plugins/usePluginPresets', () => ({ useEnabledPluginPresets: () => [] }));
vi.mock('@/hooks/useScrollChain', () => ({ useScrollChain: () => ({ current: null }) }));
vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    disabled,
    onCheckedChange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={Boolean(checked)}
      disabled={disabled}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));
vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  CollapsibleContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div data-dialog="open">{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  DialogPanel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/ui/input', () => ({
  Input: (props: ComponentProps<'input'>) => <input {...props} />,
}));
vi.mock('./kit', () => ({
  SettingsPage: ({ children, actions }: { children?: ReactNode; actions?: ReactNode }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  SettingsButton: (props: ComponentProps<'button'>) => <button type="button" {...props} />,
}));
vi.mock('./ListFilterBar', () => ({
  ListFilterBar: () => null,
  matchesFilter: () => true,
}));
vi.mock('./NewSessionBadge', () => ({ NewSessionBadge: () => null }));

import { PresetEditDialog, PresetsSettings } from './PresetsSettings';

let root: Root;
let container: HTMLElement;

const FULL_ADVANCED_DRAFT: PresetImportDraft = {
  name: 'Custom preset',
  role: 'Role text',
  tail: 'Tail text',
  boost: 'Boost text',
  refusalRetry: true,
  refusalRetryPrompt: 'Retry text',
  suggestedSkills: [],
  suggestedMcp: [],
};

function classTokens(element: Element): string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(dom.window, {
    electronAPI: {
      presets: {
        readSystemPrompt: harness.readSystemPrompt,
        writeSystemPrompt: harness.writeSystemPrompt,
      },
    },
  });
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent: vi.fn(), detachEvent: vi.fn() });
  vi.clearAllMocks();
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('PresetsSettings 高级面板提示词框缩放布局', () => {
  it('高级面板的 4 个提示词框由内层 textarea 控制高度与纵向缩放，外层边框容器不锁死高度', async () => {
    await act(async () =>
      root.render(<PresetEditDialog preset={null} draft={FULL_ADVANCED_DRAFT} onClose={vi.fn()} />)
    );

    const controls = [...container.querySelectorAll('[data-slot="textarea-control"]')];
    expect(controls).toHaveLength(4);

    const labels = controls.map((control) =>
      control.querySelector('textarea[data-slot="textarea"]')?.getAttribute('aria-label')
    );
    expect(labels).toEqual(['Role description', 'Tail', 'Boost', 'Refusal retry prompt']);

    // 真实场景：外层 textarea-control 挂了 h-32/resize-y 时，拖拉内层 textarea 右下角会让边框停在原位，文本溢出盖住下方控件
    for (const control of controls) {
      const tokens = classTokens(control);
      expect(tokens.some((token) => /^h-/.test(token))).toBe(false);
      expect(tokens.some((token) => /^resize(?:$|-)/.test(token))).toBe(false);
      expect(tokens).toContain('[&_textarea]:h-32');
      expect(tokens).toContain('[&_textarea]:field-sizing-fixed');
      expect(tokens).toContain('[&_textarea]:resize-y');
      expect(tokens).toContain('[&_textarea]:overflow-auto');
    }
  });

  it('内置默认角色描述只读弹窗同样不会锁死外层边框容器高度', async () => {
    await act(async () => root.render(<PresetsSettings />));
    const previewButton = container.querySelector(
      'button[aria-label="View default role description"]'
    ) as HTMLElement | null;
    expect(previewButton).not.toBeNull();

    await act(async () => {
      previewButton!.click();
    });

    const control = container.querySelector('[data-slot="textarea-control"]');
    expect(control).not.toBeNull();
    const tokens = classTokens(control!);
    expect(tokens.some((token) => /^h-/.test(token))).toBe(false);
    expect(tokens).toContain('[&_textarea]:h-32');
    expect(tokens).toContain('[&_textarea]:resize-y');
  });
});
