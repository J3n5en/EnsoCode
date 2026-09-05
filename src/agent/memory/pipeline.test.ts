import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Stage1Artifact } from './pipeline';
import { buildPhaseTwoCorpus, type MemoryCompleteSimple, runMemoryPipeline } from './pipeline';

const CWD = '/Users/me/proj';
const NOW_SEC = 1_800_000_000;
const IDLE_SEC = 20 * 3600; // 20h idle: within (12h, 30d) window

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeParentSession(
  dir: string,
  opts: { id: string; cwd?: string; userText: string; idleSec?: number }
): string {
  const file = path.join(dir, `${opts.id}.jsonl`);
  const rows = [
    { type: 'session', id: opts.id, cwd: opts.cwd ?? CWD },
    {
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: opts.userText }] },
    },
  ];
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const mtime = NOW_SEC - (opts.idleSec ?? IDLE_SEC);
  utimesSync(file, mtime, mtime);
  return file;
}

const STAGE1_EMPTY = JSON.stringify({
  rollout_summary: '',
  rollout_slug: null,
  raw_memory: '',
});

const STAGE1_VALID = JSON.stringify({
  rollout_summary: 'fixed the login bug',
  rollout_slug: 'login-fix',
  raw_memory: 'auth middleware needed a null check',
});

const PHASE2_VALID = JSON.stringify({
  memory_md: 'durable memory content',
  memory_summary: 'short summary',
  skills: [],
});

function baseOpts(overrides: Partial<Parameters<typeof runMemoryPipeline>[0]> = {}) {
  return {
    memoryRoot: tmpDir('enso-pipeline-mem-'),
    sessionDir: tmpDir('enso-pipeline-sess-'),
    cwd: CWD,
    nowSec: NOW_SEC,
    workerToken: 'worker-1',
    completeSimple: vi.fn(async () => STAGE1_VALID) as unknown as MemoryCompleteSimple,
    ...overrides,
  };
}

