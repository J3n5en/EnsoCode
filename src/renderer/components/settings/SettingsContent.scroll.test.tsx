import type { SettingsDeepLink } from '@shared/settingsDeepLink';
import { parseHTML } from 'linkedom';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findNestedBoxes } from './kit/boxes';
import { SettingsContent } from './SettingsContent';

const harness = vi.hoisted(() => ({
  mobile: false,
  page: (name: string) => () => (
    <div data-page={name}>
      <div data-settings-row={`${name}.row`}>{name}</div>
    </div>
  ),
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useViewport', () => ({ useIsMobile: () => harness.mobile }));
vi.mock('@/hooks/useSettingsCatalog', () => ({ useSettingsCatalog: () => [] }));
vi.mock('@/stores/settings', () => {
  const state = { disabledBuiltinTools: [], botModeEnabled: false, secretaryEnabled: false };
  const useSettingsStore = (select: (s: typeof state) => unknown) => select(state);
  useSettingsStore.persist = { hasHydrated: () => true, onFinishHydration: () => () => {} };
  return { useSettingsStore };
});
vi.mock('./AgentTypesSettings', () => ({ AgentTypesSettings: harness.page('agents') }));
vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: harness.page('appearance') }));
vi.mock('./BotSettings', () => ({ BotSettings: harness.page('bots') }));
vi.mock('./BotTemplatesSettings', () => ({ BotTemplatesSettings: harness.page('botTemplates') }));
vi.mock('./BuiltinToolsSettings', () => ({ BuiltinToolsSettings: harness.page('tools') }));
vi.mock('./ContactsSettings', () => ({ ContactsSettings: harness.page('contacts') }));
vi.mock('./ConversationSettings', () => ({
  ConversationSettings: ({ revealRowId }: { revealRowId?: string | null }) => (
    <div data-page="conversation">
      <div data-settings-row="conversation.row">conversation</div>
      {revealRowId === 'appearance.liveActivityFoldDelaySec' ? (
        <div data-settings-row="appearance.liveActivityFoldDelaySec">delay</div>
      ) : null}
    </div>
  ),
}));
vi.mock('./RuntimeSettings', () => ({ RuntimeSettings: harness.page('runtime') }));
vi.mock('./TerminalSettings', () => ({ TerminalSettings: harness.page('terminal') }));

vi.mock('./DevicesSettings', () => ({ DevicesSettings: harness.page('phone') }));
vi.mock('./ExperimentalSettings', () => ({ ExperimentalSettings: harness.page('experimental') }));
vi.mock('./GeneralSettings', () => ({ GeneralSettings: harness.page('general') }));
vi.mock('./InstructionsSettings', () => ({ InstructionsSettings: harness.page('instructions') }));
vi.mock('./KeybindingsSettings', () => ({ KeybindingsSettings: harness.page('shortcuts') }));
vi.mock('./LogsSettings', () => ({ LogsSettings: harness.page('logs') }));
vi.mock('./McpSettings', () => ({ McpSettings: harness.page('mcp') }));
vi.mock('./MemoryKnowledge', () => ({ MemoryKnowledge: harness.page('memoryKnowledge') }));
vi.mock('./MemoryLibrary', () => ({ MemoryLibrary: harness.page('memoryLibrary') }));
vi.mock('./MemorySettings', () => ({ MemorySettings: harness.page('memory') }));
vi.mock('./PluginsSettings', () => ({ EnsoPluginsSettings: harness.page('plugins') }));
vi.mock('./PresetsSettings', () => ({ PresetsSettings: harness.page('presets') }));
vi.mock('./PrivacySettings', () => ({ PrivacySettings: harness.page('privacy') }));
vi.mock('./ProvidersSettings', () => ({ ProvidersSettings: harness.page('providers') }));
vi.mock('./ResourcesSettings', () => ({ ResourcesSettings: harness.page('resources') }));
vi.mock('./SecretarySettings', () => ({ SecretarySettings: harness.page('secretary') }));
vi.mock('./SkillsSettings', () => ({ SkillsSettings: harness.page('skills') }));
vi.mock('./SshSettings', () => ({ SshSettings: harness.page('ssh') }));
vi.mock('./UsageSettings', () => ({ UsageSettings: harness.page('usage') }));
vi.mock('./WorkflowsSettings', () => ({ WorkflowsSettings: harness.page('workflows') }));

