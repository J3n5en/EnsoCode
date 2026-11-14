import { getTranslation } from '@shared/i18n';
import type { SecretaryProfile } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretarySettings } from './SecretarySettings';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector({ skills: [] }),
}));
const formProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@/components/secretary/SecretaryProfileForm', () => ({
  SecretaryProfileForm: (props: Record<string, unknown>) => {
    formProps.current = props;
    return null;
  },
}));
vi.mock('@/components/secretary/SecretaryResetDialog', () => ({
  SecretaryResetDialog: () => null,
}));
vi.mock('./PresetsSettings', () => ({ PickList: () => null }));

const ROW = '[data-settings-row="secretary.dispatchLimit"]';
const DESCRIPTION =
  'The most dispatched sessions the secretary may run at the same time. Once the limit is reached, new dispatches are refused.';

function profile(maxRunningDispatches: number, updatedAt = 1): SecretaryProfile {
  return {
    version: 1,
    name: '秘书',
    avatar: { color: '#7c5cff' },
    autonomy: 'ask-first',
    autoApproveProjectIds: [],
    visibleProjectIds: 'all',
    dispatchModel: { mode: 'project' },
    dispatchWorktree: 'auto',
    maxRunningDispatches,
    dispatchMuted: true,
    dispatchUnattended: true,
    replyLanguage: 'ui',
    style: 'concise',
    notify: 'needs-user',
    updatedAt,
  };
}

const api = {
  getProfile: vi.fn(),
  saveProfile: vi.fn(),
};

let root: Root | undefined;
let container: HTMLElement;

beforeEach(() => {
  api.getProfile.mockReset();
  api.saveProfile.mockReset();
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(dom.window, {
    electronAPI: {
      secretary: {
        ...api,
        listSchedules: async () => ({ ok: true, schedules: [] }),
        listSkills: async () => ({ ok: true, skills: [] }),
        listTools: async () => ({ ok: true, tools: [] }),
        listTakeovers: async () => ({ ok: true, takeovers: [] }),
        onStateChanged: () => () => {},
      },
      extensionPlugins: { list: async () => [] },
    },
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = dom.document.getElementById('root') as unknown as HTMLElement;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function mount() {
  root = createRoot(container);
  await act(async () => root?.render(<SecretarySettings />));
}

function options() {
  return [...container.querySelectorAll(`${ROW} button`)] as HTMLButtonElement[];
}

function selected() {
  return options()
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent);
}

describe('设置 → 秘书：同时运行的派发会话上限', () => {
  it('显示当前值，可选范围是 1 到 10，并说明超限会拒绝新派发', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: profile(7), persona: '' });
    await mount();
    expect(options().map((button) => button.textContent)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index + 1))
    );
    expect(selected()).toEqual(['7']);
    expect(container.querySelector(ROW)?.textContent).toContain(DESCRIPTION);
  });

  it('选新值走档案保存，只改这一项，保存后显示新值', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: profile(3), persona: '' });
    api.saveProfile.mockResolvedValue({ ok: true, profile: profile(9, 2) });
    await mount();
    await act(async () => options()[8]?.click());
    expect(api.saveProfile).toHaveBeenCalledTimes(1);
    expect(api.saveProfile).toHaveBeenCalledWith({ maxRunningDispatches: 9 });
    expect(selected()).toEqual(['9']);
  });

  it('点当前值不重复保存', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: profile(3), persona: '' });
    await mount();
    await act(async () => options()[2]?.click());
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it('保存被拒时保留原值并显示错误', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: profile(3), persona: '' });
    api.saveProfile.mockResolvedValue({ ok: false, error: 'invalid maxRunningDispatches' });
    await mount();
    await act(async () => options()[0]?.click());
    expect(selected()).toEqual(['3']);
    expect(container.textContent).toContain('invalid maxRunningDispatches');
  });

  it('还没设置秘书时不给选项', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: null, persona: '' });
    await mount();
    expect(container.querySelector(ROW)).not.toBeNull();
    expect(options()).toEqual([]);
  });

  it('档案表单不再显示自己的上限档位，保存档案也不带上限', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: profile(7), persona: '' });
    api.saveProfile.mockResolvedValue({ ok: true, profile: profile(7, 2) });
    await mount();
    expect(formProps.current?.hideMaxRunning).toBe(true);
    const submit = formProps.current?.onSubmit as (draft: object) => void;
    await act(async () => submit({ name: '小秘', maxRunningDispatches: 3 }));
    expect(api.saveProfile).toHaveBeenCalledWith({ name: '小秘' });
  });

  it('标题与说明有中文', () => {
    expect(getTranslation('zh', 'Concurrent dispatch limit')).toBe('同时运行的派发会话上限');
    expect(getTranslation('zh', DESCRIPTION)).toBe(
      '秘书最多同时运行几个派发会话，超过上限时新派发会被拒绝。'
    );
  });
});
