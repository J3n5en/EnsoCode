import { getTranslation } from '@shared/i18n';
import type { SecretaryProfile } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findNestedBoxes, isBoxedClassName } from './kit/boxes';
import { SecretarySettings } from './SecretarySettings';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      skills: [],
      projects: [
        { id: 'p1', name: 'enso', path: '/repo/enso' },
        { id: 'p2', name: 'beta', path: '/repo/beta' },
        { id: 'sec', name: '秘书', path: '/repo/sec', kind: 'secretary' },
      ],
    }),
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
const deleteProps = vi.hoisted(() => ({
  current: null as { secretaryId: string; onDeleted?: () => void } | null,
}));
vi.mock('@/components/secretary/SecretaryDeleteDialog', () => ({
  SecretaryDeleteDialog: (props: { secretaryId: string; onDeleted?: () => void }) => {
    deleteProps.current = props;
    return null;
  },
}));
vi.mock('./PresetsSettings', () => ({ PickList: () => null }));

/** 裁切弹窗与读文件都换成可控桩：这里只验上传状态机，不验 canvas */
const raster = vi.hoisted(() => ({ readDataUrl: vi.fn() }));
vi.mock('@/components/bots/avatarRaster', () => ({
  readDataUrl: raster.readDataUrl,
  dataUrlBytes: (url: string) => new TextEncoder().encode(url),
}));
vi.mock('@/components/bots/AvatarCropDialog', () => ({
  AvatarCropDialog: ({
    source,
    onDone,
  }: {
    source: string | null;
    onDone: (dataUrl: string) => void;
  }) =>
    source === null ? null : (
      <button
        type="button"
        data-enso="crop-confirm"
        data-source={source}
        onClick={() => onDone(source)}
      >
        Use this avatar
      </button>
    ),
}));

const ROW = '[data-settings-row="secretary.dispatchLimit"]';
const DESCRIPTION =
  'The most dispatched sessions the secretary may run at the same time. Dispatches beyond the limit wait in line and start on their own when a slot frees up.';

function profile(maxRunningDispatches: number, updatedAt = 1): SecretaryProfile {
  return {
    version: 1,
    name: '秘书',
    avatar: { color: '#7c5cff' },
    takeoverScope: { mode: 'projects', projectIds: [] },
    visibleProjectIds: 'all',
    maxRunningDispatches,
    patrolEnabled: true,
    replyLanguage: 'ui',
    style: 'concise',
    notify: 'needs-user',
    updatedAt,
  };
}

const api = {
  list: vi.fn(async () => [] as { id: string; name: string | null }[]),
  onListChanged: vi.fn(
    (_listener: (list: { id: string; name: string | null }[]) => void) => () => {}
  ),
  getProfile: vi.fn(),
  saveProfile: vi.fn(),
  setAvatar: vi.fn(),
};

let root: Root | undefined;
let container: HTMLElement;

