import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claimStage1, loadJobs, markStage1Done, saveJobs, tryClaimPhase2 } from './jobs';
import { applyConsolidation, parsePhaseTwoResponse } from './phaseTwo';
import { CONSOLIDATION_SYSTEM, consolidationUser, STAGE_ONE_SYSTEM, stageOneUser } from './prompts';
import {
  parseStageOneResponse,
  type StageOneCandidate,
  type StageOneOutput,
  type StageOneSelectOptions,
  selectStageOneCandidates,
} from './stageOne';
import { extractPersistableMessages, listMemoryThreads } from './threads';

export type MemoryCompleteSimple = (input: {
  systemPrompt: string;
  userText: string;
  phase: 1 | 2;
}) => Promise<string>;

export type MemoryPipelineProgress = {
  phase: 'stage1' | 'phase2';
  current: number;
  total: number;
};

export type Stage1Artifact = {
  threadId: string;
  sourceUpdatedAt: number;
  rollout_summary: string;
  rollout_slug: string | null;
  raw_memory: string;
};

const ARTIFACTS_FILE = 'stage1_outputs.json';
const PHASE1_INPUT_TOKEN_LIMIT = 12_000;
const PHASE2_RAW_TOKEN_LIMIT = 20_000;
const PHASE2_SUMMARY_TOKEN_LIMIT = 12_000;
const PER_ARTIFACT_RAW_CHARS = 6_000;
const MAX_RAW_MEMORIES_FOR_GLOBAL = 200;
const PRIOR_MD_TOKEN_LIMIT = 10_000;
const PRIOR_SUMMARY_TOKEN_LIMIT = 2_000;
/** 低于此宽度的剩余预算不值得再塑一个 block，直接停止。 */
const MIN_BLOCK_CHARS = 200;

/** OMP `truncateByApproxTokens`: 1 token ≈ 4 chars, keep 60% head + 40% tail. */
export function truncateByApproxTokens(text: string, tokenLimit: number): string {
  if (tokenLimit <= 0) return '';
  const maxChars = tokenLimit * 4;
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n...[truncated]...\n\n${text.slice(-tail)}`;
}

/** 按头尾各保留一部分截断 raw_memory，中间插入截断标记。 */
function capRawMemory(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = '\n...[truncated]...\n';
  const avail = Math.max(0, maxChars - marker.length);
  const head = Math.floor(avail * 0.6);
  const tail = avail - head;
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

export function buildPhaseTwoCorpus(
  artifacts: Stage1Artifact[],
  opts: {
    rawTokenLimit: number;
    perArtifactRawChars: number;
    summaryTokenLimit: number;
    maxRawCandidates: number;
  }
): { raw: string; summaries: string } {
  const sorted = [...artifacts].sort((a, b) => b.sourceUpdatedAt - a.sourceUpdatedAt);

  // raw: 仅在最新 maxRawCandidates 个中按预算逐个放入，每个 block 按剩余预算动态收窄，
  // 预算不足时最新 artifact 被裁剪而不是直接跳过。
  const rawCharBudget = opts.rawTokenLimit * 4;
  const rawCandidates = sorted.slice(0, opts.maxRawCandidates);
  const rawBlocks: string[] = [];
  let usedChars = 0;
  for (const row of rawCandidates) {
    const rawMemory = row.raw_memory.trim();
    if (!rawMemory) continue;
    const remaining = rawCharBudget - usedChars;
    if (remaining <= MIN_BLOCK_CHARS) break;
    const header = `## ${row.threadId}\nupdated_at: ${row.sourceUpdatedAt}\n\n`;
    const footer = '\n';
    const available = remaining - header.length - footer.length;
    if (available <= 0) break;
    const cap = Math.min(opts.perArtifactRawChars, available);
    const cappedRaw = capRawMemory(rawMemory, cap);
    const block = `${header}${cappedRaw}${footer}`;
    rawBlocks.push(block);
    usedChars += block.length;
  }

  // summaries: 新到旧遍历全部 artifacts，超预算就停止——等价于从最旧的开始丢弃。
  const summaryCharBudget = opts.summaryTokenLimit * 4;
  const summaryBlocks: string[] = [];
  let summaryChars = 0;
  for (const row of sorted) {
    const block = `--- ${row.threadId} ---\n${row.rollout_summary.trim()}`;
    const additional = summaryBlocks.length ? block.length + 2 : block.length;
    if (summaryChars + additional > summaryCharBudget) break;
    summaryBlocks.push(block);
    summaryChars += additional;
  }

  return { raw: rawBlocks.join('\n'), summaries: summaryBlocks.join('\n\n') };
}

