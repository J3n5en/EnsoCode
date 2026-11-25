import type { McpServerEntry } from '@shared/types';
import { MotionGlobalConfig } from 'framer-motion';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSettings } from './McpSettings';

const server: McpServerEntry = {
  id: 'mcp-1',
  name: 'Filesystem',
  enabled: true,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem'],
  source: 'user',
};

const harness = vi.hoisted(() => ({
  servers: [] as McpServerEntry[],
  removeMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
  setMcpServersEnabled: vi.fn(),
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      mcpServers: harness.servers,
      updateMcpServer: harness.updateMcpServer,
      setMcpServersEnabled: harness.setMcpServersEnabled,
      removeMcpServer: harness.removeMcpServer,
    }),
}));
vi.mock('@/stores/mcpStatus', () => {
  const state = {
    statuses: {},
    authorized: {},
    pending: {},
    authorize: vi.fn(),
    revoke: vi.fn(),
    bind: () => () => {},
  };
  return {
    useMcpStatusStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('./ListFilterBar', () => ({
  ListFilterBar: () => null,
  matchesFilter: () => true,
  useVisibleSelection: () => ({
    selectedIds: [],
    allSelected: false,
    someSelected: false,
    toggleOne: vi.fn(),
    toggleAll: vi.fn(),
    isSelected: () => false,
  }),
}));
vi.mock('./LocalAssetImportDialog', () => ({ LocalAssetImportDialog: () => null }));
vi.mock('./McpEditDialog', () => ({ McpEditDialog: () => null }));
vi.mock('./NewSessionBadge', () => ({ NewSessionBadge: () => null }));
vi.mock('./OccupancyMark', () => ({
  enabledOccupancyTotal: () => 0,
  OccupancyEnabledTotal: () => null,
  OccupancyMark: () => null,
  useOccupancyRows: () => ({ rows: {}, pending: false }),
}));
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
  Checkbox: () => null,
}));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked === true}
      onClick={() => onCheckedChange?.(!checked)}
    />
  ),
}));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: ({ children }: { children?: ReactNode }) => <div role="radiogroup">{children}</div>,
  Radio: ({ value }: { value?: string }) => (
    <button type="button" role="radio" aria-checked={false} data-value={value} />
  ),
}));
vi.mock('@/components/chat/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    confirmLabel,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean;
    title: string;
    confirmLabel: string;
    onConfirm: () => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-confirm-dialog="">
        <p>{title}</p>
        <button type="button" data-confirm-cancel="" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button
          type="button"
          data-confirm-accept=""
          onClick={() => {
            onConfirm();
            onOpenChange(false);
          }}
        >
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  MotionGlobalConfig.skipAnimations = true;
  harness.servers = [server];
  harness.removeMcpServer.mockReset();
  const dom = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  MotionGlobalConfig.skipAnimations = false;
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('McpSettings delete confirmation', () => {
  it('requires confirmation before deleting an MCP server', async () => {
    await act(async () => root.render(<McpSettings />));

    const toggle = container.querySelector(
      '[data-slot="settings-expandable"] button[aria-expanded]'
    ) as HTMLButtonElement;
    await act(async () => toggle.click());

    const deleteButton = [...container.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === 'Delete'
    );
    expect(deleteButton).toBeDefined();

    await act(async () => deleteButton?.click());
    expect(harness.removeMcpServer).not.toHaveBeenCalled();
    expect(container.querySelector('[data-confirm-dialog]')?.textContent).toContain(
      'Delete MCP server?'
    );

    const confirmAccept = container.querySelector('[data-confirm-accept]') as HTMLButtonElement;
    await act(async () => confirmAccept.click());
    expect(harness.removeMcpServer).toHaveBeenCalledWith('mcp-1');
  });
});