beforeEach(() => {
  api.list.mockReset();
  api.list.mockImplementation(async () => []);
  api.onListChanged.mockClear();
  api.getProfile.mockReset();
  api.saveProfile.mockReset();
  api.setAvatar.mockReset();
  raster.readDataUrl.mockReset();
  raster.readDataUrl.mockImplementation(async (file: { name: string }) => `data:${file.name}`);
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(dom.window, {
    electronAPI: {
      secretary: {
        ...api,
        listSchedules: async () => ({ ok: true, schedules: [] }),
        listSkills: async () => ({ ok: true, skills: [] }),
        listTools: async () => ({ ok: true, tools: [] }),
        listTakeovers: async () => ({ ok: true, takeovers: [] }),
        listUntracked: async () => ({ ok: true, untracked: [] }),
        removeUntracked: async () => ({ ok: true }),
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
  it('显示当前值，可选范围是 1 到 10，并说明超限的派发排队、有空位自动开始', async () => {
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
    expect(api.saveProfile).toHaveBeenCalledWith({ maxRunningDispatches: 9 }, undefined);
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
    expect(api.saveProfile).toHaveBeenCalledWith({ name: '小秘' }, undefined);
  });

  it('标题与说明有中文', () => {
    expect(getTranslation('zh', 'Concurrent dispatch limit')).toBe('同时运行的派发会话上限');
    expect(getTranslation('zh', DESCRIPTION)).toBe(
      '秘书最多同时运行几个派发会话，超出的派发会排队，有空位时自动开始。'
    );
  });
});

const SCOPE_ROW = '[data-settings-row="secretary.takeoverScope"]';
const SCOPE_DESCRIPTION =
  'Which sessions the secretary may message and stop without asking you first. Everything else still needs a confirmation card from the secretary.';

function scopeButtons() {
  return [...container.querySelectorAll(`${SCOPE_ROW} button`)] as HTMLButtonElement[];
}

describe('设置 → 秘书：可接管的会话', () => {
  it('三个选项，默认是勾选的项目且一个都不勾', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: profile(3), persona: '' });
    await mount();
    expect(scopeButtons().map((button) => button.textContent)).toEqual([
      'One by one',
      'Selected projects',
      'All visible projects',
      'enso',
      'beta',
    ]);
    expect(
      scopeButtons()
        .filter((button) => button.getAttribute('aria-pressed') === 'true')
        .map((button) => button.textContent)
    ).toEqual(['Selected projects']);
    expect(container.querySelector(SCOPE_ROW)?.textContent).toContain(SCOPE_DESCRIPTION);
  });

  it('勾选项目只改接管范围这一项，秘书自己的项目不出现', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: profile(3), persona: '' });
    api.saveProfile.mockResolvedValue({
      ok: true,
      profile: {
        ...profile(3),
        takeoverScope: { mode: 'projects', projectIds: ['p1'] },
        updatedAt: 2,
      },
    });
    await mount();
    const project = container.querySelector(
      `${SCOPE_ROW} [data-enso="secretary-takeover-projects"] button`
    ) as HTMLButtonElement;
    expect(project.textContent).toBe('enso');
    await act(async () => project.click());
    expect(api.saveProfile).toHaveBeenCalledWith(
      { takeoverScope: { mode: 'projects', projectIds: ['p1'] } },
      undefined
    );
    expect(scopeButtons().some((button) => button.textContent === '秘书')).toBe(false);
  });

  it('切到所有可见项目只发模式，切回逐个授权同样只发模式', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: profile(3), persona: '' });
    api.saveProfile.mockResolvedValue({ ok: true, profile: profile(3, 2) });
    await mount();
    await act(async () => scopeButtons()[2]?.click());
    expect(api.saveProfile).toHaveBeenLastCalledWith({ takeoverScope: { mode: 'all' } }, undefined);
    await act(async () => scopeButtons()[0]?.click());
    expect(api.saveProfile).toHaveBeenLastCalledWith(
      { takeoverScope: { mode: 'explicit' } },
      undefined
    );
  });

  it('标题与说明有中文', () => {
    expect(getTranslation('zh', 'Sessions it may take over')).toBe('可接管的会话');
    expect(getTranslation('zh', SCOPE_DESCRIPTION)).toBe(
      '秘书可以直接给哪些会话发消息、停止它们，不用逐个确认。范围外的会话仍然要秘书提确认卡。'
    );
  });
});

const AVATAR_INPUT = '[data-enso="secretary-avatar-file"]';
const CROP_CONFIRM = '[data-enso="crop-confirm"]';
const AVATAR_PROBLEM = '[data-enso="secretary-avatar-problem"]';

function avatarProfile(
  imageVersion: number | undefined,
  imageHash?: string,
  updatedAt = 1
): SecretaryProfile {
  return {
    ...profile(3, updatedAt),
    avatar: {
      color: '#7c5cff',
      ...(imageVersion ? { imageVersion, ...(imageHash ? { imageHash } : {}) } : {}),
    },
  };
}

function avatarSrc(): string | null {
  return (
    container.querySelector('[data-enso="secretary-settings-avatar"] img')?.getAttribute('src') ??
    null
  );
}

function cropSource(): string | null {
  return container.querySelector(CROP_CONFIRM)?.getAttribute('data-source') ?? null;
}

