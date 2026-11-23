#!/usr/bin/env node
// 当 Beta 因 GitHub 托管 macOS runner 排队超时（未拿到 runner、零步骤 cancelled）导致整轮标红时，
// 仅在满足严格条件（非真实构建失败、未超重试上限、未被更新运行取代）下自动 rerun-failed-jobs。
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const UNACQUIRED_MARKER = 'The job was not acquired by Runner';

export function isUnacquiredRunnerJob(job, annotations) {
  if (job?.conclusion !== 'cancelled') return false;
  if (!Array.isArray(job.steps) || job.steps.length !== 0) return false;
  if (job.runner_id || job.runner_name) return false;
  if (!Array.isArray(annotations)) return false;
  return annotations.some(
    (item) =>
      item?.annotation_level === 'failure' &&
      typeof item.message === 'string' &&
      item.message.includes(UNACQUIRED_MARKER)
  );
}

export function hasNewerActiveOrSucceededRun(run, recentRuns) {
  if (!run || !Array.isArray(recentRuns)) return false;
  const currentNumber = Number(run.run_number);
  if (!Number.isFinite(currentNumber)) return false;
  return recentRuns.some((other) => {
    if (!other || other.id === run.id) return false;
    if (Number(other.run_number) <= currentNumber) return false;
    return other.status !== 'completed' || other.conclusion === 'success';
  });
}

export function decideRetryUnacquiredRun({
  run,
  jobs,
  annotationsByJobId = {},
  recentRuns = [],
  maxAttempts = 3,
}) {
  if (run?.conclusion !== 'failure') {
    return { retry: false, reason: 'run_not_failed', unacquiredJobIds: [] };
  }
  if (Number(run.run_attempt ?? 1) >= maxAttempts) {
    return { retry: false, reason: 'max_attempts_reached', unacquiredJobIds: [] };
  }
  if (hasNewerActiveOrSucceededRun(run, recentRuns)) {
    return { retry: false, reason: 'superseded_by_newer_run', unacquiredJobIds: [] };
  }
  const problemJobs = (jobs ?? []).filter(
    (job) => job.conclusion !== 'success' && job.conclusion !== 'skipped'
  );
  if (problemJobs.length === 0) {
    return { retry: false, reason: 'no_problem_jobs', unacquiredJobIds: [] };
  }
  const allUnacquired = problemJobs.every((job) =>
    isUnacquiredRunnerJob(job, annotationsByJobId[job.id] ?? [])
  );
  if (!allUnacquired) {
    return { retry: false, reason: 'real_failure_or_manual_cancel', unacquiredJobIds: [] };
  }
  return {
    retry: true,
    reason: 'all_problem_jobs_unacquired',
    unacquiredJobIds: problemJobs.map((job) => job.id),
  };
}

function ghApiJson(endpoint, method = 'GET') {
  const args = ['api'];
  if (method !== 'GET') args.push('--method', method);
  args.push(endpoint);
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : null;
}

function writeSummary(line) {
  console.log(line);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, `${line}\n`, 'utf8');
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.TARGET_RUN_ID;
  const maxAttempts = Number(process.env.MAX_ATTEMPTS ?? 3);
  const retryDelaySeconds = Number(process.env.RETRY_DELAY_SECONDS ?? 30);
  if (!repo || !runId) {
    throw new Error('GITHUB_REPOSITORY and TARGET_RUN_ID are required');
  }

  const run = ghApiJson(`repos/${repo}/actions/runs/${runId}`);
  const jobs = ghApiJson(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`).jobs ?? [];
  const problemJobs = jobs.filter(
    (job) => job.conclusion !== 'success' && job.conclusion !== 'skipped'
  );
  const annotationsByJobId = {};
  for (const job of problemJobs) {
    annotationsByJobId[job.id] = ghApiJson(`repos/${repo}/check-runs/${job.id}/annotations`) ?? [];
  }
  const recentRuns =
    ghApiJson(`repos/${repo}/actions/workflows/${run.workflow_id}/runs?per_page=20`)
      .workflow_runs ?? [];

  const decision = decideRetryUnacquiredRun({
    run,
    jobs,
    annotationsByJobId,
    recentRuns,
    maxAttempts,
  });
  if (!decision.retry) {
    writeSummary(
      `跳过重跑 run #${run.run_number} (${runId}, attempt ${run.run_attempt}): ${decision.reason}`
    );
    return;
  }

  if (retryDelaySeconds > 0) {
    console.log(`等待 ${retryDelaySeconds}s 后复查并重跑...`);
    await delay(retryDelaySeconds * 1000);
    const latestRuns =
      ghApiJson(`repos/${repo}/actions/workflows/${run.workflow_id}/runs?per_page=20`)
        .workflow_runs ?? [];
    if (hasNewerActiveOrSucceededRun(run, latestRuns)) {
      writeSummary(`退避期间已有更新的 Beta 运行，取消重跑 run #${run.run_number} (${runId})`);
      return;
    }
  }

  ghApiJson(`repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, 'POST');
  writeSummary(
    `已自动触发 rerun-failed-jobs：run #${run.run_number} (${runId}, attempt ${run.run_attempt} -> ${Number(run.run_attempt ?? 1) + 1})，未拿到 runner 的 jobs: ${decision.unacquiredJobIds.join(', ')}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
