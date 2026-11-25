import type { SecretaryContactState } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/plugins/PluginIcon', () => ({ PluginIcon: () => null }));
vi.mock('@/plugins/PluginView', () => ({ PluginFrame: () => null }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => '' } }));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    className: _className,
    ...rest
  }: { checked?: boolean; onCheckedChange?: (v: boolean) => void; className?: string } & Record<
    string,
    unknown
  >) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked === true}
      onClick={() => onCheckedChange?.(checked !== true)}
      {...rest}
    />
  ),
}));

const { SecretaryContactPanel } = await import('./SecretaryContactPanel');

const state: SecretaryContactState = {
  enabled: true,
  channels: [
    {
      id: 'telegram',
      title: 'Telegram',
      builtin: true,
      status: 'connected',
      caps: {
        buttons: true,
        urlButtons: true,
        edit: true,
        typing: true,
        format: 'html',
        maxChars: 4096,
        commandMenu: true,
        images: true,
        files: true,
      },
      prefs: { enabled: true, push: true, cardConfirm: true, syncMirror: false, memory: false },
    },
  ],
  telegram: {
    status: 'bound',
    chat: { id: 777, username: 'j3n5en' },
    bot: { id: 42, username: 'enso_bot', name: 'Enso' },
    allowCardConfirm: true,
    allowMemory: false,
    syncMirror: false,
    groups: [],
    following: [],
    poll: { state: 'running' },
    secure: true,
  },
  owner: { githubLogins: [], externalConfirm: false },
};

let root: Root;
let container: HTMLElement;
let contactSettings: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  contactSettings = vi.fn(async () => ({ ok: true }));
  (dom.window as unknown as Record<string, unknown>).electronAPI = {
    secretary: {
      list: async () => [],
      onListChanged: () => () => {},
      contactState: vi.fn(async () => state),
      onContactChanged: vi.fn(() => () => {}),
      contactSettings,
    },
    extensionPlugins: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => {}) },
  };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

async function renderFramed() {
  await act(async () => {
    root.render(
      <SecretaryContactPanel
        frames={{
          owner: (node) => <section data-frame="owner">{node}</section>,
          channels: (node) => <section data-frame="channels">{node}</section>,
        }}
      />
    );
  });
}

describe('设置 → 联系方式与主人的分组与控件', () => {
  it('「启用联系方式」总开关归在「联系渠道」组顶部，不在「主人身份」组里', async () => {
    await renderFramed();
    const master = container.querySelector('[data-enso="secretary-contact-master"]');
    expect(master).toBeTruthy();
    expect(master?.closest('[data-frame]')?.getAttribute('data-frame')).toBe('channels');
    const channels = container.querySelector('[data-frame="channels"]') as HTMLElement;
    const first = channels.querySelector('[data-enso]');
    expect(first?.getAttribute('data-enso')).toBe('secretary-contact-master');
  });

  it('Telegram 展开后的子项用 kit 开关，不是 checkbox；切换仍提交同一项偏好', async () => {
    await renderFramed();
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    const ids = [
      'secretary-contact-push',
      'secretary-contact-allow-dispatch',
      'secretary-contact-mirror',
      'secretary-contact-allow-memory',
    ];
    for (const id of ids) {
      const row = container.querySelector(`[data-enso="${id}"]`) as HTMLElement | null;
      expect(row, id).toBeTruthy();
      expect(row?.querySelector('[data-slot="settings-row"]'), id).toBeTruthy();
      expect(row?.querySelector('[role="switch"]'), id).toBeTruthy();
    }
    const mirror = container.querySelector(
      '[data-enso="secretary-contact-mirror"] [role="switch"]'
    ) as HTMLElement;
    await act(async () => mirror.click());
    expect(contactSettings).toHaveBeenCalledWith(
      { channelId: 'telegram', prefs: { syncMirror: true } },
      undefined
    );
  });
});