const noop = () => {};

/** 主窗口的设置路由：窄屏两级状态由外层持有 */
function Settings({
  link = null,
  linkSeq = 0,
  onNavResize,
}: {
  link?: SettingsDeepLink | null;
  linkSeq?: number;
  onNavResize?: (dx: number) => void;
}) {
  const [mobileDetail, setMobileDetail] = React.useState(false);
  return (
    <SettingsContent
      link={link}
      linkSeq={linkSeq}
      embedded={{
        initialCategory: 'general',
        onCategoryChange: noop,
        mobileDetail,
        onMobileDetailChange: setMobileDetail,
        onBack: noop,
        navWidth: 260,
        onNavResize,
      }}
    />
  );
}

let root: Root;
let container: HTMLElement;
let doc: Document;

const scroller = () => {
  const content = container.querySelector('[data-enso="settings-content"]');
  const el = content?.lastElementChild as HTMLElement | null | undefined;
  expect(el, 'content scroller').toBeTruthy();
  return el as HTMLElement;
};
const top = () => Number(scroller().scrollTop ?? 0);
/** 用户把内容滚到某处：改 scrollTop 并派发 scroll */
const scrollTo = async (px: number) => {
  await act(async () => {
    const el = scroller();
    el.scrollTop = px;
    el.dispatchEvent(new doc.defaultView!.Event('scroll'));
  });
};
const open = async (label: string) => {
  const nav = container.querySelector('[data-enso="settings-nav"]');
  const found = [...(nav?.querySelectorAll('button') ?? [])].find(
    (el) => el.textContent?.trim() === label
  );
  expect(found, label).toBeTruthy();
  await act(async () => (found as HTMLElement).click());
};

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  doc = dom.document as unknown as Document;
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('CSS', { escape: (s: string) => s });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  );
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  Object.assign(dom.window, {
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    },
    electronAPI: { sshConnections: { list: async () => [] } },
  });
  harness.mobile = false;
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('设置分区各自的滚动位置', () => {
  it('切到新分区从顶部开始', async () => {
    await act(async () => root.render(<Settings />));
    await scrollTo(300);
    await open('Logs');
    expect(container.querySelector('[data-page="logs"]')).toBeTruthy();
    expect(top()).toBe(0);
  });

  it('切回来恢复各自上次离开时的位置', async () => {
    await act(async () => root.render(<Settings />));
    await scrollTo(300);
    await open('Logs');
    await scrollTo(120);
    await open('General');
    expect(top()).toBe(300);
    await open('Logs');
    expect(top()).toBe(120);
    await open('Appearance');
    expect(top()).toBe(0);
  });

  it('深链跳到某行：定位到那一行，不被保存的位置覆盖', async () => {
    const hits: string[] = [];
    await act(async () => root.render(<Settings />));
    await open('Logs');
    await scrollTo(500);
    await open('General');
    const proto = Object.getPrototypeOf(container) as { scrollIntoView?: unknown };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      hits.push(this.getAttribute('data-settings-row') ?? '');
      scroller().scrollTop = 42;
    };
    try {
      await act(async () =>
        root.render(<Settings link={{ category: 'logs', rowId: 'logs.row' }} linkSeq={1} />)
      );
    } finally {
      proto.scrollIntoView = original;
    }
    expect(container.querySelector('[data-page="logs"]')).toBeTruthy();
    expect(hits[0]).toBe('logs.row');
    expect(top()).toBe(42);
  });

  it('目标行被父开关藏起时先临时展开再定位，不改设置', async () => {
    const hits: string[] = [];
    const proto = Object.getPrototypeOf(container) as { scrollIntoView?: unknown };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      hits.push(this.getAttribute('data-settings-row') ?? '');
    };
    try {
      await act(async () =>
        root.render(
          <Settings
            link={{ category: 'conversation', rowId: 'appearance.liveActivityFoldDelaySec' }}
            linkSeq={1}
          />
        )
      );
    } finally {
      proto.scrollIntoView = original;
    }
    expect(container.querySelector('[data-page="conversation"]')).toBeTruthy();
    expect(hits[0]).toBe('appearance.liveActivityFoldDelaySec');
    expect(
      container
        .querySelector('[data-settings-row="appearance.liveActivityFoldDelaySec"]')
        ?.getAttribute('data-settings-flash')
    ).toBe('true');
  });

  it('设置视图卸载后不再追着深链行滚动', async () => {
    const hits: string[] = [];
    const proto = Object.getPrototypeOf(container) as { scrollIntoView?: unknown };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      hits.push(this.getAttribute('data-settings-row') ?? '');
    };
    try {
      await act(async () =>
        root.render(<Settings link={{ category: 'logs', rowId: 'logs.row' }} linkSeq={1} />)
      );
      expect(hits).toEqual(['logs.row']);
      await act(async () => root.render(<div data-settings-row="logs.row" />));
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(hits).toEqual(['logs.row']);
    } finally {
      proto.scrollIntoView = original;
    }
  });

  it('导航搜索框用设置 kit，整个设置视图没有带框容器', async () => {
    await act(async () => root.render(<Settings />));
    const nav = container.querySelector('[data-enso="settings-nav"]') as HTMLElement;
    expect(nav.querySelector('[data-slot="input-group"] input')?.getAttribute('aria-label')).toBe(
      'Search settings'
    );
    expect(findNestedBoxes(container)).toEqual([]);
  });

  it('导航列表有自己的滚动容器，不在内容滚动容器里', async () => {
    await act(async () => root.render(<Settings />));
    const navList = container.querySelector('[data-enso="settings-nav"] .overflow-y-auto');
    expect(navList).toBeTruthy();
    expect(scroller().contains(navList)).toBe(false);
    expect(navList?.contains(scroller())).toBe(false);
  });

  it('窄屏：返回列表再进另一个分区从顶部开始，回到原分区恢复', async () => {
    harness.mobile = true;
    await act(async () => root.render(<Settings />));
    await open('General');
    await scrollTo(300);
    const back = () => container.querySelector('[data-enso="settings-detail-back"]') as HTMLElement;
    await act(async () => back().click());
    await open('Logs');
    expect(container.querySelector('[data-page="logs"]')).toBeTruthy();
    expect(top()).toBe(0);
    await act(async () => back().click());
    await open('General');
    expect(top()).toBe(300);
  });
});

