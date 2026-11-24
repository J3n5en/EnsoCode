import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('@/components/app/WindowChrome', () => ({
  ChromeRow: () => null,
  useShellChrome: () => null,
  useWindowChromeKind: () => 'mac',
}));
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
    await act(async () => root.render(<SettingsContent />));
    await scrollTo(300);
    await open('Logs');
    expect(container.querySelector('[data-page="logs"]')).toBeTruthy();
    expect(top()).toBe(0);
  });

  it('切回来恢复各自上次离开时的位置', async () => {
    await act(async () => root.render(<SettingsContent />));
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
    await act(async () => root.render(<SettingsContent />));
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
        root.render(<SettingsContent link={{ category: 'logs', rowId: 'logs.row' }} linkSeq={1} />)
      );
    } finally {
      proto.scrollIntoView = original;
    }
    expect(container.querySelector('[data-page="logs"]')).toBeTruthy();
    expect(hits).toEqual(['logs.row']);
    expect(top()).toBe(42);
  });

  it('导航列表有自己的滚动容器，不在内容滚动容器里', async () => {
    await act(async () => root.render(<SettingsContent />));
    const navList = container.querySelector('[data-enso="settings-nav"] .overflow-y-auto');
    expect(navList).toBeTruthy();
    expect(scroller().contains(navList)).toBe(false);
    expect(navList?.contains(scroller())).toBe(false);
  });

  it('窄屏：返回列表再进另一个分区从顶部开始，回到原分区恢复', async () => {
    harness.mobile = true;
    await act(async () => root.render(<SettingsContent />));
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
