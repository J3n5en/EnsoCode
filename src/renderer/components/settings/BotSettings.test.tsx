import { getTranslation } from '@shared/i18n';
import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotSettings } from './BotSettings';

const harness = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  setBotDiscussModeEnabled: vi.fn(),
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(harness.state),
}));
vi.mock('@/stores/oauthCredentials', () => ({
  usableProvidersForOauthSnapshot: () => [],
  usableClassifierProvidersForOauthSnapshot: () => [],
  useOauthCredentialStore: (selector: (state: unknown) => unknown) =>
    selector({ snapshot: { revision: 0, availability: { status: 'ready' } } }),
}));
vi.mock('@/components/chat/ModelPicker', () => ({
  MODEL_PICKER_FORM_TRIGGER_CLASS: '',
  ModelPicker: () => null,
}));
vi.mock('@/components/ui/select', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: Wrap,
    SelectTrigger: Wrap,
    SelectValue: () => null,
    SelectPopup: Wrap,
    SelectItem: Wrap,
  };
});
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <button
      type="button"
      data-switch={checked ? 'on' : 'off'}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));
vi.mock('./VirtualModelsSettings', () => ({
  ClassifierSourceField: ({
    description,
    timeoutHint,
  }: {
    description: string;
    timeoutHint: string;
  }) => (
    <div>
      <p data-classifier-description>{description}</p>
      <p data-classifier-timeout-hint>{timeoutHint}</p>
    </div>
  ),
}));

const DISCUSS_ROW = 'data-settings-row="bots.discussMode"';
const OLD_DESCRIPTION = 'Falls back to the group owner on timeout, error or an unclear answer.';
const OLD_TIMEOUT_HINT = 'Handed to the group owner on timeout.';
const NEW_DESCRIPTION =
  'First pick: the group owner replies on timeout, error or an unclear answer. During a discussion, picking the next speaker ends the discussion in these cases.';
const NEW_TIMEOUT_HINT =
  'First pick: handed to the group owner on timeout. Next speaker in a discussion: the discussion ends on timeout.';

beforeEach(() => {
  harness.setBotDiscussModeEnabled.mockClear();
  harness.state = {
    providers: [],
    botModeEnabled: true,
    botDiscussModeEnabled: false,
    setBotDiscussModeEnabled: harness.setBotDiscussModeEnabled,
    botRouteClassifier: { source: 'pi-classifier', timeoutMs: 3000 },
    botAssistantModel: null,
    botMaxRunningTurns: 1,
  };
});

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('BotSettings 讨论模式开关', () => {
  it('Bot 模式关闭时不显示讨论模式开关', () => {
    harness.state.botModeEnabled = false;
    const markup = renderToStaticMarkup(<BotSettings />);
    expect(markup).not.toContain(DISCUSS_ROW);
    expect(markup).not.toContain('Discussion mode');
  });

  it('Bot 模式打开时显示开关，并带实验性标记', () => {
    const markup = renderToStaticMarkup(<BotSettings />);
    expect(markup).toContain(DISCUSS_ROW);
    expect(markup).toContain('Discussion mode');
    expect(markup).toContain('data-experimental-badge');
    expect(markup).toContain('Experimental feature');
    expect(markup).toContain('data-switch="off"');
  });

  it('开关紧跟在群聊选人模型那一行之后', () => {
    const markup = renderToStaticMarkup(<BotSettings />);
    const classifier = markup.indexOf('data-settings-row="bots.routeClassifier"');
    const discuss = markup.indexOf(DISCUSS_ROW);
    const concurrency = markup.indexOf('data-settings-row="bots.maxRunningTurns"');
    expect(classifier).toBeGreaterThanOrEqual(0);
    expect(discuss).toBeGreaterThan(classifier);
    expect(concurrency).toBeGreaterThan(discuss);
  });

  it.each([
    [false, true],
    [true, false],
  ])('当前为 %s 时点击开关调用 setter(%s)', async (current, next) => {
    harness.state.botDiscussModeEnabled = current;
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = dom.document.getElementById('root');
    if (!container) throw new Error('Missing test root');
    root = createRoot(container);
    await act(async () => root?.render(<BotSettings />));
    const button = container.querySelector(
      '[data-settings-row="bots.discussMode"] [data-switch]'
    ) as unknown as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(harness.setBotDiscussModeEnabled).toHaveBeenCalledTimes(1);
    expect(harness.setBotDiscussModeEnabled).toHaveBeenCalledWith(next);
  });

  it('讨论模式关闭时选人超时说明是旧文案', () => {
    const markup = renderToStaticMarkup(<BotSettings />);
    expect(markup).toContain(OLD_DESCRIPTION);
    expect(markup).toContain(OLD_TIMEOUT_HINT);
    expect(markup).not.toContain(NEW_DESCRIPTION);
    expect(markup).not.toContain(NEW_TIMEOUT_HINT);
  });

  it('讨论模式打开时选人超时说明是新文案', () => {
    harness.state.botDiscussModeEnabled = true;
    const markup = renderToStaticMarkup(<BotSettings />);
    expect(markup).toContain(NEW_DESCRIPTION);
    expect(markup).toContain(NEW_TIMEOUT_HINT);
    expect(markup).not.toContain(OLD_DESCRIPTION);
    expect(markup).not.toContain(OLD_TIMEOUT_HINT);
  });
});

describe('讨论模式相关词条', () => {
  it('恢复 52bc878f 之前的旧中文文案', () => {
    expect(getTranslation('zh', OLD_DESCRIPTION)).toBe('超时、出错或回答不明确时由群主回复。');
    expect(getTranslation('zh', OLD_TIMEOUT_HINT)).toBe('超时就交给群主处理。');
  });

  it('开关标题、实验性标记和说明都有中文', () => {
    for (const key of [
      'Discussion mode',
      'Experimental feature',
      'Off: group chats work the same as the stable release. On: in smart-routing groups, discussion-style messages let the judge model pick who speaks next.',
    ]) {
      expect(getTranslation('en', key)).toBe(key);
      expect(getTranslation('zh', key), key).not.toBe(key);
    }
  });
});