async function loadPriorMemory(
  memoryRoot: string
): Promise<{ memoryMd: string; summary: string } | undefined> {
  const readOrEmpty = async (file: string) => {
    try {
      return await readFile(path.join(memoryRoot, file), 'utf8');
    } catch {
      return '';
    }
  };
  const [memoryMd, summary] = await Promise.all([
    readOrEmpty('MEMORY.md'),
    readOrEmpty('memory_summary.md'),
  ]);
  if (!memoryMd.trim() && !summary.trim()) return undefined;
  return {
    memoryMd: truncateByApproxTokens(memoryMd, PRIOR_MD_TOKEN_LIMIT),
    summary: truncateByApproxTokens(summary, PRIOR_SUMMARY_TOKEN_LIMIT),
  };
}

async function loadArtifacts(memoryRoot: string): Promise<Stage1Artifact[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(memoryRoot, ARTIFACTS_FILE), 'utf8'));
    return Array.isArray(parsed) ? (parsed as Stage1Artifact[]) : [];
  } catch {
    return [];
  }
}

async function saveArtifacts(memoryRoot: string, artifacts: Stage1Artifact[]): Promise<void> {
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(path.join(memoryRoot, ARTIFACTS_FILE), `${JSON.stringify(artifacts, null, 2)}\n`);
}

function isUsableStage1(output: StageOneOutput): boolean {
  return Boolean(output.raw_memory.trim() && output.rollout_summary.trim());
}

function upsertArtifact(list: Stage1Artifact[], next: Stage1Artifact): Stage1Artifact[] {
  return [...list.filter((row) => row.threadId !== next.threadId), next];
}