describe('runMemoryPipeline', () => {
  it('returns {0,false} and never calls completeSimple when there are no eligible threads', async () => {
    const completeSimple = vi.fn(async () => STAGE1_VALID) as unknown as MemoryCompleteSimple;
    const opts = baseOpts({ completeSimple });

    const result = await runMemoryPipeline(opts);

    expect(completeSimple).not.toHaveBeenCalled();
    expect(result).toEqual({ stage1Claimed: 0, phase2Ran: false });
  });

  it('reports stage1 then phase2 progress against claimed threads plus one merge slot', async () => {
    const onProgress = vi.fn();
    const opts = baseOpts({ onProgress });
    writeParentSession(opts.sessionDir, { id: 'thread-valid', userText: 'fix login bug' });
    const completeSimple = vi
      .fn<Parameters<MemoryCompleteSimple>, ReturnType<MemoryCompleteSimple>>()
      .mockResolvedValueOnce(STAGE1_VALID)
      .mockResolvedValueOnce(PHASE2_VALID);
    opts.completeSimple = completeSimple;

    await runMemoryPipeline(opts);

    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([
      { phase: 'stage1', current: 0, total: 2 },
      { phase: 'stage1', current: 1, total: 2 },
      { phase: 'phase2', current: 1, total: 2 },
      { phase: 'phase2', current: 2, total: 2 },
    ]);
  });

  it('claims one idle same-cwd parent thread, calls phase 1 with thread id + persistable text, and skips writing MEMORY.md when stage1 output is empty', async () => {
    const opts = baseOpts();
    writeParentSession(opts.sessionDir, { id: 'thread-empty', userText: 'fix login bug' });
    const completeSimple = vi.fn<MemoryCompleteSimple>(async () => STAGE1_EMPTY);
    opts.completeSimple = completeSimple;

    const result = await runMemoryPipeline(opts);

    expect(completeSimple).toHaveBeenCalledTimes(1);
    const call = completeSimple.mock.calls[0][0];
    expect(call.phase).toBe(1);
    expect(call.userText).toContain('thread-empty');
    expect(call.userText).toContain('fix login bug');

    expect(result).toEqual({ stage1Claimed: 1, phase2Ran: false });
    expect(existsSync(path.join(opts.memoryRoot, 'MEMORY.md'))).toBe(false);
  });

  it('runs phase 2 and writes MEMORY.md + memory_summary.md when stage1 yields non-empty content', async () => {
    const opts = baseOpts();
    writeParentSession(opts.sessionDir, { id: 'thread-valid', userText: 'fix login bug' });
    const completeSimple = vi
      .fn<MemoryCompleteSimple>()
      .mockResolvedValueOnce(STAGE1_VALID)
      .mockResolvedValueOnce(PHASE2_VALID);
    opts.completeSimple = completeSimple;

    const result = await runMemoryPipeline(opts);

    expect(result).toEqual({ stage1Claimed: 1, phase2Ran: true });
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(completeSimple.mock.calls[0][0].phase).toBe(1);
    expect(completeSimple.mock.calls[1][0].phase).toBe(2);

    const memoryMd = readFileSync(path.join(opts.memoryRoot, 'MEMORY.md'), 'utf8');
    const summaryMd = readFileSync(path.join(opts.memoryRoot, 'memory_summary.md'), 'utf8');
    expect(memoryMd).toBe('durable memory content\n');
    expect(summaryMd).toBe('short summary\n');
  });

  it('does not write MEMORY.md and does not run phase 2 when stage1 JSON is invalid', async () => {
    const opts = baseOpts();
    writeParentSession(opts.sessionDir, { id: 'thread-bad', userText: 'fix login bug' });
    const completeSimple = vi.fn(async () => 'not json at all') as unknown as MemoryCompleteSimple;
    opts.completeSimple = completeSimple;

    const result = await runMemoryPipeline(opts);

    expect(result).toEqual({ stage1Claimed: 1, phase2Ran: false });
    expect(existsSync(path.join(opts.memoryRoot, 'MEMORY.md'))).toBe(false);
  });

  it('leaves an existing learned.md byte-identical after a successful full pipeline run', async () => {
    const opts = baseOpts();
    mkdirSync(opts.memoryRoot, { recursive: true });
    const learnedPath = path.join(opts.memoryRoot, 'learned.md');
    const marker = '- keep this lesson untouched\n';
    writeFileSync(learnedPath, marker);

    writeParentSession(opts.sessionDir, { id: 'thread-valid', userText: 'fix login bug' });
    const completeSimple = vi
      .fn<MemoryCompleteSimple>()
      .mockResolvedValueOnce(STAGE1_VALID)
      .mockResolvedValueOnce(PHASE2_VALID);
    opts.completeSimple = completeSimple;

    const result = await runMemoryPipeline(opts);

    expect(result.phase2Ran).toBe(true);
    expect(readFileSync(learnedPath, 'utf8')).toBe(marker);
  });

  it('skips the current thread id and only runs phase 1 for the other thread', async () => {
    const completeSimple = vi.fn<MemoryCompleteSimple>(async () => STAGE1_EMPTY);
    const opts = baseOpts({ currentThreadId: 'thread-current', completeSimple });
    writeParentSession(opts.sessionDir, { id: 'thread-current', userText: 'current session text' });
    writeParentSession(opts.sessionDir, { id: 'thread-other', userText: 'other session text' });

    const result = await runMemoryPipeline(opts);

    expect(completeSimple).toHaveBeenCalledTimes(1);
    const call = completeSimple.mock.calls[0][0];
    expect(call.userText).toContain('thread-other');
    expect(call.userText).not.toContain('thread-current');
    expect(result.stage1Claimed).toBe(1);
  });

  it('truncates stage-one payload around a 12000-token budget', async () => {
    const opts = baseOpts();
    const huge = 'x'.repeat(60_000);
    writeParentSession(opts.sessionDir, { id: 'thread-huge', userText: huge });
    const completeSimple = vi.fn<MemoryCompleteSimple>(async () => STAGE1_EMPTY);
    opts.completeSimple = completeSimple;

    await runMemoryPipeline(opts);

    const userText = completeSimple.mock.calls[0][0].userText;
    expect(userText).toContain('...[truncated]...');
    // 12000 tokens ≈ 48000 chars + marker，且明显高于旧的 4000-token（16000 字符）上限。
    expect(userText.length).toBeGreaterThan(16_000);
    expect(userText.length).toBeLessThanOrEqual(48_300);
  });
});

