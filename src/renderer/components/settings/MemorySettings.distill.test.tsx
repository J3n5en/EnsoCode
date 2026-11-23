import type { DistillableSessionDto, DistillJobDto, MemoryJobsSnapshot } from '@shared/memory/dto';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySettings } from './MemorySettings';

vi.mock('@/i18n', async () => {
  const { translate } = await import('@shared/i18n');
  return {
    useI18n: () => ({
      t: (key: string, params?: Record<string, string | number>) => translate('zh', key, params),
    }),
  };
});

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      disabledBuiltinTools: [],
      providers: [],
      memoryEmbeddingModel: 'local:potion-multilingual-128M',
      memoryChatModel: 'remote',
      memoryModelIdleMinutes: 10,
      memoryDistillWindowMinutes: 5,
      memoryDecayEnabled: false,
    }),
}));

vi.mock('@/components/chat/ModelPicker', () => ({
  MODEL_PICKER_FORM_TRIGGER_CLASS: 'form-trigger',
  ModelPicker: () => null,
}));

const session: DistillableSessionDto = {
  sessionId: 's1',
  title: 'Fix the retry loop',
  projectId: 'p1',
  projectName: 'enso-code',
  distilled: false,
  updatedAt: '2025-02-01T00:00:00.000Z',
};

function job(id: number, status: DistillJobDto['status'], sessionId = 's1'): DistillJobDto {
  return {
    id,
    sessionId,
    projectId: 'p1',
    status,
    attempts: status === 'pending' ? 1 : 0,
    total: 0,
    done: 0,
    failed: 0,
    error: status === 'pending' ? 'distill failed: timeout' : null,
    notes: [],
    createdAt: '2025-02-01T00:00:00.000Z',
    updatedAt: '2025-02-01T00:00:00.000Z',
  };
}

let jobs: MemoryJobsSnapshot;
let root: Root | undefined;
let container: HTMLElement;
const distillSession = vi.fn();

beforeEach(() => {
  jobs = { distill: [], kg: [], reembed: null, kgFailed: 0 };
  distillSession.mockReset();
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(dom.window, {
    electronAPI: {
      memory: {
        stats: async () => null,
        jobs: async () => jobs,
        models: async () => [],
        chatModels: async () => [],
        onModelProgress: () => () => {},
        onChatModelProgress: () => () => {},
        onChanged: () => () => {},
        distillableSessions: async () => [session],
        distillSession,
      },
    },
    setInterval: () => 0,
    clearInterval: () => {},
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = dom.document.getElementById('root') as unknown as HTMLElement;
});

afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
});

async function mount() {
  root = createRoot(container);
  await act(async () => root?.render(<MemorySettings />));
}

async function unmount() {
  if (root) await act(async () => root?.unmount());
  root = undefined;
}

function distillAllButton() {
  return container.querySelector(
    '[data-settings-row="memory.distillSessions"] h3 + button'
  ) as HTMLButtonElement | null;
}

describe('MemorySettings 提炼按钮状态', () => {
  it('任务快照里有进行中的提炼时，挂载即显示「提炼中」并禁用', async () => {
    jobs = { ...jobs, distill: [job(1, 'running')] };
    await mount();
    expect(distillAllButton()?.textContent).toBe('提炼中…');
    expect(distillAllButton()?.disabled).toBe(true);
  });

  it('没有进行中的提炼时显示「全部提炼」', async () => {
    jobs = { ...jobs, distill: [job(1, 'done'), job(2, 'cancelled')] };
    await mount();
    expect(distillAllButton()?.textContent).toBe('全部提炼（1）');
    expect(distillAllButton()?.disabled).toBe(false);
  });

  it('暂时失败停在 pending 的任务不算进行中，按钮不会卡住', async () => {
    jobs = { ...jobs, distill: [job(1, 'pending')] };
    await mount();
    expect(distillAllButton()?.textContent).toBe('全部提炼（1）');
  });

  it('多条提炼并行时仍显示「提炼中」', async () => {
    jobs = { ...jobs, distill: [job(1, 'running', 's1'), job(2, 'running', 's2')] };
    await mount();
    expect(distillAllButton()?.textContent).toBe('提炼中…');
  });

  it('点击后在任务快照跟上之前也立即显示「提炼中」', async () => {
    distillSession.mockReturnValue(new Promise(() => {}));
    await mount();
    await act(async () => distillAllButton()?.click());
    expect(distillSession).toHaveBeenCalledWith('s1', false);
    expect(distillAllButton()?.textContent).toBe('提炼中…');
  });

  it('切走页面再回来，按钮状态从任务快照恢复', async () => {
    distillSession.mockReturnValue(new Promise(() => {}));
    await mount();
    await act(async () => distillAllButton()?.click());
    jobs = { ...jobs, distill: [job(1, 'running')] };

    await unmount();
    await mount();

    expect(distillAllButton()?.textContent).toBe('提炼中…');
    expect(distillAllButton()?.disabled).toBe(true);
  });
});