async function pick(name: string, type = 'image/png', size = 10, content?: Uint8Array) {
  const input = container.querySelector(AVATAR_INPUT) as HTMLInputElement;
  const file = content
    ? { name, type, size, arrayBuffer: async () => content.slice().buffer }
    : { name, type, size };
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  });
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

async function confirmCrop() {
  const button = container.querySelector(CROP_CONFIRM) as HTMLButtonElement;
  await act(async () => button.click());
}

describe('设置 → 秘书：头像上传', () => {
  it('连续换两张图：第二次裁切的是第二张，地址也跟着换', async () => {
    api.getProfile.mockResolvedValue({
      ok: true,
      profile: avatarProfile(1, 'aaaaaaaa'),
      persona: '',
    });
    api.setAvatar
      .mockResolvedValueOnce({ ok: true, profile: avatarProfile(2, 'bbbbbbbb', 2) })
      .mockResolvedValueOnce({ ok: true, profile: avatarProfile(3, 'cccccccc', 3) });
    await mount();
    expect(avatarSrc()).toBe('local-image://secretary-avatar/avatar.png?v=1&h=aaaaaaaa');

    await pick('first.png');
    expect(cropSource()).toBe('data:first.png');
    await confirmCrop();
    expect(api.setAvatar).toHaveBeenCalledTimes(1);
    expect(avatarSrc()).toBe('local-image://secretary-avatar/avatar.png?v=2&h=bbbbbbbb');

    await pick('second.png');
    expect(cropSource()).toBe('data:second.png');
    await confirmCrop();
    expect(api.setAvatar).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode(api.setAvatar.mock.calls[1]?.[0] as Uint8Array)).toBe(
      'data:second.png'
    );
    expect(avatarSrc()).toBe('local-image://secretary-avatar/avatar.png?v=3&h=cccccccc');
  });

  it('不合规图片被拒后，再选合规图片照常生效', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: avatarProfile(undefined), persona: '' });
    api.setAvatar.mockResolvedValue({ ok: true, profile: avatarProfile(1, 'aaaaaaaa', 2) });
    await mount();

    await pick('notes.txt', 'text/plain');
    expect(container.querySelector(CROP_CONFIRM)).toBeNull();
    expect(container.querySelector(AVATAR_PROBLEM)?.textContent).toContain('PNG');
    expect(api.setAvatar).not.toHaveBeenCalled();

    await pick('ok.png');
    expect(cropSource()).toBe('data:ok.png');
    await confirmCrop();
    expect(api.setAvatar).toHaveBeenCalledTimes(1);
    expect(avatarSrc()).toBe('local-image://secretary-avatar/avatar.png?v=1&h=aaaaaaaa');
  });

  it('保存失败会提示并清掉待裁切的图，下一次仍能正常上传', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: avatarProfile(undefined), persona: '' });
    api.setAvatar.mockResolvedValueOnce({ ok: false, error: 'disk full' });
    await mount();

    await pick('first.png');
    await confirmCrop();
    expect(container.textContent).toContain('disk full');
    expect(container.querySelector(AVATAR_PROBLEM)).not.toBeNull();
    expect(container.querySelector(CROP_CONFIRM)).toBeNull();
    expect(avatarSrc()).toBeNull();

    api.setAvatar.mockResolvedValue({ ok: true, profile: avatarProfile(1, 'aaaaaaaa', 2) });
    await pick('second.png');
    expect(cropSource()).toBe('data:second.png');
    expect(container.querySelector(AVATAR_PROBLEM)).toBeNull();
  });

  it('GIF 跳过裁切、原字节保存；标成 GIF 但字节不是 GIF 时仍走裁切', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: avatarProfile(undefined), persona: '' });
    api.setAvatar.mockResolvedValue({ ok: true, profile: avatarProfile(1, 'aaaaaaaa', 2) });
    await mount();

    const gif = Uint8Array.from('GIF89a\x01\x00\x01\x00', (char) => char.charCodeAt(0));
    await pick('face.gif', 'image/gif', gif.byteLength, gif);
    expect(container.querySelector(CROP_CONFIRM)).toBeNull();
    expect(raster.readDataUrl).not.toHaveBeenCalled();
    expect(api.setAvatar).toHaveBeenCalledTimes(1);
    expect(Array.from(api.setAvatar.mock.calls[0]?.[0] as Uint8Array)).toEqual(Array.from(gif));
    expect(avatarSrc()).toBe('local-image://secretary-avatar/avatar.png?v=1&h=aaaaaaaa');

    await pick('fake.gif', 'image/gif', 4, Uint8Array.of(137, 80, 78, 71));
    expect(cropSource()).toBe('data:fake.gif');
    expect(api.setAvatar).toHaveBeenCalledTimes(1);
  });
});

