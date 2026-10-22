import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const xtermHarness = vi.hoisted(() => ({
  initialOptions: [] as Array<{ fontFamily?: string; [key: string]: unknown }>,
  instances: [] as Array<{ options: { fontFamily?: string; [key: string]: unknown } }>,
}));

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: { fontFamily?: string; [key: string]: unknown };
    unicode = { activeVersion: '' };
    parser = { registerOscHandler: vi.fn() };

    constructor(options: { fontFamily?: string; [key: string]: unknown } = {}) {
      this.options = { ...options };
      xtermHarness.initialOptions.push(options);
      xtermHarness.instances.push(this);
    }

    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }));
  }

  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => ({ FitAddon: createAddonMock() }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: createAddonMock() }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: createAddonMock() }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: createAddonMock() }));
vi.mock('@/lib/terminalTitle', () => ({ tabTitleFromTerminal: vi.fn(() => '') }));

function createAddonMock() {
  return vi.fn(function MockAddon() {
    return new Proxy(
      {},
      {
        get: (_target, property) => (property === 'then' ? undefined : vi.fn()),
      }
    );
  });
}

const registeredIds: string[] = [];
let releaseTerminal: ((termId: string) => void) | undefined;

async function loadTerminalRegistry() {
  vi.resetModules();
  const registry = await import('./terminalRegistry');
  releaseTerminal = registry.releaseTerminal;
  return registry;
}

function installRendererGlobals() {
  const { document, window } = parseHTML('<html><body></body></html>');
  Object.assign(window, {
    electronAPI: {
      terminal: {
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
      },
    },
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
}

describe('terminalRegistry font fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    xtermHarness.initialOptions.length = 0;
    xtermHarness.instances.length = 0;
    registeredIds.length = 0;
    releaseTerminal = undefined;
    installRendererGlobals();
  });

  afterEach(() => {
    for (const termId of registeredIds) releaseTerminal?.(termId);
    vi.unstubAllGlobals();
  });

  it('创建 xterm 时保留用户选择的文字字体并加上符号字体回退', async () => {
    const { acquireTerminal } = await loadTerminalRegistry();
    const termId = 'font-fallback-create';
    const userFontFamily = '"Fira Code"';
    registeredIds.push(termId);

    acquireTerminal(termId, { fontFamily: userFontFamily, fontSize: 14 });

    expect(xtermHarness.initialOptions).toHaveLength(1);
    expect(xtermHarness.initialOptions[0]?.fontFamily).toBe(
      `"Enso Nerd Symbols", ${userFontFamily}`
    );
  });

  it('更新已有 xterm 的字体时保留新选择的文字字体并加上符号字体回退', async () => {
    const { acquireTerminal, updateTerminalAppearance } = await loadTerminalRegistry();
    const termId = 'font-fallback-update';
    const initialFontFamily = '"Fira Code"';
    const updatedFontFamily = '"JetBrains Mono"';
    registeredIds.push(termId);
    const instance = acquireTerminal(termId, { fontFamily: initialFontFamily, fontSize: 14 });

    updateTerminalAppearance({}, updatedFontFamily, 16);

    expect(xtermHarness.instances).toHaveLength(1);
    expect(xtermHarness.instances[0]).toBe(instance.term);
    expect(instance.term.options.fontFamily).toBe(`"Enso Nerd Symbols", ${updatedFontFamily}`);
  });
});
