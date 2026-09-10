import type {
  DistillableSessionDto,
  EmbeddingModelDto,
  MemoryJobsSnapshot,
  MemoryStats,
} from '@shared/memory/dto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  embeddingErrorNotice,
  estimateRemainingMs,
  formatDuration,
  groupSessionsByProject,
  localChatBlocksDistill,
  MemorySettings,
  needsBulkPrompt,
} from './MemorySettings';

const harness = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  stats: null as MemoryStats | null,
  jobs: { distill: [], kg: [], reembed: null } as MemoryJobsSnapshot,
  models: [] as EmbeddingModelDto[],
  download: vi.fn(() => Promise.resolve(true)),
}));

function model(overrides: Partial<EmbeddingModelDto> = {}): EmbeddingModelDto {
  return {
    id: 'local:potion-multilingual-128M',
    runtime: 'model2vec',
    dim: 256,
    approxBytes: 531_000_000,
    downloadedBytes: 0,
    state: 'missing',
    downloadable: true,
    ...overrides,
  };
}

vi.mock('@/i18n', async () => {
  const { translate } = await import('@shared/i18n');
  return {
    useI18n: () => ({
      t: (key: string, params?: Record<string, string | number>) =>
        translate(harness.state.language === 'zh' ? 'zh' : 'en', key, params),
    }),
  };
});

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(harness.state),
}));

function setState(overrides: Record<string, unknown> = {}) {
  harness.state = {
    disabledBuiltinTools: [],
    toggleBuiltinTool: vi.fn(),
    providers: [{ id: 'p1', name: 'Provider One' }],
    memoryEmbeddingModel: 'local:potion-multilingual-128M',
    setMemoryEmbeddingModel: vi.fn(),
    memoryModelIdleMinutes: 10,
    setMemoryModelIdleMinutes: vi.fn(),
    memoryEmbeddingAutoDownload: false,
    setMemoryEmbeddingAutoDownload: vi.fn(),
    memoryEmbeddingRemoteProviderId: null,
    setMemoryEmbeddingRemoteProviderId: vi.fn(),
    memoryChatModel: 'remote',
    setMemoryChatModel: vi.fn(),
    memoryDistillEnabled: false,
    setMemoryDistillEnabled: vi.fn(),
    memoryKgEnabled: false,
    setMemoryKgEnabled: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  setState();
  harness.stats = null;
  harness.jobs = { distill: [], kg: [], reembed: null };
  harness.models = [model()];
  harness.download.mockClear();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        memory: {
          stats: () => Promise.resolve(harness.stats),
          jobs: () => Promise.resolve(harness.jobs),
          models: () => Promise.resolve(harness.models),
          chatModels: () => Promise.resolve([]),
          downloadChatModel: () => Promise.resolve(true),
          cancelChatModelDownload: () => Promise.resolve(true),
          deleteChatModel: () => Promise.resolve(true),
          onChatModelProgress: () => () => {},
          distillableSessions: () => Promise.resolve([]),
          distillSession: () => Promise.resolve(true),
          downloadModel: harness.download,
          cancelModelDownload: () => Promise.resolve(true),
          deleteModel: () => Promise.resolve(true),
          onModelProgress: () => () => {},
        },
      },
      setInterval: () => 0,
      clearInterval: () => {},
    },
  });
});

describe('embeddingErrorNotice', () => {
  const base: MemoryStats = {
    total: 2,
    bySpace: { global: 2 },
    spaceLabels: { global: 'Global' },
    crystals: 0,
    entities: 0,
    embedded: 0,
    databaseBytes: 1024,
  };

  it('surfaces the reason instead of silently showing 0/N', () => {
    // 整条 embedding 链路以前把错误全 catch 掉，表现成「0/2 + 点补齐没反应」而无从排查
    const reason = "input 'position_ids' is missing in 'feeds'";
    expect(embeddingErrorNotice({ ...base, embeddingError: reason })).toBe(reason);
  });

  it('stays quiet when there is no gap, no library, or no recorded reason', () => {
    expect(embeddingErrorNotice({ ...base, embedded: 2, embeddingError: 'x' })).toBeNull();
    expect(embeddingErrorNotice({ ...base, total: 0, embeddingError: 'x' })).toBeNull();
    expect(embeddingErrorNotice(base)).toBeNull();
    expect(embeddingErrorNotice(null)).toBeNull();
  });
});

describe('localChatBlocksDistill', () => {
  const gemma = {
    downloadable: true as const,
    state: 'missing' as const,
  };

  it('flags a selected local model that is not on disk', () => {
    expect(localChatBlocksDistill({ ...gemma, state: 'missing' })).toBe('missing');
    expect(localChatBlocksDistill({ ...gemma, state: 'downloading' })).toBe('downloading');
  });

  it('does not block remote or a ready local model', () => {
    expect(localChatBlocksDistill(null)).toBeNull();
    expect(localChatBlocksDistill({ downloadable: false, state: 'ready' })).toBeNull();
    expect(localChatBlocksDistill({ ...gemma, state: 'ready' })).toBeNull();
  });
});

describe('needsBulkPrompt', () => {
  it('asks before a batch that would silently skip already-distilled sessions', () => {
    expect(needsBulkPrompt([{ distilled: false }, { distilled: false }])).toBe(false);
    expect(needsBulkPrompt([{ distilled: true }, { distilled: false }])).toBe(true);
    // 全部已提炼：也要问，否则按钮看上去没反应
    expect(needsBulkPrompt([{ distilled: true }])).toBe(true);
    expect(needsBulkPrompt([])).toBe(false);
  });
});