describe('设置 → 秘书：删除后切换', () => {
  const three = [
    { id: 's-b', name: 'B' },
    { id: 's-a', name: 'A' },
    { id: 's-c', name: 'C' },
  ];
  const openDelete = () =>
    act(async () =>
      (
        container.querySelector('[data-enso="secretary-settings-delete"]') as HTMLButtonElement
      ).click()
    );

  beforeEach(() => {
    deleteProps.current = null;
    api.getProfile.mockImplementation(async (id: string) => ({
      ok: true,
      profile: { ...profile(3), name: id === 's-b' ? 'B' : id === 's-a' ? 'A' : 'C' },
      persona: '',
    }));
  });

  it('删除后立刻从列表摘掉，选中落到剩下的第一个，并加载它自己的档案', async () => {
    api.list.mockResolvedValueOnce(three);
    await mount();
    expect((formProps.current?.initialDraft as { name: string } | undefined)?.name).toBe('B');
    await openDelete();
    expect(deleteProps.current?.secretaryId).toBe('s-b');

    // 重拉列表迟迟不回：界面也不能停在已删除的那个上
    api.list.mockImplementation(() => new Promise(() => {}));
    await act(async () => deleteProps.current?.onDeleted?.());
    const picks = [...container.querySelectorAll('[data-enso="secretary-settings-pick"]')].map(
      (el) => el.getAttribute('data-secretary-id')
    );
    expect(picks).toEqual(['s-a', 's-c']);
    expect(api.getProfile).toHaveBeenLastCalledWith('s-a');
    expect((formProps.current?.initialDraft as { name: string } | undefined)?.name).toBe('A');
  });

  it('删除途中列表先推过来（已删的那个不在了）：弹窗仍指着点删除时的那个秘书', async () => {
    api.list.mockResolvedValueOnce(three);
    await mount();
    await openDelete();
    expect(deleteProps.current?.secretaryId).toBe('s-b');

    // Main 删完先广播列表，再回 IPC 结果
    const push = api.onListChanged.mock.calls.at(-1)?.[0];
    await act(async () => push?.(three.filter((entry) => entry.id !== 's-b')));
    expect(deleteProps.current?.secretaryId).toBe('s-b');

    api.list.mockImplementation(() => new Promise(() => {}));
    await act(async () => deleteProps.current?.onDeleted?.());
    expect(api.getProfile).toHaveBeenLastCalledWith('s-a');
    expect((formProps.current?.initialDraft as { name: string } | undefined)?.name).toBe('A');
  });
});

describe('设置 → 秘书：技能分组', () => {
  it('全局技能为空时和秘书自有技能一样平铺一行提示，不套带框容器', async () => {
    api.getProfile.mockResolvedValue({ ok: true, profile: profile(3), persona: '' });
    await mount();
    const section = container.querySelector('[data-settings-row="secretary.skills"]') as Element;
    expect(section.textContent).toContain('Global skills');
    const empties = [...section.querySelectorAll('p')].filter(
      (el) => el.textContent === 'No skills yet'
    );
    expect(empties).toHaveLength(2);
    for (const empty of empties) {
      let el: Element | null = empty;
      while (el && el !== section) {
        if (el.getAttribute('data-slot') !== 'settings-group') {
          expect(isBoxedClassName(el.getAttribute('class') ?? ''), el.outerHTML.slice(0, 80)).toBe(
            false
          );
        }
        el = el.parentElement;
      }
    }
    expect(findNestedBoxes(container)).toEqual([]);
  });
});
