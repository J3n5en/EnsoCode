import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireModel, type LlamaModelLike } from './llama/runtime';
import * as embeddingDownloads from './memory/embedding/downloader';
import { writeTinyModel2Vec } from './memory/embedding/model2vec.fixture';
import { embeddingModelDirName, resolveEmbeddingModelSpec } from './memory/embedding/registry';
import type { EmbeddingModelSpec } from './memory/embedding/types';

const userData = mkdtempSync(path.join(tmpdir(), 'enso-memory-host-'));
const ipcHandlers = vi.hoisted(
  () => new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>()
);
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: { sender: { id: number } }, ...args: unknown[]) => unknown
    ) => ipcHandlers.set(channel, handler),
  },
}));
vi.mock('../windows/MainWindow', () => ({ isMainWebContents: (id: number) => id === 1 }));
vi.mock('../windows/SettingsWindow', () => ({ isSettingsWebContents: () => false }));
vi.mock('../ipc/settings', () => ({ readSettings: () => null }));
vi.mock('./chatModels', () => ({
  setChatModelProgressSink: vi.fn(),
  listChatModels: vi.fn(() => []),
  startChatModelDownload: vi.fn(async () => false),
  cancelChatModelDownload: vi.fn(() => false),
  deleteChatModel: vi.fn(() => false),
}));
vi.mock('./llama/runtime', () => ({ acquireModel: vi.fn() }));

import {
  awaitMemoryDistill,
  awaitMemoryKg,
  awaitMemoryReembed,
  closeMemoryDb,
  configureMemoryDistill,
  configureMemoryEmbedding,
  configureMemoryKg,
  distillSessionNow,
  getMemoryDistillJobs,
  getMemoryEmbedder,
  getMemoryEmbeddingError,
  getMemoryKgJobs,
  getMemoryReembedProgress,
  invokeMemory,
  memoryDatabase,
  refreshMemoryEmbedding,
  rootSessionId,
  scheduleMemoryDistill,
  setMemoryChangeListener,
  syncMemoryDistillFromSettings,
  syncMemoryEmbeddingFromSettings,
  syncMemoryKgFromSettings,
} from './memoryHost';

import {
  cancelEmbeddingModelDownload,
  deleteEmbeddingModel,
  listEmbeddingModels,
  setEmbeddingProgressSink,
  startEmbeddingModelDownload,
} from './memoryModels';

afterAll(() => {
  closeMemoryDb();
  rmSync(userData, { recursive: true, force: true });
});

describe('memoryHost 懒建', () => {
  it('未调用任何记忆操作（含退出关库）时不产生 memory/ 目录与 db/WAL 文件', () => {
    closeMemoryDb();
    expect(existsSync(path.join(userData, 'memory'))).toBe(false);
  });

  it('首次记忆操作才建库；关库后再调再开', async () => {
    await invokeMemory('search', { query: 'x', limit: 5, spaceId: 'global' }, null);
    const dir = path.join(userData, 'memory');
    expect(readdirSync(dir)).toContain('memory.db');
    closeMemoryDb();
    await expect(
      invokeMemory('search', { query: 'x', limit: 5, spaceId: 'global' }, null)
    ).resolves.toEqual({ results: [] });
  });
});