describe('侧栏导航可拖宽', () => {
  const handle = () =>
    container.querySelector(
      '[data-enso="settings-nav-resize"] .cursor-col-resize'
    ) as HTMLElement | null;
  const mouse = (target: EventTarget, type: string, clientX: number) => {
    const ev = new doc.defaultView!.Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, { clientX, button: 0 });
    target.dispatchEvent(ev);
  };

  it('导航宽度用工作区侧栏的宽度，拖手柄把位移交给同一个改宽回调', async () => {
    const resize = vi.fn();
    await act(async () => root.render(<Settings onNavResize={resize} />));
    const nav = container.querySelector('[data-enso="settings-nav"]') as HTMLElement;
    expect(nav.style.width).toBe('260px');
    expect(handle(), 'resize handle').toBeTruthy();
    await act(async () => {
      mouse(handle() as HTMLElement, 'mousedown', 100);
      mouse(doc, 'mousemove', 130);
      mouse(doc, 'mousemove', 120);
      mouse(doc, 'mouseup', 120);
    });
    expect(resize.mock.calls.map((c) => c[0])).toEqual([30, -10]);
  });

  it('窄屏没有拖拽手柄', async () => {
    harness.mobile = true;
    await act(async () => root.render(<Settings onNavResize={vi.fn()} />));
    expect(handle()).toBeNull();
  });
});