describe('estimateRemainingMs', () => {
  it('refuses to guess before the first item finishes', () => {
    expect(estimateRemainingMs({ done: 0, total: 5, startedAt: 0 }, 10_000)).toBeNull();
  });

  it('extrapolates from real elapsed time, and stops at the last item', () => {
    // 2 个用了 20s → 每个 10s，剩 3 个 → 30s
    expect(estimateRemainingMs({ done: 2, total: 5, startedAt: 0 }, 20_000)).toBe(30_000);
    expect(estimateRemainingMs({ done: 5, total: 5, startedAt: 0 }, 50_000)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('never shows 0s and keeps minutes readable', () => {
    expect(formatDuration(200)).toBe('1s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(150_000)).toBe('2m 30s');
  });
});

describe('groupSessionsByProject', () => {
  const session = (over: Partial<DistillableSessionDto>): DistillableSessionDto => ({
    sessionId: 's1',
    title: 'Fix the retry loop',
    projectId: 'p1',
    projectName: 'enso-code',
    distilled: false,
    updatedAt: '2025-02-01T00:00:00.000Z',
    ...over,
  });

  it('groups by project and keeps project names, not raw ids', () => {
    const groups = groupSessionsByProject([
      session({ sessionId: 'a', projectId: 'p1', projectName: 'enso-code' }),
      session({ sessionId: 'b', projectId: 'p2', projectName: 'other-app' }),
      session({ sessionId: 'c', projectId: 'p1', projectName: 'enso-code' }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['enso-code', 'other-app']);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['a', 'c']);
  });

  it('sinks project-less sessions to the last group', () => {
    const groups = groupSessionsByProject([
      session({ sessionId: 'x', projectId: null, projectName: null }),
      session({ sessionId: 'y', projectId: 'p1', projectName: 'enso-code' }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['enso-code', 'No project']);
  });

  it('preserves the incoming order inside a group (main sorts by mtime)', () => {
    const groups = groupSessionsByProject([
      session({ sessionId: 'new', updatedAt: '2025-03-01T00:00:00.000Z' }),
      session({ sessionId: 'old', updatedAt: '2024-01-01T00:00:00.000Z' }),
    ]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['new', 'old']);
  });
});

describe('MemorySettings', () => {
  it.each([
    [5, '5 min', '5 分钟'],
    [10, '10 min', '10 分钟'],
    [30, '30 min', '30 分钟'],
    [0, 'Never', '永不'],
  ])('空闲卸载 %i 的选中值显示中英文标签而非原始数字', (minutes, en, zh) => {
    setState({ memoryModelIdleMinutes: minutes });
    expect(renderToStaticMarkup(createElement(MemorySettings))).toContain(`>${en}</span>`);
    setState({ memoryModelIdleMinutes: minutes, language: 'zh' });
    const html = renderToStaticMarkup(createElement(MemorySettings));
    expect(html).toContain(`>${zh}</span>`);
    expect(html).toContain('空闲自动卸载');
    expect(html).toContain('空闲达到此时长后释放本地模型内存，下次需要时会自动加载。');
  });

  it('显示空闲自动卸载和下次自动加载的说明', () => {
    const html = renderToStaticMarkup(createElement(MemorySettings));
    expect(html).toContain('data-settings-row="memory.modelIdleMinutes"');
    expect(html).toContain('Unload automatically when idle');
    expect(html).toContain(
      'Release local model memory after this idle period. Models load automatically the next time they are needed.'
    );
  });

  it('does not carry its own enable switch', () => {
    // 这一页本身只在 memory 工具启用后才出现（见 settingsCategories）。
    // 页内再放一个「关闭我自己」的开关，点下去整页消失，旁边的说明也永远看不到。
    const html = renderToStaticMarkup(createElement(MemorySettings));
    expect(html).not.toContain('Enable memory tools');
    expect(html).toContain('Turn memory off in Built-in tools.');
  });

  it('states the real automatic trigger, not just "session ended"', () => {
    // 空闲 30 分钟被回收也会触发（sessionEviction.IDLE_SESSION_TTL_MS），
    // 写成「会话结束后」会让用户以为必须手动结束才跑
    const html = renderToStaticMarkup(createElement(MemorySettings));
    expect(html).toContain('idle for 30 minutes');
  });

  it('renders the capability switches and the download warning', () => {
    const html = renderToStaticMarkup(createElement(MemorySettings));
    expect(html).toContain('Distill sessions automatically');
    expect(html).toContain('Extract entities');
    // 体积由模型清单那行动态显示；描述里不再硬编码某个数字（换模型就会对不上）
    expect(html).not.toContain('512MB');
    expect(html).toContain('only fetched when you press Download');
  });

  it('hides the provider picker unless the remote model is selected', () => {
    expect(renderToStaticMarkup(createElement(MemorySettings))).not.toContain('Embedding provider');
    setState({ memoryEmbeddingModel: 'remote:openai-compatible' });
    const html = renderToStaticMarkup(createElement(MemorySettings));
    expect(html).toContain('Embedding provider');
    expect(html).toContain('data-settings-row="memory.remoteProvider"');
    expect(html).toContain('Credentials stay in the main process');
  });

  it('never silently downloads: the model list drives an explicit download row', () => {
    // 模型清单来自 Main 注册表，不是渲染层手写副本；未下载时必须给出下载入口而不是只靠自动下载开关
    expect(harness.download).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(createElement(MemorySettings));
    // 模型列表尚未回来时不能凭空声称模型已就绪
    expect(html).not.toContain('Model downloaded');
  });

  it('reports an empty library and no running tasks before anything is stored', () => {
    const html = renderToStaticMarkup(createElement(MemorySettings));
    expect(html).toContain('No memories stored yet.');
    expect(html).toContain('Nothing running.');
  });
});
