import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claimStage1, loadJobs, markStage1Done, saveJobs, tryClaimPhase2 } from './jobs';
import { applyConsolidation, parsePhaseTwoResponse } from './phaseTwo';
import { CONSOLIDATION_SYSTEM, consolidationUser, STAGE_ONE_SYSTEM, stageOneUser } from './prompts';
import { parseStageOneResponse, type StageOneOutput, selectStageOneCandidates } from './stageOne';
import { extractPersistableMessages, listMemoryThreads } from './threads';

export type MemoryCompleteSimple = (input: {
  systemPrompt: string;
  userText: string;
  phase: 1 | 2;
}) => Promise<string>;

export type Stage1Artifact = {
  threadId: string;
  sourceUpdatedAt: number;
  rollout_summary: string;
  rollout_slug: string | null;
  raw_memory: string;
};

const ARTIFACTS_FILE = 'stage1_outputs.json';
const PHASE1_INPUT_TOKEN_LIMIT = 4000;
const PHASE2_RAW_TOKEN_LIMIT = 20_000;
const PHASE2_SUMMARY_TOKEN_LIMIT = 12_000;
const MAX_RAW_MEMORIES_FOR_GLOBAL = 200;

/** OMP `truncateByApproxTokens`: 1 token ≈ 4 chars, keep 60% head + 40% tail. */
export function truncateByApproxTokens(text: string, tokenLimit: number): string {
  if (tokenLimit <= 0) return '';
  const maxChars = tokenLimit * 4;
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n...[truncated]...\n\n${text.slice(-tail)}`;
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
}): Promise<{ stage1Claimed: number; phase2Ran: boolean }> {
  const threads = await listMemoryThreads(opts.sessionDir, { cwd: opts.cwd });
  const candidates = selectStageOneCandidates(threads, {
    nowSec: opts.nowSec,
    currentThreadId: opts.currentThreadId,
  });
  let jobs = await loadJobs(opts.memoryRoot);
  let artifacts = await loadArtifacts(opts.memoryRoot);
  let stage1Claimed = 0;
  let produced = false;

  for (const thread of candidates) {
    const claim = claimStage1(jobs, thread, {
      nowSec: opts.nowSec,
      leaseSeconds: 120,
      workerToken: opts.workerToken,
    });
    if (!claim.claimed || !claim.token) continue;
    jobs = claim.state;
    await saveJobs(opts.memoryRoot, jobs);
    stage1Claimed += 1;
    let payload = '';
    try {
      payload = await readFile(thread.sessionFile, 'utf8');
    } catch {
      continue;
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
    const parsed = parseStageOneResponse(text);
    const done = markStage1Done(jobs, thread.threadId, {
      token: claim.token,
      watermark: thread.updatedAtSec,
    });
    if (done) {
      jobs = done;
      await saveJobs(opts.memoryRoot, jobs);
    }
    if (!parsed || !isUsableStage1(parsed)) continue;
    produced = true;
    artifacts = upsertArtifact(artifacts, {
      threadId: thread.threadId,
      sourceUpdatedAt: thread.updatedAtSec,
      ...parsed,
    });
    await saveArtifacts(opts.memoryRoot, artifacts);
  }

  const forced = jobs.global.dirty === true;
  if (!produced && !forced) return { stage1Claimed, phase2Ran: false };
  if (forced && artifacts.length === 0) {
    jobs = { ...jobs, global: { ...jobs.global, dirty: undefined, status: 'done' } };
    await saveJobs(opts.memoryRoot, jobs);
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
  if (!phase2.claimed) return { stage1Claimed, phase2Ran: false };
  jobs = phase2.state;
  await saveJobs(opts.memoryRoot, jobs);

  const forGlobal = [...artifacts]
    .sort((a, b) => b.sourceUpdatedAt - a.sourceUpdatedAt)
    .slice(0, MAX_RAW_MEMORIES_FOR_GLOBAL);
  const raw = truncateByApproxTokens(
    forGlobal
      .map(
        (row) =>
          `## ${row.threadId}\nupdated_at: ${row.sourceUpdatedAt}\n\n${row.raw_memory.trim()}\n`
      )
      .join('\n'),
    PHASE2_RAW_TOKEN_LIMIT
  );
  const summaries = truncateByApproxTokens(
    forGlobal.map((row) => `--- ${row.threadId} ---\n${row.rollout_summary.trim()}`).join('\n\n'),
    PHASE2_SUMMARY_TOKEN_LIMIT
  );
  const text = await opts.completeSimple({
    phase: 2,
    systemPrompt: CONSOLIDATION_SYSTEM,
    userText: consolidationUser(
      `# Raw Memories\n\n${raw}`,
      summaries || 'No rollout summaries yet.'
    ),
  });
  const parsed = parsePhaseTwoResponse(text);
  if (!parsed?.memory_md.trim() || !parsed.memory_summary.trim()) {
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
  return { stage1Claimed, phase2Ran: true };
}