describe('memoryHost embedding 接线', () => {
  const capture = async (content: string) => {
    const r = (await invokeMemory(
      'capture',
      { content, importance: 0.6, spaceId: 'global' },
      null
    )) as { status: string; memory: { id: string } };
    return r.memory;
  };

  it('模型未下载且未开 autoDownload：落库无向量、不建 models/，检索纯 FTS 仍可用', async () => {
    closeMemoryDb();
    configureMemoryEmbedding({ modelId: 'local:potion-multilingual-128M', autoDownload: false });
    const memory = await capture('没有向量的记忆 alpha');
    expect(existsSync(path.join(userData, 'memory', 'models'))).toBe(false);
    const hits = (await invokeMemory(
      'search',
      { query: 'alpha', limit: 5, spaceId: 'global' },
      null
    )) as { results: { id: string }[] };
    expect(hits.results.map((r) => r.id)).toEqual([memory.id]);
  });

  it('模型就绪后：写入带向量，向量通道参与检索；`none` 关掉向量', async () => {
    closeMemoryDb();
    const spec = resolveEmbeddingModelSpec('local:potion-multilingual-128M') as EmbeddingModelSpec;
    const dir = path.join(userData, 'memory', 'models', embeddingModelDirName(spec));
    // 用合成小模型代替真权重：维度必须与注册表一致才会被接受
    // redis 与 cache 共用同一向量：查 cache 能命中正文只有 redis 的行，只可能来自向量通道
    const e0 = Array(256).fill(0);
    e0[0] = 1;
    const e1 = Array(256).fill(0);
    e1[1] = 1;
    writeTinyModel2Vec(dir, { tokens: ['redis', 'cache', 'kafka'], rows: [e0, e0, e1] });
    writeFileSync(path.join(dir, '.ready'), '{}');
    configureMemoryEmbedding({ modelId: spec.id, autoDownload: false });

    const memory = await capture('redis');
    const search = (q: string) =>
      invokeMemory('search', { query: q, limit: 5, spaceId: 'global' }, null) as Promise<{
        results: { id: string }[];
      }>;
    expect((await search('cache')).results.map((r) => r.id)).toEqual([memory.id]);
    expect((await search('kafka')).results).toEqual([]);

    // none：新写入无向量，查询也不走向量（cache 不再命中 redis），FTS 照常
    configureMemoryEmbedding({ modelId: 'none' });
    const other = await capture('kafka');
    expect((await search('cache')).results).toEqual([]);
    expect((await search('kafka')).results.map((r) => r.id)).toEqual([other.id]);
    // 切回真模型 id：旧向量仍可用；none 期间写的 kafka 行没向量，查同义词不命中
    configureMemoryEmbedding({ modelId: spec.id });
    expect((await search('cache')).results.map((r) => r.id)).toEqual([memory.id]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('memoryHost 滚动重嵌触发点（3b Major 2）', () => {
  it('先有记忆（无向量）→ 同一 modelId 下模型后来就绪 → 旧记忆自动拿到向量，不需要再切模型', async () => {
    closeMemoryDb();
    const spec = resolveEmbeddingModelSpec('local:potion-multilingual-128M') as EmbeddingModelSpec;
    const dir = path.join(userData, 'memory', 'models', embeddingModelDirName(spec));
    rmSync(dir, { recursive: true, force: true });
    configureMemoryEmbedding({ modelId: spec.id, autoDownload: false });
    const capture = (content: string) =>
      invokeMemory('capture', { content, importance: 0.6, spaceId: 'global' }, null) as Promise<{
        memory: { id: string };
      }>;
    const a = await capture('redis 旧记忆一');
    const b = await capture('redis 旧记忆二');
    await awaitMemoryReembed();
    // 模型未就绪：不建任务（库在本文件内共用，只能比对任务 id 未增长）
    const before = getMemoryReembedProgress()?.id ?? 0;

    // 模型“下载完成”：modelId 不变，只是文件就位
    const e0 = Array(256).fill(0);
    e0[0] = 1;
    writeTinyModel2Vec(dir, { tokens: ['redis', 'cache'], rows: [e0, e0] });
    writeFileSync(path.join(dir, '.ready'), '{}');
    // 下一次任意记忆操作让 embedder 首次就绪，就绪本身必须触发重嵌
    const search = () =>
      invokeMemory('search', { query: 'cache', limit: 5, spaceId: 'global' }, null) as Promise<{
        results: { id: string }[];
      }>;
    await search();
    await awaitMemoryReembed();
    // 库内还有前面测试留下的、小模型词表覆盖不到的行（嵌入为 null 计 failed），只断言任务跑过且结束
    const job = getMemoryReembedProgress();
    expect(job?.status).toBe('done');
    expect(job!.id).toBeGreaterThan(before);
    // 查询词不在正文里：命中只能来自新补的向量
    expect((await search()).results.map((r) => r.id)).toEqual(
      expect.arrayContaining([a.memory.id, b.memory.id])
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('memoryHost 会话结束蒸馏接线', () => {
  const messages = [
    { role: 'user' as const, text: 'We decided to use pnpm workspaces for the monorepo.' },
    { role: 'assistant' as const, text: 'Noted: pnpm workspaces it is.' },
  ];
  const llm = (content: string) => async () =>
    JSON.stringify({
      memories: [{ title: 't', content, importance: 0.8, confidence: 0.9, unit_type: 'decision' }],
    });
  const search = (q: string) =>
    invokeMemory('search', { query: q, limit: 10, spaceId: 'all' }, null) as Promise<{
      results: { id: string }[];
    }>;
  // search 结果不透出 source，直接查库验证写入来源
  const sourceOf = (id: string) => {
    const ro = new Database(path.join(userData, 'memory', 'memory.db'), { readonly: true });
    try {
      return (ro.prepare('SELECT source FROM memories WHERE id = ?').get(id) as { source: string })
        .source;
    } finally {
      ro.close();
    }
  };
  const payload = { sessionId: 'distill-s1', sessionFile: '/fake/s1.jsonl', projectId: null };

  it('开关关闭：不读会话、不建任务、不调 LLM', async () => {
    closeMemoryDb();
    configureMemoryEmbedding({ modelId: 'none' });
    const readTranscript = vi.fn(async () => messages);
    const complete = vi.fn(llm('pnpm workspaces chosen for monorepo'));
    configureMemoryDistill({ enabled: false, readTranscript, complete: () => complete });
    await scheduleMemoryDistill(payload);
    await awaitMemoryDistill();
    expect(readTranscript).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect((await search('pnpm')).results).toEqual([]);
  });

  it('memoryLanguage 真的进了模型收到的 system prompt，非法值回退英文', async () => {
    closeMemoryDb();
    configureMemoryEmbedding({ modelId: 'none' });
    const seen: string[] = [];
    const complete = vi.fn(async (system: string) => {
      seen.push(system);
      return JSON.stringify({
        memories: [
          { title: 't', content: 'redis chosen for cache', importance: 0.8, unit_type: 'decision' },
        ],
      });
    });
    const run = async (language: unknown, sessionId: string) => {
      syncMemoryDistillFromSettings({ memoryDistillEnabled: true, memoryLanguage: language });
      configureMemoryDistill({
        readTranscript: async () => [{ role: 'user' as const, text: 'we picked redis for cache' }],
        complete: () => complete,
      });
      await scheduleMemoryDistill({
        sessionId,
        sessionFile: `/fake/${sessionId}.jsonl`,
        projectId: null,
      });
      await awaitMemoryDistill();
    };
    await run('zh', 'lang-zh');
    expect(seen.at(-1)).toContain('Simplified Chinese');
    await run('klingon', 'lang-bad');
    expect(seen.at(-1)).toContain('in English');
    configureMemoryDistill({ enabled: false });
  });

  it('建任务后改语言，续跑旧任务不能被误判为「原文已变」而作废', async () => {
    // 指纹含语言；若续跑时用「当前」语言复算，改过语言后所有 pending 旧任务会全部 cancelled
    closeMemoryDb();
    configureMemoryEmbedding({ modelId: 'none' });
    const payload = { sessionId: 'resume-lang', sessionFile: '/fake/rl.jsonl', projectId: null };
    const transcript = [{ role: 'user' as const, text: 'we picked redis for cache' }];

    // 第一次：provider 不可用 → 任务留 pending
    syncMemoryDistillFromSettings({ memoryDistillEnabled: true, memoryLanguage: 'en' });
    configureMemoryDistill({ readTranscript: async () => transcript, complete: () => null });
    await distillSessionNow(payload);
    await awaitMemoryDistill();
    const pending = getMemoryDistillJobs().find((j) => j.payload.sessionId === payload.sessionId);
    expect(pending?.status).toBe('pending');

    // 改语言后重开库续跑：旧任务应按它自己的语言跑完，而不是被 cancelled
    const complete = vi.fn(async (system: string) => {
      expect(system).toContain('in English');
      return JSON.stringify({ memories: [{ title: 't', content: 'redis', importance: 0.8 }] });
    });
    closeMemoryDb();
    syncMemoryDistillFromSettings({ memoryDistillEnabled: true, memoryLanguage: 'zh' });
    configureMemoryDistill({
      readTranscript: async () => transcript,
      complete: () => complete,
    });
    await search('redis');
    await awaitMemoryDistill();
    expect(complete).toHaveBeenCalledTimes(1);
    const after = getMemoryDistillJobs().find((j) => j.payload.sessionId === payload.sessionId);
    expect(after?.status).toBe('done');
    expect(after?.error).toBeNull();
    configureMemoryDistill({ enabled: false });
  });

  it('改语言后同一会话会重新提炼（语言在指纹里），force 可强制重跑', async () => {
    closeMemoryDb();
    configureMemoryEmbedding({ modelId: 'none' });
    const seen: string[] = [];
    const complete = vi.fn(async (system: string) => {
      seen.push(system);
      return JSON.stringify({
        memories: [{ title: 't', content: `note ${seen.length}`, importance: 0.8 }],
      });
    });
    const payload = { sessionId: 'lang-flip', sessionFile: '/fake/lf.jsonl', projectId: null };
    const setLanguage = (language: string) => {
      syncMemoryDistillFromSettings({ memoryDistillEnabled: true, memoryLanguage: language });
      configureMemoryDistill({
        readTranscript: async () => [{ role: 'user' as const, text: 'we picked redis' }],
        complete: () => complete,
      });
    };

    setLanguage('en');
    expect(await distillSessionNow(payload)).toBe(true);
    await awaitMemoryDistill();
    // 同语言同内容：指纹命中，不重跑
    expect(await distillSessionNow(payload)).toBe(false);
    await awaitMemoryDistill();
    expect(complete).toHaveBeenCalledTimes(1);

    // 改成中文：指纹变了，必须重新跑一轮，否则用户改完语言什么也不会发生
    setLanguage('zh');
    expect(await distillSessionNow(payload)).toBe(true);
    await awaitMemoryDistill();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toContain('Simplified Chinese');

    // force：语言未变也重跑
    expect(await distillSessionNow(payload, { force: true })).toBe(true);
    await awaitMemoryDistill();
    expect(complete).toHaveBeenCalledTimes(3);
    configureMemoryDistill({ enabled: false });
  });

  it('手动提炼绕过自动开关：关掉开关也能补历史会话，且同内容不重复跑', async () => {
    // 自动开关只管「会话结束时要不要自己跑」；开关打开前的历史会话只能靠手动补，
    // 否则用户开启记忆后库永远是空的
    closeMemoryDb();
    configureMemoryEmbedding({ modelId: 'none' });
    const complete = vi.fn(llm('vitest chosen over jest for esm support'));
    configureMemoryDistill({
      enabled: false,
      readTranscript: async () => [
        { role: 'user' as const, text: 'we picked vitest, jest esm broke' },
      ],
      complete: () => complete,
    });
    const manual = { sessionId: 'manual-s1', sessionFile: '/fake/manual.jsonl', projectId: null };
    await expect(distillSessionNow(manual)).resolves.toBe(true);
    await awaitMemoryDistill();
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await search('vitest')).results).toHaveLength(1);

    // 指纹相同 → 不再跑一轮，也不重复写
    await expect(distillSessionNow(manual)).resolves.toBe(false);
    await awaitMemoryDistill();
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await search('vitest')).results).toHaveLength(1);
    configureMemoryDistill({ enabled: false });
  });

  it('开关打开：写入 source=distill；同会话同内容重复触发不重复调 LLM 也不重复写', async () => {
    const complete = vi.fn(llm('pnpm workspaces chosen for monorepo'));
    configureMemoryDistill({
      enabled: true,
      readTranscript: async () => messages,
      complete: () => complete,
    });
    await scheduleMemoryDistill(payload);
    await scheduleMemoryDistill(payload);
    await awaitMemoryDistill();
    expect(complete).toHaveBeenCalledTimes(1);
    const hits = (await search('pnpm')).results;
    expect(hits).toHaveLength(1);
    expect(sourceOf(hits[0].id)).toBe('distill');
  });

  it('LLM 抛错 / 读会话抛错：scheduleMemoryDistill 不抛，不写入', async () => {
    configureMemoryDistill({
      enabled: true,
      readTranscript: async () => [{ role: 'user', text: 'kubernetes ingress broke again' }],
      complete: () => async () => {
        throw new Error('provider down');
      },
    });
    await expect(
      scheduleMemoryDistill({ ...payload, sessionId: 'distill-s2' })
    ).resolves.toBeUndefined();
    configureMemoryDistill({
      readTranscript: async () => {
        throw new Error('jsonl missing');
      },
    });
    await expect(
      scheduleMemoryDistill({ ...payload, sessionId: 'distill-s3' })
    ).resolves.toBeUndefined();
    expect((await search('kubernetes')).results).toEqual([]);
  });

  it('LLM 第一次抛错：任务保留 pending；同会话第二次触发重新执行并成功写入', async () => {
    const read = async () => [
      { role: 'user' as const, text: 'Rotate the TLS certs every 60 days via cert-manager.' },
    ];
    let fail = true;
    const complete = vi.fn(async () => {
      if (fail) throw new Error('timeout');
      return llm('TLS certs rotate every 60 days via cert-manager')();
    });
    configureMemoryDistill({ enabled: true, readTranscript: read, complete: () => complete });
    const p = { ...payload, sessionId: 'distill-retry' };
    await scheduleMemoryDistill(p);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(getMemoryDistillJobs().find((j) => j.payload.sessionId === p.sessionId)).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    expect((await search('cert-manager')).results).toEqual([]);
    fail = false;
    await scheduleMemoryDistill(p);
    expect(complete).toHaveBeenCalledTimes(2);
    const hits = (await search('cert-manager')).results;
    expect(hits).toHaveLength(1);
    expect(sourceOf(hits[0].id)).toBe('distill');
    expect(getMemoryDistillJobs().find((j) => j.payload.sessionId === p.sessionId)).toMatchObject({
      status: 'done',
      attempts: 2,
      done: 1,
    });
  });

  it('worker 不在线（complete 为 null）：任务保留，重开库后续跑并写入', async () => {
    const read = async () => [
      { role: 'user' as const, text: 'Switch CI runners to arm64 next quarter.' },
    ];
    configureMemoryDistill({ enabled: true, readTranscript: read, complete: () => null });
    await scheduleMemoryDistill({ ...payload, sessionId: 'distill-s4' });
    await awaitMemoryDistill();
    expect((await search('arm64')).results).toEqual([]);
    // “重启”：关库再开，此时 worker 在线
    closeMemoryDb();
    const complete = vi.fn(llm('CI runners move to arm64 next quarter'));
    configureMemoryDistill({ complete: () => complete });
    // 任意一次记忆操作开库→触发续跑
    await search('arm64');
    await awaitMemoryDistill();
    expect(complete).toHaveBeenCalledTimes(1);
    const hits = (await search('arm64')).results;
    expect(hits).toHaveLength(1);
    expect(sourceOf(hits[0].id)).toBe('distill');
  });
});

describe('memoryHost KG 抽取接线', () => {
  const kgJson = (names: string[]) =>
    JSON.stringify({
      entities: names.map((n) => ({ name: n, type: 'TOOL', confidence: 0.9 })),
      relationships: [],
    });
  const capture = (content: string) =>
    invokeMemory('capture', { content, importance: 0.6, spaceId: 'global' }, null) as Promise<{
      status: string;
      memory: { id: string };
    }>;
  const entityNames = () => {
    const ro = new Database(path.join(userData, 'memory', 'memory.db'), { readonly: true });
    try {
      return (
        ro.prepare('SELECT name FROM entities ORDER BY name').all() as { name: string }[]
      ).map((r) => r.name);
    } finally {
      ro.close();
    }
  };

  it('开关关闭：capture 不建 kg 任务、不调 LLM', async () => {
    closeMemoryDb();
    configureMemoryEmbedding({ modelId: 'none' });
    configureMemoryDistill({ enabled: false });
    const complete = vi.fn(async () => kgJson(['Terraform']));
    configureMemoryKg({ enabled: false, complete: () => complete });
    await capture('We provision infra with Terraform.');
    await awaitMemoryKg();
    expect(complete).not.toHaveBeenCalled();
    expect(getMemoryKgJobs()).toEqual([]);
  });

  it('syncMemoryKgFromSettings 按 unknown 收窄：非布尔 true 视为关', async () => {
    const complete = vi.fn(async () => kgJson(['X']));
    configureMemoryKg({ complete: () => complete });
    syncMemoryKgFromSettings({ memoryKgEnabled: 'true' });
    await capture('Vault stores our secrets.');
    await awaitMemoryKg();
    expect(complete).not.toHaveBeenCalled();
    expect(getMemoryKgJobs()).toEqual([]);
  });

  it('开关打开：capture 后异步抽实体；hash 去重的重复 capture 不再调 LLM', async () => {
    const complete = vi.fn(async () => kgJson(['Terraform']));
    configureMemoryKg({ enabled: true, complete: () => complete });
    const r = await capture('Terraform modules live in the infra repo.');
    expect(r.status).toBe('inserted');
    await awaitMemoryKg();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(entityNames()).toEqual(['Terraform']);
    await capture('Terraform modules live in the infra repo.');
    await awaitMemoryKg();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(getMemoryKgJobs().find((j) => j.memoryId === r.memory.id)).toMatchObject({
      status: 'done',
      total: 1,
    });
  });

  it('worker 不在线（complete 为 null）：任务保留 pending，重开库后续跑', async () => {
    configureMemoryKg({ enabled: true, complete: () => null });
    const r = await capture('Ansible handles config management.');
    await awaitMemoryKg();
    expect(getMemoryKgJobs().find((j) => j.memoryId === r.memory.id)?.status).toBe('pending');
    closeMemoryDb();
    const complete = vi.fn(async () => kgJson(['Ansible']));
    configureMemoryKg({ complete: () => complete });
    await invokeMemory('search', { query: 'ansible', limit: 5, spaceId: 'global' }, null);
    await awaitMemoryKg();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(entityNames()).toContain('Ansible');
  });

  it('LLM 抛错：capture 本身成功，任务记 error 保留 pending', async () => {
    configureMemoryKg({
      enabled: true,
      complete: () => async () => {
        throw new Error('provider down');
      },
    });
    const r = await capture('Helm charts package the deployment.');
    expect(r.status).toBe('inserted');
    await awaitMemoryKg();
    expect(getMemoryKgJobs().find((j) => j.memoryId === r.memory.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
  });

  it('蒸馏写入的记忆也触发 KG 抽取（两类任务共用一条串行链）', async () => {
    const distill = async () =>
      JSON.stringify({
        memories: [
          {
            title: 'Use ArgoCD',
            content: 'ArgoCD drives GitOps deployments for the platform team.',
            importance: 0.8,
            unit_type: 'decision',
          },
        ],
      });
    const kg = vi.fn(async () => kgJson(['ArgoCD']));
    configureMemoryDistill({
      enabled: true,
      readTranscript: async () => [{ role: 'user', text: 'we standardize on argocd' }],
      complete: () => distill,
    });
    configureMemoryKg({ enabled: true, complete: () => kg });
    await scheduleMemoryDistill({
      sessionId: 'kg-distill',
      sessionFile: '/fake/k.jsonl',
      projectId: null,
    });
    await awaitMemoryDistill();
    await awaitMemoryKg();
    expect(kg).toHaveBeenCalledTimes(1);
    expect(entityNames()).toContain('ArgoCD');
    configureMemoryDistill({ enabled: false });
    configureMemoryKg({ enabled: false });
  });
});

describe('memoryHost 变更通知（图谱/记忆库自动刷新）', () => {
  const kgJson = (names: string[]) =>
    JSON.stringify({
      entities: names.map((n) => ({ name: n, type: 'TOOL', confidence: 0.9 })),
      relationships: [],
    });

  it('通知发出时 KG 实体已落库（不是抽取前那一刻）', async () => {
    // 图谱数据来自 KG 抽取，而抽取是记忆写入后异步排队的。
    // 关键不是通知了几次，而是「最后一次通知之后界面能看到实体」——
    // 只在写记忆时通知的话，那一刻实体还没落库，抽取完成又不再通知，图谱永远是空的。
    closeMemoryDb();
    configureMemoryEmbedding({ modelId: 'none' });
    configureMemoryDistill({ enabled: false });
    // 抽取必须慢于通知合并窗口：真实 LLM 要几秒，若 mock 是即时的，
    // 写入那次通知恰好也能看到实体，测试就会假绿（实测回退修复仍通过）。
    const complete = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return kgJson(['Terraform']);
    });
    configureMemoryKg({ enabled: true, complete: () => complete });

    // 每次通知时记录当时库里的实体数，事后检查最后一次
    const entityCountAtNotify: number[] = [];
    setMemoryChangeListener(() => entityCountAtNotify.push(countEntities()));
    try {
      await invokeMemory(
        'capture',
        { content: 'We provision infra with Terraform.', importance: 0.6, spaceId: 'global' },
        null
      );
      await awaitMemoryKg();
      await waitUntil(() => entityCountAtNotify.some((n) => n > 0));
      expect(countEntities()).toBeGreaterThan(0);
      expect(entityCountAtNotify.at(-1)).toBeGreaterThan(0);
    } finally {
      setMemoryChangeListener(null);
    }
  });

  it('批量写入合并成少量通知，不是每条一次', async () => {
    // 批量提炼会连续写很多条记忆，每条都广播会让渲染层反复重算整张图
    closeMemoryDb();
    configureMemoryEmbedding({ modelId: 'none' });
    configureMemoryDistill({ enabled: false });
    configureMemoryKg({ enabled: false, complete: null });

    let count = 0;
    setMemoryChangeListener(() => {
      count += 1;
    });
    try {
      for (let i = 0; i < 8; i++) {
        await invokeMemory(
          'capture',
          { content: `batch item ${i}`, importance: 0.6, spaceId: 'global' },
          null
        );
      }
      await new Promise((r) => setTimeout(r, 400));
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(8);
    } finally {
      setMemoryChangeListener(null);
    }
  });
});

/** 轮询到条件成立或超时；避免用固定 sleep 猜异步时序 */
async function waitUntil(ok: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

function countEntities(): number {
  const file = path.join(userData, 'memory', 'memory.db');
  if (!existsSync(file)) return 0;
  const ro = new Database(file, { readonly: true });
  try {
    return (ro.prepare('SELECT count(*) AS n FROM entities').get() as { n: number }).n;
  } catch {
    return 0;
  } finally {
    ro.close();
  }
}

describe('memoryHost embedding 配置与生命周期', () => {
  const remoteSettings = (baseUrl = 'https://old.invalid', apiKey = 'old-key') => ({
    memoryEmbeddingModel: 'remote:openai-compatible',
    memoryEmbeddingRemoteProviderId: 'p',
    providers: [{ id: 'p', baseUrl, apiKey }],
  });
  const fetchSpy = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }))
  );
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const loadGguf = (modelId = 'local:bge-m3-gguf') => {
    const spec = resolveEmbeddingModelSpec(modelId)!;
    const dir = path.join(userData, 'memory', 'models', embeddingModelDirName(spec));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, spec.gguf!.file), 'fixture: runtime is mocked');
    writeFileSync(path.join(dir, '.ready'), '{}');
    const loading = deferred<LlamaModelLike>();
    const context = {
      getEmbeddingFor: vi.fn(async () => ({ vector: [1, 0] })),
      dispose: vi.fn(async () => {}),
    };
    const model = {
      trainContextSize: 512,
      tokenizer: (text: string) => Array.from(text, (_, index) => index + 1),
      tokens: { shouldPrependBosToken: false, shouldAppendEosToken: false },
      vocabularyType: 'bpe',
      createEmbeddingContext: vi.fn(async () => context),
      createContext: vi.fn(),
      dispose: vi.fn(async () => {}),
    };
    vi.mocked(acquireModel).mockReturnValueOnce(loading.promise);
    return { ...loading, model, context, modelId };
  };

  beforeEach(async () => {
    closeMemoryDb();
    await awaitMemoryReembed();
    configureMemoryEmbedding({
      modelId: 'none',
      autoDownload: false,
      remoteCredentials: undefined,
    });
    configureMemoryDistill({ enabled: false });
    configureMemoryKg({ enabled: false });
    await awaitMemoryReembed();
    fetchSpy.mockClear();
    vi.mocked(acquireModel).mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(async () => {
    closeMemoryDb();
    await awaitMemoryReembed();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['https://new.invalid', 'old-key'],
    ['https://old.invalid', 'new-key'],
    ['https://new.invalid', 'new-key'],
  ])('同 providerId 改端点或凭证：后续请求使用 %s / %s', async (baseUrl, apiKey) => {
    syncMemoryEmbeddingFromSettings(remoteSettings());
    await (await getMemoryEmbedder())!.embed('before edit', 'query');
    syncMemoryEmbeddingFromSettings(remoteSettings(baseUrl, apiKey));
    await (await getMemoryEmbedder())!.embed('private after edit', 'query');
    expect(fetchSpy.mock.calls.at(-1)).toEqual([
      `${baseUrl}/v1/embeddings`,
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${apiKey}` }),
        body: JSON.stringify({ model: 'openai-compatible', input: ['private after edit'] }),
      }),
    ]);
  });

  it.each([
    { providers: [] },
    { providers: [{ id: 'p', baseUrl: 'https://old.invalid', apiKey: '' }] },
  ])('删除服务或清空凭证后不再向旧服务发送私密文本：%j', async ({ providers }) => {
    syncMemoryEmbeddingFromSettings(remoteSettings());
    await (await getMemoryEmbedder())!.embed('before removal', 'query');
    syncMemoryEmbeddingFromSettings({ ...remoteSettings(), providers });
    const after = await getMemoryEmbedder();
    if (after) await after.embed('private after removal', 'query');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(after).toBeNull();
  });

  it('无关设置与未选中的服务变更不清缓存、不释放已加载 GGUF', async () => {
    const gguf = loadGguf();
    const settings = { ...remoteSettings(), memoryEmbeddingModel: gguf.modelId };
    syncMemoryEmbeddingFromSettings(settings);
    const pending = getMemoryEmbedder();
    gguf.resolve(gguf.model);
    const first = await pending;
    await first!.embed('cached query', 'query');
    syncMemoryEmbeddingFromSettings({ ...settings, theme: 'dark' });
    syncMemoryEmbeddingFromSettings({
      ...settings,
      memoryEmbeddingRemoteProviderId: 'other',
      providers: [{ id: 'other', baseUrl: 'https://new.invalid', apiKey: 'new-key' }],
    });
    const second = await getMemoryEmbedder();
    await second?.embed('cached query', 'query');
    expect(second).toBe(first);
    expect(gguf.context.getEmbeddingFor).toHaveBeenCalledTimes(1);
    expect(gguf.context.dispose).not.toHaveBeenCalled();
    expect(acquireModel).toHaveBeenCalledTimes(1);
  });

  it('原地修改 provider 后采用新凭证，随后无关设置保存仍复用远程查询缓存', async () => {
    const settings = remoteSettings();
    syncMemoryEmbeddingFromSettings(settings);
    await (await getMemoryEmbedder())!.embed('before mutation', 'query');
    settings.providers[0].apiKey = 'rotated-key';
    syncMemoryEmbeddingFromSettings(settings);
    const current = await getMemoryEmbedder();
    await current!.embed('cached private query', 'query');
    syncMemoryEmbeddingFromSettings({ ...settings, theme: 'dark' });
    expect(await getMemoryEmbedder()).toBe(current);
    await (await getMemoryEmbedder())!.embed('cached private query', 'query');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.at(-1)?.[1]?.headers).toMatchObject({
      authorization: 'Bearer rotated-key',
    });
  });

  it.each(['close', 'none'] as const)(
    '下载中 %s：旧下载完成不重新调度后台任务或回写错误',
    async (action) => {
      const downloading = deferred<void>();
      const download = vi
        .spyOn(embeddingDownloads, 'downloadModel')
        .mockReturnValueOnce(downloading.promise);
      const progress = vi.fn();
      configureMemoryEmbedding({
        modelId: 'local:potion-multilingual-128M',
        autoDownload: true,
        onProgress: progress,
      });
      await getMemoryEmbedder();
      await awaitMemoryReembed();
      if (action === 'close') closeMemoryDb();
      else {
        configureMemoryEmbedding({ modelId: 'none' });
        await awaitMemoryReembed();
        await getMemoryEmbedder();
      }
      const error = getMemoryEmbeddingError();
      download.mock.calls[0][2]?.onProgress?.({
        file: 'model.safetensors',
        fileIndex: 0,
        fileCount: 3,
        received: 1,
        total: 2,
      });
      downloading.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await awaitMemoryReembed();
      expect(progress).not.toHaveBeenCalled();
      expect(getMemoryEmbeddingError()).toBe(error);
      expect(embeddingDownloads.downloadModel).toHaveBeenCalledTimes(1);
    }
  );

  it('自动下载中切走再切回：新代重新等待同一下载，完成后旧记忆自动补向量', async () => {
    const spec = resolveEmbeddingModelSpec('local:potion-multilingual-128M')!;
    const dir = path.join(userData, 'memory', 'models', embeddingModelDirName(spec));
    rmSync(dir, { recursive: true, force: true });
    const result = (await invokeMemory(
      'capture',
      {
        content: 'redis generation-resume',
        importance: 0.8,
        spaceId: 'global',
      },
      null
    )) as { memory: { id: string } };
    await awaitMemoryReembed();
    const downloading = deferred<void>();
    vi.spyOn(embeddingDownloads, 'downloadModel').mockReturnValue(downloading.promise);
    try {
      configureMemoryEmbedding({ modelId: spec.id, autoDownload: true });
      await getMemoryEmbedder();
      await awaitMemoryReembed();
      configureMemoryEmbedding({ modelId: 'none' });
      configureMemoryEmbedding({ modelId: spec.id });
      await getMemoryEmbedder();
      await awaitMemoryReembed();
      const vector = Array(256).fill(0);
      vector[0] = 1;
      writeTinyModel2Vec(dir, { tokens: ['redis'], rows: [vector] });
      writeFileSync(path.join(dir, '.ready'), '{}');
      downloading.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await awaitMemoryReembed();
      expect(
        memoryDatabase()
          .prepare('SELECT embedding_model FROM memories WHERE id = ?')
          .get(result.memory.id)
      ).toEqual({
        embedding_model: spec.id,
      });
    } finally {
      downloading.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await awaitMemoryReembed();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A→B 不同目录下载：A 完成不清 B 订阅，B 进度不重复且完成后自动重嵌', async () => {
    const old = resolveEmbeddingModelSpec('local:qwen3-0.6b-gguf')!;
    const next = loadGguf();
    const oldDir = path.join(userData, 'memory', 'models', embeddingModelDirName(old));
    const nextDir = path.join(
      userData,
      'memory',
      'models',
      embeddingModelDirName(resolveEmbeddingModelSpec(next.modelId)!)
    );
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(nextDir, { recursive: true, force: true });
    next.resolve(next.model);
    const result = (await invokeMemory(
      'capture',
      {
        content: 'separate download generation',
        importance: 0.8,
        spaceId: 'global',
      },
      null
    )) as { memory: { id: string } };
    await awaitMemoryReembed();
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const network = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller);
              controller.enqueue(Uint8Array.from([1, 2, 3]));
            },
          })
        )
    );
    vi.stubGlobal('fetch', network);
    const downloads = vi.spyOn(embeddingDownloads, 'downloadModel');
    const firstProgress = deferred<void>();
    const nextProgress = deferred<void>();
    const received: number[] = [];
    try {
      configureMemoryEmbedding({
        modelId: old.id,
        autoDownload: true,
        onProgress: () => firstProgress.resolve(),
      });
      await getMemoryEmbedder();
      await firstProgress.promise;
      configureMemoryEmbedding({
        modelId: next.modelId,
        onProgress: (p) => {
          received.push(p.received);
          nextProgress.resolve();
        },
      });
      await getMemoryEmbedder();
      await nextProgress.promise;
      streams[0].close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await getMemoryEmbedder();
      streams[1].enqueue(Uint8Array.from([4]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(received).toEqual([3, 4]);
      expect(network).toHaveBeenCalledTimes(2);
      streams[1].close();
      await Promise.allSettled(downloads.mock.results.map((r) => r.value));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await awaitMemoryReembed();
      expect(
        memoryDatabase()
          .prepare('SELECT embedding_model FROM memories WHERE id = ?')
          .get(result.memory.id)
      ).toEqual({ embedding_model: next.modelId });
    } finally {
      configureMemoryEmbedding({ modelId: 'none', autoDownload: false, onProgress: undefined });
      cancelEmbeddingModelDownload(old.id);
      cancelEmbeddingModelDownload(next.modelId);
      for (const stream of streams) {
        try {
          stream.error(new DOMException('Aborted', 'AbortError'));
        } catch {}
      }
      await Promise.allSettled(downloads.mock.results.map((r) => r.value));
      await awaitMemoryReembed();
      rmSync(oldDir, { recursive: true, force: true });
      rmSync(nextDir, { recursive: true, force: true });
    }
  });

  it.each(['start', 'cancel', 'delete'] as const)(
    'Host 自动下载与显式 %s 共用文件互斥、取消和状态',
    async (action) => {
      const modelId = 'local:qwen3-0.6b-gguf';
      const spec = resolveEmbeddingModelSpec(modelId)!;
      const dir = path.join(userData, 'memory', 'models', embeddingModelDirName(spec));
      rmSync(dir, { recursive: true, force: true });
      const part = path.join(dir, `${spec.files[0].name}.part`);
      const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
      const network = vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streams.push(controller);
                controller.enqueue(Uint8Array.from([1, 2, 3]));
              },
            })
          )
      );
      vi.stubGlobal('fetch', network);
      const started = deferred<void>();
      const downloads = vi.spyOn(embeddingDownloads, 'downloadModel');
      let explicit: Promise<boolean> | null = null;
      try {
        configureMemoryEmbedding({
          modelId,
          autoDownload: true,
          onProgress: () => started.resolve(),
        });
        await getMemoryEmbedder();
        await started.promise;
        expect(readFileSync(part)).toEqual(Buffer.from([1, 2, 3]));
        if (action === 'start') {
          explicit = startEmbeddingModelDownload(modelId);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(network).toHaveBeenCalledTimes(1);
          expect(readFileSync(part)).toEqual(Buffer.from([1, 2, 3]));
        }
        expect(listEmbeddingModels().find((model) => model.id === modelId)?.state).toBe(
          'downloading'
        );
        if (action === 'delete') expect(deleteEmbeddingModel(modelId)).toBe(false);
        else expect(cancelEmbeddingModelDownload(modelId)).toBe(true);
        expect(network.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(existsSync(part)).toBe(true);
        configureMemoryEmbedding({ modelId: 'none', autoDownload: false, onProgress: undefined });
        for (const stream of streams) stream.error(new DOMException('Aborted', 'AbortError'));
        await Promise.allSettled(downloads.mock.results.map((result) => result.value));
        if (explicit) expect(await explicit).toBe(false);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(existsSync(path.join(dir, '.ready'))).toBe(false);
        expect(listEmbeddingModels().find((model) => model.id === modelId)?.state).toBe('missing');
        expect(deleteEmbeddingModel(modelId)).toBe(true);
        expect(existsSync(dir)).toBe(false);
      } finally {
        configureMemoryEmbedding({ modelId: 'none', autoDownload: false, onProgress: undefined });
        cancelEmbeddingModelDownload(modelId);
        for (const stream of streams) {
          try {
            stream.error(new DOMException('Aborted', 'AbortError'));
          } catch {}
        }
        await Promise.allSettled(downloads.mock.results.map((result) => result.value));
        await explicit;
        await new Promise<void>((resolve) => setImmediate(resolve));
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('真实 IPC 删除选中模型后不自动下回来；后续用户查询仍遵循 autoDownload', async () => {
    const { registerMemoryHandlers } = await import('../ipc/memory');
    registerMemoryHandlers();
    const model = loadGguf();
    const spec = resolveEmbeddingModelSpec(model.modelId)!;
    const dir = path.join(userData, 'memory', 'models', embeddingModelDirName(spec));
    model.resolve(model.model);
    memoryDatabase();
    configureMemoryEmbedding({ modelId: model.modelId, autoDownload: true });
    expect(await getMemoryEmbedder()).not.toBeNull();
    await awaitMemoryReembed();
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const network = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller);
              controller.enqueue(Uint8Array.from([1, 2, 3]));
            },
          })
        )
    );
    vi.stubGlobal('fetch', network);
    const downloads = vi.spyOn(embeddingDownloads, 'downloadModel');
    try {
      const remove = ipcHandlers.get(IPC_CHANNELS.MEMORY_MODEL_DELETE)!;
      expect(await remove({ sender: { id: 1 } }, model.modelId)).toBe(true);
      await awaitMemoryReembed();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(network).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(false);
      expect(model.context.dispose).toHaveBeenCalledTimes(1);
      await invokeMemory(
        'search',
        { query: 'user query after deletion', limit: 5, spaceId: 'global' },
        null
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(network).toHaveBeenCalledTimes(1);
      expect(existsSync(path.join(dir, `${spec.files[0].name}.part`))).toBe(true);
    } finally {
      configureMemoryEmbedding({ modelId: 'none', autoDownload: false });
      cancelEmbeddingModelDownload(model.modelId);
      for (const stream of streams) {
        try {
          stream.error(new DOMException('Aborted', 'AbortError'));
        } catch {}
      }
      await Promise.allSettled(downloads.mock.results.map((r) => r.value));
      await awaitMemoryReembed();
      setMemoryChangeListener(null);
      setEmbeddingProgressSink(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('远程初始化中切 none，不返回可继续外发文本的旧 embedder', async () => {
    syncMemoryEmbeddingFromSettings(remoteSettings());
    const pending = getMemoryEmbedder();
    configureMemoryEmbedding({ modelId: 'none' });
    const stale = await pending;
    if (stale) await stale.embed('private after disabling', 'query');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stale).toBeNull();
    expect(await getMemoryEmbedder()).toBeNull();
  });

  it('GGUF 加载中切 none：旧 context 被释放，后续检索仍为纯 FTS', async () => {
    const old = loadGguf();
    configureMemoryEmbedding({ modelId: old.modelId });
    const pending = getMemoryEmbedder();
    configureMemoryEmbedding({ modelId: 'none' });
    old.resolve(old.model);
    const stale = await pending;
    const current = await getMemoryEmbedder();
    if (current) await current.embed('private after disabling', 'query');
    expect(old.context.getEmbeddingFor).not.toHaveBeenCalled();
    expect(old.context.dispose).toHaveBeenCalledTimes(1);
    expect(stale).toBeNull();
    expect(current).toBeNull();
  });

  it('新 GGUF 先就绪后旧加载完成，不覆盖新选择也不释放新 context', async () => {
    const old = loadGguf();
    configureMemoryEmbedding({ modelId: old.modelId });
    const oldPending = getMemoryEmbedder();
    const next = loadGguf('local:qwen3-0.6b-gguf');
    configureMemoryEmbedding({ modelId: next.modelId });
    const nextPending = getMemoryEmbedder();
    next.resolve(next.model);
    const current = await nextPending;
    old.resolve(old.model);
    const stale = await oldPending;
    const after = await getMemoryEmbedder();
    await after!.embed('new model query', 'query');
    expect(after).toBe(current);
    expect(stale).toBeNull();
    expect(next.context.getEmbeddingFor).toHaveBeenCalledTimes(1);
    expect(next.context.dispose).not.toHaveBeenCalled();
    expect(old.context.dispose).toHaveBeenCalledTimes(1);
  });

  it('旧加载失败的 finally 不能清除新 init；新模型只创建一个 context', async () => {
    const old = loadGguf();
    configureMemoryEmbedding({ modelId: old.modelId });
    const oldPending = getMemoryEmbedder();
    const next = loadGguf('local:qwen3-0.6b-gguf');
    configureMemoryEmbedding({ modelId: next.modelId });
    const nextPending = getMemoryEmbedder();
    await awaitMemoryReembed();
    old.reject(new Error('obsolete load failed'));
    await oldPending;
    const error = getMemoryEmbeddingError();
    const joined = getMemoryEmbedder();
    next.resolve(next.model);
    const [first, second] = await Promise.all([nextPending, joined]);
    expect(error).not.toContain('obsolete load failed');
    expect(second).toBe(first);
    expect(first?.model).toBe(next.modelId);
    expect(acquireModel).toHaveBeenCalledTimes(2);
    expect(next.model.createEmbeddingContext).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'refresh'] as const)(
    '%s 后同模型重新加载：旧 init 不复活、不清新 init',
    async (action) => {
      const old = loadGguf();
      configureMemoryEmbedding({ modelId: old.modelId });
      const oldPending = getMemoryEmbedder();
      const next = loadGguf();
      if (action === 'close') closeMemoryDb();
      else refreshMemoryEmbedding();
      const nextPending = getMemoryEmbedder();
      old.resolve(old.model);
      await oldPending;
      const joined = getMemoryEmbedder();
      next.resolve(next.model);
      const [first, second] = await Promise.all([nextPending, joined]);
      expect(second).toBe(first);
      expect(old.context.dispose).toHaveBeenCalledTimes(1);
      expect(next.context.dispose).not.toHaveBeenCalled();
      await first!.embed('fresh context query', 'query');
      expect(next.context.getEmbeddingFor).toHaveBeenCalled();
      expect(old.context.getEmbeddingFor).not.toHaveBeenCalled();
      expect(acquireModel).toHaveBeenCalledTimes(2);
    }
  );

  it('关库后旧重嵌失败不覆盖新配置错误，后台链可正常结束', async () => {
    await invokeMemory(
      'capture',
      { content: 'pending embedding lifecycle', importance: 0.8, spaceId: 'global' },
      null
    );
    await awaitMemoryReembed();
    const old = loadGguf();
    const started = deferred<void>();
    const vector = deferred<{ vector: number[] }>();
    old.context.getEmbeddingFor.mockImplementationOnce(() => {
      started.resolve();
      return vector.promise;
    });
    configureMemoryEmbedding({ modelId: old.modelId });
    old.resolve(old.model);
    await started.promise;
    closeMemoryDb();
    configureMemoryEmbedding({ modelId: 'local:potion-multilingual-128M' });
    await getMemoryEmbedder();
    closeMemoryDb();
    const error = getMemoryEmbeddingError();
    vector.reject(new Error('obsolete embedding failed'));
    await awaitMemoryReembed();
    expect(getMemoryEmbeddingError()).toBe(error);
    expect(old.context.getEmbeddingFor).toHaveBeenCalledTimes(1);
  });

  it('零进展重嵌只跑一轮，后续查询不会反复重新排队', async () => {
    await invokeMemory(
      'capture',
      { content: 'zero progress embedding', importance: 0.8, spaceId: 'global' },
      null
    );
    await awaitMemoryReembed();
    const gguf = loadGguf();
    gguf.context.getEmbeddingFor.mockResolvedValue({ vector: [] });
    configureMemoryEmbedding({ modelId: gguf.modelId });
    gguf.resolve(gguf.model);
    await awaitMemoryReembed();
    const before = memoryDatabase()
      .prepare("SELECT count(*) AS n FROM memory_jobs WHERE kind = 'reembed'")
      .get();
    const job = getMemoryReembedProgress();
    expect(job).toMatchObject({ status: 'done', done: 0 });
    expect(job!.failed).toBeGreaterThan(0);
    await getMemoryEmbedder();
    await awaitMemoryReembed();
    expect(
      memoryDatabase().prepare("SELECT count(*) AS n FROM memory_jobs WHERE kind = 'reembed'").get()
    ).toEqual(before);
  });
});

describe('rootSessionId', () => {
  const gen = '11111111-1111-4111-8111-111111111111';
  it('父会话原样；coworker `p::cw-x` 与 enso child 都归到父', () => {
    expect(rootSessionId({ sessionId: 'p', generation: gen })).toBe('p');
    expect(rootSessionId({ sessionId: 'p::cw-bob', generation: gen })).toBe('p');
    expect(
      rootSessionId({
        sessionId: 'child',
        generation: gen,
        parent: { sessionId: 'p::cw-bob', generation: gen },
        instanceId: 'i',
        instanceName: 'n',
        typeKey: 'enso' as never,
      })
    ).toBe('p');
  });
});