describe('buildPhaseTwoCorpus', () => {
  function artifact(id: string, sourceUpdatedAt: number, rawLen: number): Stage1Artifact {
    return {
      threadId: id,
      sourceUpdatedAt,
      rollout_summary: `summary for ${id}`,
      rollout_slug: null,
      raw_memory: 'r'.repeat(rawLen),
    };
  }

  const GENEROUS = { summaryTokenLimit: 12_000, maxRawCandidates: 200 };

  it('当 raw 预算不足以容纳所有线程时，保留最新线程的 raw、最旧线程仅保留摘要', () => {
    const artifacts = [
      artifact('thread-oldest', 1_000, 8_000),
      artifact('thread-mid', 2_000, 8_000),
      artifact('thread-newest', 3_000, 8_000),
    ];

    const { raw, summaries } = buildPhaseTwoCorpus(artifacts, {
      rawTokenLimit: 3_000,
      perArtifactRawChars: 6_000,
      ...GENEROUS,
    });

    expect(raw).toContain('thread-newest');
    expect(raw).toContain('thread-mid');
    expect(raw).not.toContain('thread-oldest');

    expect(summaries).toContain('thread-oldest');
    expect(summaries).toContain('thread-mid');
    expect(summaries).toContain('thread-newest');
  });

  it('raw 中的线程按新到旧排列', () => {
    const artifacts = [
      artifact('thread-oldest', 1_000, 500),
      artifact('thread-newest', 3_000, 500),
      artifact('thread-mid', 2_000, 500),
    ];

    const { raw } = buildPhaseTwoCorpus(artifacts, {
      rawTokenLimit: 20_000,
      perArtifactRawChars: 6_000,
      ...GENEROUS,
    });

    const newestIdx = raw.indexOf('thread-newest');
    const midIdx = raw.indexOf('thread-mid');
    const oldestIdx = raw.indexOf('thread-oldest');
    expect(newestIdx).toBeGreaterThanOrEqual(0);
    expect(newestIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(oldestIdx);
  });

  it('单个 artifact 的 raw_memory 超过配额时按 per-artifact 上限截断', () => {
    const artifacts = [artifact('thread-a', 1_000, 10_000)];

    const { raw } = buildPhaseTwoCorpus(artifacts, {
      rawTokenLimit: 20_000,
      perArtifactRawChars: 6_000,
      ...GENEROUS,
    });

    const block = raw.split('## thread-a')[1] ?? '';
    expect(block.length).toBeLessThanOrEqual(6_200);
  });

  it('单个 artifact 的 raw_memory 超过总预算时被裁剪而不是被跳过', () => {
    const artifacts = [artifact('thread-a', 1_000, 10_000)];

    const { raw } = buildPhaseTwoCorpus(artifacts, {
      rawTokenLimit: 1_000, // 4000 字符总预算，小于 perArtifactRawChars
      perArtifactRawChars: 6_000,
      ...GENEROUS,
    });

    expect(raw).toContain('thread-a');
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.length).toBeLessThanOrEqual(4_100);
  });

  it('raw_memory 为空的 artifact 不出现在 raw 中，仅出现在 summaries 中', () => {
    const empty: Stage1Artifact = {
      threadId: 'thread-empty',
      sourceUpdatedAt: 5_000,
      rollout_summary: 'summary for thread-empty',
      rollout_slug: null,
      raw_memory: '',
    };
    const artifacts = [empty, artifact('thread-a', 1_000, 500)];

    const { raw, summaries } = buildPhaseTwoCorpus(artifacts, {
      rawTokenLimit: 20_000,
      perArtifactRawChars: 6_000,
      ...GENEROUS,
    });

    expect(raw).not.toContain('thread-empty');
    expect(summaries).toContain('thread-empty');
  });

  it('raw 候选数超过 maxRawCandidates 时，超出的线程仍出现在 summaries 中', () => {
    const artifacts = [
      artifact('thread-oldest', 1_000, 500),
      artifact('thread-newest', 2_000, 500),
    ];

    const { raw, summaries } = buildPhaseTwoCorpus(artifacts, {
      rawTokenLimit: 20_000,
      perArtifactRawChars: 6_000,
      summaryTokenLimit: 12_000,
      maxRawCandidates: 1,
    });

    expect(raw).toContain('thread-newest');
    expect(raw).not.toContain('thread-oldest');
    expect(summaries).toContain('thread-newest');
    expect(summaries).toContain('thread-oldest');
  });

  it('summaries 超出预算时从最旧的开始丢弃，保留最新', () => {
    const artifacts = [artifact('thread-oldest', 1_000, 10), artifact('thread-newest', 2_000, 10)];
    artifacts[0].rollout_summary = 's'.repeat(3_000);
    artifacts[1].rollout_summary = 's'.repeat(3_000);

    const { summaries } = buildPhaseTwoCorpus(artifacts, {
      rawTokenLimit: 20_000,
      perArtifactRawChars: 6_000,
      summaryTokenLimit: 1_000, // 4000 字符，容不下两条 3000 字符的摘要
      maxRawCandidates: 200,
    });

    expect(summaries).toContain('thread-newest');
    expect(summaries).not.toContain('thread-oldest');
  });

  it('没有 artifacts 时 raw 与 summaries 均为空字符串', () => {
    const { raw, summaries } = buildPhaseTwoCorpus([], {
      rawTokenLimit: 20_000,
      perArtifactRawChars: 6_000,
      ...GENEROUS,
    });

    expect(raw).toBe('');
    expect(summaries).toBe('');
  });
});

