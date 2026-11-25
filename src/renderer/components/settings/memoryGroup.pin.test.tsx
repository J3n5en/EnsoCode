import type {
  ChatModelDto,
  DistillableSessionDto,
  EmbeddingModelDto,
  MemoryJobsSnapshot,
  MemoryListItem,
  MemoryStats,
  PendingEvolvesReviewDto,
  PendingMemoryWriteDto,
} from '@shared/memory/dto';
import type { InstructionEntry } from '@shared/types';
import { act } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { findNestedBoxes } from './kit/boxes';
import { setupPin } from './pin.testUtils';

/**
 * 迁移时只改这里：分区 → 页面组件。import 顶层并行发起：顺序瀑布在高负载下要
 * 十几秒，会撑爆 beforeAll 的 10s 超时；顶层 await 属于模块求值，不进钩子计时。
 */
const MEMORY_GROUP_PAGES = await (async () => {
  const [{ MemorySettings }, { MemoryKnowledge }, { MemoryLibrary }, { InstructionsSettings }] =
    await Promise.all([
      import('./MemorySettings'),
      import('./MemoryKnowledge'),
      import('./MemoryLibrary'),
      import('./InstructionsSettings'),
    ]);
  return {
    memory: MemorySettings,
    memoryKnowledge: MemoryKnowledge,
    memoryLibrary: MemoryLibrary,
    instructions: InstructionsSettings,
  };
})();

const STATS: MemoryStats = {
  total: 4,
  bySpace: { global: 3, 'proj:p1': 1 },
  spaceLabels: { global: 'Global', 'proj:p1': 'enso' },
  spaceKinds: { global: 'global', 'proj:p1': 'project' },
  crystals: 1,
  entities: 5,
  embedded: 2,
  databaseBytes: 4096,
  neverHit: 1,
  addedLast7Days: 2,
  embeddingError: 'model missing',
  forgetting: {
    lastRunAt: null,
    candidates: 2,
    lastRun: null,
  } as unknown as MemoryStats['forgetting'],
};

const EMBEDDING: EmbeddingModelDto[] = [
  {
    id: 'local:qwen3-0.6b-gguf',
    runtime: 'gguf',
    dim: 1024,
    approxBytes: 600_000_000,
    downloadedBytes: 0,
    state: 'missing',
    downloadable: true,
  },
];

const CHAT: ChatModelDto[] = [
  {
    id: 'remote',
    label: 'Remote',
    params: '',
    contextSize: 0,
    approxBytes: 0,
    downloadedBytes: 0,
    state: 'ready',
    downloadable: false,
  },
  {
    id: 'local:gemma',
    label: 'Gemma',
    params: '1B',
    contextSize: 8192,
    approxBytes: 1_000_000_000,
    downloadedBytes: 0,
    state: 'missing',
    downloadable: true,
  },
];

const SESSION: DistillableSessionDto = {
  sessionId: 's1',
  title: 'Fix retry',
  projectId: 'p1',
  projectName: 'enso',
  distilled: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const JOBS: MemoryJobsSnapshot = {
  distill: [
    {
      id: 1,
      sessionId: 's1',
      projectId: 'p1',
      status: 'done',
      attempts: 0,
      total: 1,
      done: 1,
      failed: 0,
      error: null,
      notes: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  kg: [],
  reembed: null,
  kgFailed: 0,
};

const item = (id: string, title: string): MemoryListItem => ({
  id,
  title,
  contentSummary: `${title} summary`,
  unitType: 'fact',
  spaceId: 'global',
  spaceLabel: 'Global',
  importance: 0.7,
  isCrystal: false,
  isLatest: true,
  lifecycleState: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  appearances: 3,
  lastHitAt: null,
  hitCount: 3,
  archiveCandidateAt: null,
});

const REVIEW: PendingEvolvesReviewDto = {
  edge: {
    id: 'e1',
    olderId: 'm1',
    newerId: 'm2',
    relation: 'challenges',
    confidence: 0.8,
    reason: 'disagree',
    reviewState: 'pending',
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  older: item('m1', 'Older'),
  newer: item('m2', 'Newer'),
};

const WRITE: PendingMemoryWriteDto = {
  id: 'w1',
  kind: 'capture',
  spaceId: 'global',
  spaceLabel: 'Global',
  originLabel: 'Bot',
  title: 'Pending',
  content: 'pending content',
  botId: 'b1',
  chatId: null,
  redacted: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const INSTRUCTIONS: InstructionEntry[] = [
  {
    id: 'i1',
    name: 'CLAUDE.md',
    source: 'Claude Code',
    sourcePath: '/tmp/CLAUDE.md',
    local: false,
    bytes: 2048,
    enabled: true,
  },
  { id: 'i2', name: 'Team rules', source: 'Manual', local: true, bytes: 100, enabled: false },
];

const CONFIG: Parameters<typeof setupPin>[0] = {
  pages: () => MEMORY_GROUP_PAGES,
  results: {
    'electronAPI.memory.stats': STATS,
    'electronAPI.memory.jobs': JOBS,
    'electronAPI.memory.models': EMBEDDING,
    'electronAPI.memory.chatModels': CHAT,
    'electronAPI.memory.distillableSessions': [SESSION],
    'electronAPI.memory.graph': { nodes: [], edges: [], totalEntities: 0 },
    'electronAPI.memory.tree': [
      {
        id: 'g1',
        label: 'fact',
        count: 2,
        children: [{ id: 'c1', label: 'Older', memoryId: 'm1', isCrystal: false }],
      },
    ],
    'electronAPI.memory.list': { items: [item('m1', 'Older'), item('m2', 'Newer')], total: 2 },
    'electronAPI.memory.evolvesPending': [REVIEW],
    'electronAPI.memory.pendingWrites': [WRITE],
    'electronAPI.assets.instructionOccupancy': [],
    'electronAPI.sourceAuthority.read': { projects: [], conversations: [] },
  },
};

describe('记忆与指令组设置迁移前后行为一致', () => {
  const pin = setupPin(CONFIG);

  it('每页都渲染出来了', () => {
    const empty = [...pin.container.querySelectorAll('[data-pin-page]')]
      .filter((page) => (page.textContent ?? '').trim() === '')
      .map((page) => page.getAttribute('data-pin-page'));
    expect(empty).toEqual([]);
  });

  it('深链行 id 一个不少', () => {
    expect(pin.rows()).toMatchSnapshot();
  });

  it('每个控件的当前值（默认值）与读写的 store key / electronAPI 调用不变', async () => {
    expect(await pin.probe()).toMatchSnapshot();
  }, 30_000);
});

describe('启用记忆、有指令文件、打开提炼与遗忘、换成本地提炼模型后同样不变', () => {
  const pin = setupPin(CONFIG);
  beforeAll(async () => {
    await act(async () =>
      pin.store.setState({
        disabledBuiltinTools: [],
        instructions: INSTRUCTIONS,
        memoryDistillEnabled: true,
        memoryDecayEnabled: true,
        memoryDecayArchiveCandidates: true,
        memoryChatModel: 'local:gemma',
      })
    );
    await pin.settle();
  });

  it('深链行 id 一个不少', () => {
    expect(pin.rows()).toMatchSnapshot();
  });

  it('渲染出的页面里没有卡片套卡片', () => {
    const boxes = findNestedBoxes(pin.container).map(
      (el) => `${el.tagName.toLowerCase()}.${el.getAttribute('class')}`
    );
    expect(boxes).toEqual([]);
  });

  it('每个控件的当前值与读写的 store key / electronAPI 调用不变', async () => {
    expect(await pin.probe()).toMatchSnapshot();
  }, 30_000);
});
