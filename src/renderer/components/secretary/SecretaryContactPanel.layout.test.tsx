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

  it('主人身份是分组行结构：输入框与保存按钮同行、外部消息用分段控件', async () => {
    await renderFramed();
    const owner = container.querySelector('[data-enso="secretary-contact-owner"]') as HTMLElement;
    expect(owner).toBeTruthy();
    const rows = owner.querySelectorAll('[data-slot="settings-row"]');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const input = owner.querySelector(
      '[data-enso="secretary-contact-github-logins"]'
    ) as HTMLInputElement;
    const save = owner.querySelector(
      '[data-enso="secretary-contact-github-save"]'
    ) as HTMLButtonElement;
    // 输入框和保存按钮在同一行容器里，不再各自独占一行
    const inputRow = input.closest('[data-slot="settings-row"]');
    expect(inputRow).toBeTruthy();
    expect(inputRow?.contains(save)).toBe(true);
    // 外部渠道的非主人消息：分段控件（radiogroup），不是两个裸按钮
    const segmented = owner.querySelector('[role="radiogroup"]');
    expect(segmented).toBeTruthy();
    expect(segmented?.querySelector('[data-enso="secretary-contact-external-agent"]')).toBeTruthy();
    expect(
      segmented?.querySelector('[data-enso="secretary-contact-external-confirm"]')
    ).toBeTruthy();
    // 两个选项同一时刻只有一个被选中
    expect(segmented?.querySelectorAll('[role="radio"][aria-checked="true"]').length).toBe(1);
  });

  it('渠道展开区是 settings-sub-group 结构，开关行在其中', async () => {
    await renderFramed();
    const channel = container.querySelector(
      '[data-enso="secretary-contact-channel"][data-channel="telegram"]'
    ) as HTMLElement;
    expect(channel).toBeTruthy();
    const subgroup = channel.querySelector('[data-slot="settings-sub-group"]');
    expect(subgroup).toBeTruthy();
    for (const id of ['secretary-contact-push', 'secretary-contact-mirror']) {
      expect(subgroup?.querySelector(`[data-enso="${id}"]`), `${id} in sub-group`).toBeTruthy();
    }
    // 展开区里的绑定/群/命令信息块带统一缩进 padding，不裸贴卡片边缘
    const groups = subgroup?.querySelector('[data-enso="secretary-contact-groups"]') as HTMLElement;
    expect(groups).toBeTruthy();
    expect(groups?.className).toContain('pl-10');
    expect(groups?.className).toContain('pr-4');
  });

  it('渠道卡片头与体之间不再各画一遍 border 线', async () => {
    await renderFramed();
    const channel = container.querySelector(
      '[data-enso="secretary-contact-channel"][data-channel="telegram"]'
    ) as HTMLElement;
    // 卡片头是 settings-row，卡片间分隔交给分组发丝线；不再自画 border-b
    expect(channel.className).not.toContain('border-b');
  });
});