describe('runMemoryPipeline prior memory', () => {
  it('已有 MEMORY.md 与 memory_summary.md 时，phase 2 userText 包含两者内容与 Prior memory 标记', async () => {
    const opts = baseOpts();
    mkdirSync(opts.memoryRoot, { recursive: true });
    writeFileSync(path.join(opts.memoryRoot, 'MEMORY.md'), '## Prior fact\nuser prefers pnpm\n');
    writeFileSync(path.join(opts.memoryRoot, 'memory_summary.md'), 'Prior summary line\n');
    writeParentSession(opts.sessionDir, { id: 'thread-valid', userText: 'fix login bug' });
    const completeSimple = vi
      .fn<Parameters<MemoryCompleteSimple>, ReturnType<MemoryCompleteSimple>>()
      .mockResolvedValueOnce(STAGE1_VALID)
      .mockResolvedValueOnce(PHASE2_VALID);
    opts.completeSimple = completeSimple;

    await runMemoryPipeline(opts);

    const phase2UserText = completeSimple.mock.calls[1][0].userText;
    expect(phase2UserText).toContain('Prior memory');
    expect(phase2UserText).toContain('user prefers pnpm');
    expect(phase2UserText).toContain('Prior summary line');
  });

  it('仅存在 memory_summary.md（MEMORY.md 缺失）时，仍视为有 prior memory', async () => {
    const opts = baseOpts();
    mkdirSync(opts.memoryRoot, { recursive: true });
    writeFileSync(path.join(opts.memoryRoot, 'memory_summary.md'), 'Only summary exists\n');
    writeParentSession(opts.sessionDir, { id: 'thread-valid', userText: 'fix login bug' });
    const completeSimple = vi
      .fn<Parameters<MemoryCompleteSimple>, ReturnType<MemoryCompleteSimple>>()
      .mockResolvedValueOnce(STAGE1_VALID)
      .mockResolvedValueOnce(PHASE2_VALID);
    opts.completeSimple = completeSimple;

    await runMemoryPipeline(opts);

    const phase2UserText = completeSimple.mock.calls[1][0].userText;
    expect(phase2UserText).toContain('Prior memory');
    expect(phase2UserText).toContain('Only summary exists');
  });

  it('MEMORY.md 超过预算时被截断，userText 含截断标记且短于原文', async () => {
    const opts = baseOpts();
    mkdirSync(opts.memoryRoot, { recursive: true });
    const hugePrior = 'p'.repeat(45_000);
    writeFileSync(path.join(opts.memoryRoot, 'MEMORY.md'), hugePrior);
    writeParentSession(opts.sessionDir, { id: 'thread-valid', userText: 'fix login bug' });
    const completeSimple = vi
      .fn<Parameters<MemoryCompleteSimple>, ReturnType<MemoryCompleteSimple>>()
      .mockResolvedValueOnce(STAGE1_VALID)
      .mockResolvedValueOnce(PHASE2_VALID);
    opts.completeSimple = completeSimple;

    await runMemoryPipeline(opts);

    const phase2UserText = completeSimple.mock.calls[1][0].userText;
    expect(phase2UserText).toContain('...[truncated]...');
    expect(phase2UserText.length).toBeLessThan(hugePrior.length);
  });

  it('无现有 MEMORY.md/memory_summary.md 时，phase 2 userText 不包含 Prior memory 段', async () => {
    const opts = baseOpts();
    writeParentSession(opts.sessionDir, { id: 'thread-valid', userText: 'fix login bug' });
    const completeSimple = vi
      .fn<Parameters<MemoryCompleteSimple>, ReturnType<MemoryCompleteSimple>>()
      .mockResolvedValueOnce(STAGE1_VALID)
      .mockResolvedValueOnce(PHASE2_VALID);
    opts.completeSimple = completeSimple;

    await runMemoryPipeline(opts);

    const phase2UserText = completeSimple.mock.calls[1][0].userText;
    expect(phase2UserText).not.toContain('Prior memory');
  });
});