export async function runMemoryPipeline(opts: {
  memoryRoot: string;
  sessionDir: string;
  cwd: string;
  currentThreadId?: string;
  nowSec: number;
  workerToken: string;
  completeSimple: MemoryCompleteSimple;
  onProgress?: (progress: MemoryPipelineProgress) => void;
  /** 调试用：覆盖 stage 1 候选筛选阈值（idle / age / 每次上限） */
  stageOneSelect?: Omit<StageOneSelectOptions, 'nowSec' | 'currentThreadId'>;
  /** stage 1 模型调用并发数（jobs / artifacts 落盘仍按批串行），缺省 1 */
  stageOneConcurrency?: number;
}): Promise<{ stage1Claimed: number; phase2Ran: boolean }> {
  const threads = await listMemoryThreads(opts.sessionDir, { cwd: opts.cwd });
  const candidates = selectStageOneCandidates(threads, {
    ...opts.stageOneSelect,
    nowSec: opts.nowSec,
    currentThreadId: opts.currentThreadId,
  });
  let jobs = await loadJobs(opts.memoryRoot);
  const claimable = candidates.filter(
    (thread) =>
      claimStage1(jobs, thread, {
        nowSec: opts.nowSec,
        leaseSeconds: 120,
        workerToken: opts.workerToken,
      }).claimed
  );
  const total = Math.max(1, claimable.length + 1);
  opts.onProgress?.({ phase: 'stage1', current: 0, total });
  let artifacts = await loadArtifacts(opts.memoryRoot);
  let stage1Claimed = 0;
  let produced = false;

  const concurrency = Math.max(1, Math.floor(opts.stageOneConcurrency ?? 1));
  const extractOne = async (thread: StageOneCandidate): Promise<StageOneOutput | undefined> => {
    let payload = '';
    try {
      payload = await readFile(thread.sessionFile, 'utf8');
    } catch {
      return undefined;
    }
    const items = extractPersistableMessages(payload);
    const text = await opts.completeSimple({
      phase: 1,
      systemPrompt: STAGE_ONE_SYSTEM,
      userText: stageOneUser(
        thread.threadId,
        truncateByApproxTokens(JSON.stringify(items), PHASE1_INPUT_TOKEN_LIMIT)
      ),
    });
    return parseStageOneResponse(text);
  };

  for (let i = 0; i < candidates.length; i += concurrency) {
    // 批内：先串行 claim + 落盘，再并行调模型，最后串行 markDone / 写 artifacts
    const batch: Array<{ thread: StageOneCandidate; token: string }> = [];
    for (const thread of candidates.slice(i, i + concurrency)) {
      const claim = claimStage1(jobs, thread, {
        nowSec: opts.nowSec,
        leaseSeconds: 120,
        workerToken: opts.workerToken,
      });
      if (!claim.claimed || !claim.token) continue;
      jobs = claim.state;
      batch.push({ thread, token: claim.token });
    }
    if (batch.length === 0) continue;
    await saveJobs(opts.memoryRoot, jobs);
    stage1Claimed += batch.length;
    const results = await Promise.all(batch.map(({ thread }) => extractOne(thread)));
    for (const [index, { thread, token }] of batch.entries()) {
      const parsed = results[index];
      const done = markStage1Done(jobs, thread.threadId, {
        token,
        watermark: thread.updatedAtSec,
      });
      if (done) jobs = done;
      if (!parsed || !isUsableStage1(parsed)) continue;
      produced = true;
      artifacts = upsertArtifact(artifacts, {
        threadId: thread.threadId,
        sourceUpdatedAt: thread.updatedAtSec,
        ...parsed,
      });
    }
    await saveJobs(opts.memoryRoot, jobs);
    if (produced) await saveArtifacts(opts.memoryRoot, artifacts);
    opts.onProgress?.({ phase: 'stage1', current: stage1Claimed, total });
  }

  const forced = jobs.global.dirty === true;
  if (!produced && !forced) {
    opts.onProgress?.({ phase: 'phase2', current: total, total });
    return { stage1Claimed, phase2Ran: false };
  }
  if (forced && artifacts.length === 0) {
    jobs = { ...jobs, global: { ...jobs.global, dirty: undefined, status: 'done' } };
    await saveJobs(opts.memoryRoot, jobs);
    opts.onProgress?.({ phase: 'phase2', current: total, total });
    return { stage1Claimed, phase2Ran: false };
  }

  const newWatermark = Math.max(
    forced ? jobs.global.watermark + 1 : 0,
    ...artifacts.map((row) => row.sourceUpdatedAt)
  );
  const phase2 = tryClaimPhase2(jobs, {
    nowSec: opts.nowSec,
    leaseSeconds: 180,
    workerToken: opts.workerToken,
    newWatermark,
  });
  if (!phase2.claimed) {
    opts.onProgress?.({ phase: 'phase2', current: total, total });
    return { stage1Claimed, phase2Ran: false };
  }
  jobs = phase2.state;
  await saveJobs(opts.memoryRoot, jobs);
  opts.onProgress?.({ phase: 'phase2', current: stage1Claimed, total });

  const { raw, summaries } = buildPhaseTwoCorpus(artifacts, {
    rawTokenLimit: PHASE2_RAW_TOKEN_LIMIT,
    perArtifactRawChars: PER_ARTIFACT_RAW_CHARS,
    summaryTokenLimit: PHASE2_SUMMARY_TOKEN_LIMIT,
    maxRawCandidates: MAX_RAW_MEMORIES_FOR_GLOBAL,
  });
  const prior = await loadPriorMemory(opts.memoryRoot);
  // 失败（超时 / 解析不了）必须释放租约并保留 dirty，否则 running 状态挂到租约到期且重建请求丢失
  const releasePhase2 = async () => {
    jobs = {
      ...jobs,
      global: {
        watermark: jobs.global.watermark,
        status: 'failed',
        ...(forced ? { dirty: true } : {}),
      },
    };
    await saveJobs(opts.memoryRoot, jobs);
    opts.onProgress?.({ phase: 'phase2', current: total, total });
  };
  let text: string;
  try {
    text = await opts.completeSimple({
      phase: 2,
      systemPrompt: CONSOLIDATION_SYSTEM,
      userText: consolidationUser({
        prior,
        rawMemories: `# Raw Memories\n\n${raw}`,
        rolloutSummaries: summaries || 'No rollout summaries yet.',
      }),
    });
  } catch (error) {
    await releasePhase2();
    throw error;
  }
  const parsed = parsePhaseTwoResponse(text);
  if (!parsed?.memory_md.trim() || !parsed.memory_summary.trim()) {
    await releasePhase2();
    return { stage1Claimed, phase2Ran: false };
  }
  await applyConsolidation(opts.memoryRoot, parsed);
  jobs = {
    ...jobs,
    global: {
      watermark: newWatermark,
      status: 'done',
    },
  };
  await saveJobs(opts.memoryRoot, jobs);
  opts.onProgress?.({ phase: 'phase2', current: total, total });
  return { stage1Claimed, phase2Ran: true };
}
