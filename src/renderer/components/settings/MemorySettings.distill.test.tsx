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

vi.mock('@/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogClose: ({
      render,
      children,
    }: {
      render?: React.ReactElement;
      children?: React.ReactNode;
    }) => (render ? <div>{children}</div> : <button type="button">{children}</button>),
    DialogContent: Wrap,
    DialogDescription: Wrap,
    DialogFooter: Wrap,
    DialogHeader: Wrap,
    DialogPanel: Wrap,
    DialogTitle: Wrap,
  };
});

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
let sessionsList: DistillableSessionDto[];
let jobsFn: () => Promise<MemoryJobsSnapshot>;
let onChangedListener: (() => void) | null;
let root: Root | undefined;
let container: HTMLElement;
const distillSession = vi.fn();

beforeEach(() => {
  jobs = { distill: [], kg: [], reembed: null, kgFailed: 0 };
  sessionsList = [session];
  jobsFn = async () => jobs;
  onChangedListener = null;
  distillSession.mockReset();
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(dom.window, {
    electronAPI: {
      memory: {
        stats: async () => null,
        jobs: () => jobsFn(),
        models: async () => [],
        chatModels: async () => [],
        onModelProgress: () => () => {},
        onChatModelProgress: () => () => {},
        onChanged: (cb: () => void) => {
          onChangedListener = cb;
          return () => {
            if (onChangedListener === cb) onChangedListener = null;
          };
        },
        distillableSessions: async () => sessionsList,
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

  it('切回页面后首个任务快照返回前禁用按钮，防止竞态重复触发', async () => {
    let resolveJobs!: (snapshot: MemoryJobsSnapshot) => void;
    jobsFn = () =>
      new Promise<MemoryJobsSnapshot>((resolve) => {
        resolveJobs = resolve;
      });
    await mount();
    expect(distillAllButton()?.disabled).toBe(true);
    await act(async () => distillAllButton()?.click());
    expect(distillSession).not.toHaveBeenCalled();

    await act(async () => {
      resolveJobs({ ...jobs, distill: [job(1, 'running')] });
    });
    expect(distillAllButton()?.textContent).toBe('提炼中…');
    expect(distillAllButton()?.disabled).toBe(true);
  });

  it('快速连点不会重复触发 distillSession', async () => {
    distillSession.mockReturnValue(new Promise(() => {}));
    await mount();
    const btn = distillAllButton();
    await act(async () => {
      btn?.click();
      btn?.click();
    });
    expect(distillSession).toHaveBeenCalledTimes(1);
  });

  it('批量确认弹窗打开期间另一端进入 running，确认按钮禁用且不会重复触发', async () => {
    sessionsList = [session, { ...session, sessionId: 's2', distilled: true }];
    await mount();
    await act(async () => distillAllButton()?.click());
    jobs = { ...jobs, distill: [job(1, 'running')] };
    await act(async () => {
      onChangedListener?.();
    });
    const buttons = [...container.querySelectorAll('button')];
    const remainingBtn = buttons.find((b) => b.textContent?.includes('只提炼剩下的')) as
      | HTMLButtonElement
      | undefined;
    const redistillBtn = buttons.find((b) => b.textContent?.includes('重新提炼全部')) as
      | HTMLButtonElement
      | undefined;
    expect(remainingBtn?.disabled).toBe(true);
    expect(redistillBtn?.disabled).toBe(true);
    await act(async () => {
      remainingBtn?.click();
      redistillBtn?.click();
    });
    expect(distillSession).not.toHaveBeenCalled();
  });

  it('distillSession 失败（如服务崩溃/超时）后清理状态并重拉快照，不卡死按钮', async () => {
    const jobsSpy = vi.fn(async () => jobs);
    jobsFn = jobsSpy;
    distillSession.mockRejectedValueOnce(new Error('memory service exited'));
    await mount();
    const callsBefore = jobsSpy.mock.calls.length;
    await act(async () => distillAllButton()?.click());
    expect(distillAllButton()?.textContent).toBe('全部提炼（1）');
    expect(distillAllButton()?.disabled).toBe(false);
    expect(jobsSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('外部提炼完成触发 onChanged 后同步刷新可提炼会话列表', async () => {
    jobs = { ...jobs, distill: [job(1, 'running')] };
    await mount();
    expect(distillAllButton()?.textContent).toBe('提炼中…');

    jobs = { ...jobs, distill: [job(1, 'done')] };
    sessionsList = [{ ...session, distilled: true }];
    await act(async () => {
      onChangedListener?.();
    });
    expect(distillAllButton()).toBeNull();
  });

  it('中文界面下后台任务列表把排队中/进行中/已完成/失败翻译成中文，不展示英文 queued', async () => {
    jobs = {
      ...jobs,
      distill: [
        job(1, 'pending', 's1'),
        job(2, 'running', 's2'),
        { ...job(3, 'done', 's3'), done: 2 },
        { ...job(4, 'done', 's4'), error: 'network error' },
      ],
      reembed: {
        id: 9,
        target: 'local:embed',
        status: 'done',
        cursor: 3,
        total: 3,
        done: 2,
        failed: 1,
        error: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    };
    await mount();
    const jobsSection = container.querySelector('[data-settings-row="memory.jobs"]');
    expect(jobsSection?.textContent).toContain('排队中');
    expect(jobsSection?.textContent).toContain('进行中');
    expect(jobsSection?.textContent).toContain('已存 2 条');
    expect(jobsSection?.textContent).toContain('network error');
    expect(jobsSection?.textContent).toContain('已向量化 2 条 · 1 条失败');
    expect(jobsSection?.textContent).not.toContain('queued');
  });
});
