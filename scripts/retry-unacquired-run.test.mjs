import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideRetryUnacquiredRun,
  hasNewerActiveOrSucceededRun,
  isUnacquiredRunnerJob,
  UNACQUIRED_MARKER,
} from './retry-unacquired-run.mjs';

const unacquiredAnnotations = [
  {
    annotation_level: 'failure',
    message: `${UNACQUIRED_MARKER} of type hosted even after multiple attempts`,
  },
  {
    annotation_level: 'notice',
    message:
      'Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.',
  },
];

const makeJob = (overrides = {}) => ({
  id: 1001,
  name: 'desktop / build-mac',
  conclusion: 'cancelled',
  steps: [],
  runner_id: 0,
  runner_name: '',
  ...overrides,
});

const makeRun = (overrides = {}) => ({
  id: 500,
  run_number: 146,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'failure',
  workflow_id: 99,
  ...overrides,
});

test('仅将零步骤、未分配 runner 且带平台未获取报错的 cancelled job 视为未拿到 runner', () => {
  assert.equal(isUnacquiredRunnerJob(makeJob(), unacquiredAnnotations), true);
  assert.equal(
    isUnacquiredRunnerJob(makeJob({ runner_id: null, runner_name: null }), unacquiredAnnotations),
    true
  );

  // 真实构建失败
  assert.equal(
    isUnacquiredRunnerJob(makeJob({ conclusion: 'failure' }), unacquiredAnnotations),
    false
  );
  // 已执行过任意步骤（如超时或中途被取消）
  assert.equal(
    isUnacquiredRunnerJob(makeJob({ steps: [{ name: 'Set up job' }] }), unacquiredAnnotations),
    false
  );
  // 已分配过 runner
  assert.equal(
    isUnacquiredRunnerJob(
      makeJob({ runner_id: 12345, runner_name: 'GitHub Actions 1' }),
      unacquiredAnnotations
    ),
    false
  );
  // 手动取消或无平台 annotation
  assert.equal(isUnacquiredRunnerJob(makeJob(), []), false);
  // 只有 notice 没有 failure annotation
  assert.equal(
    isUnacquiredRunnerJob(makeJob(), [
      { annotation_level: 'notice', message: `${UNACQUIRED_MARKER} of type hosted` },
    ]),
    false
  );
  // 缺少 steps 字段的脏输入
  assert.equal(isUnacquiredRunnerJob(makeJob({ steps: undefined }), unacquiredAnnotations), false);
});

test('有更新的运行正在进行或已成功时，视为已被取代', () => {
  const current = makeRun({ id: 500, run_number: 146 });
  assert.equal(hasNewerActiveOrSucceededRun(current, [current]), false);
  // 更旧的运行不算取代
  assert.equal(
    hasNewerActiveOrSucceededRun(current, [
      current,
      makeRun({ id: 499, run_number: 145, conclusion: 'success' }),
    ]),
    false
  );
  // 更新的运行也失败或被取消不算取代
  assert.equal(
    hasNewerActiveOrSucceededRun(current, [
      current,
      makeRun({ id: 501, run_number: 147, status: 'completed', conclusion: 'cancelled' }),
      makeRun({ id: 502, run_number: 148, status: 'completed', conclusion: 'failure' }),
    ]),
    false
  );
  // 更新的运行正在排队或运行中
  assert.equal(
    hasNewerActiveOrSucceededRun(current, [
      current,
      makeRun({ id: 501, run_number: 147, status: 'queued', conclusion: null }),
    ]),
    true
  );
  assert.equal(
    hasNewerActiveOrSucceededRun(current, [
      current,
      makeRun({ id: 501, run_number: 147, status: 'in_progress', conclusion: null }),
    ]),
    true
  );
  // 更新的运行已经成功发版
  assert.equal(
    hasNewerActiveOrSucceededRun(current, [
      current,
      makeRun({ id: 501, run_number: 147, status: 'completed', conclusion: 'success' }),
    ]),
    true
  );
});

test('所有异常 job 均为未拿到 runner 且未超重试上限、未被新 run 取代时才允许重跑', () => {
  const okJobs = [
    makeJob({
      id: 1,
      name: 'prepare',
      conclusion: 'success',
      steps: [{ name: 'a' }],
      runner_id: 1,
      runner_name: 'r1',
    }),
    makeJob({
      id: 2,
      name: 'desktop / build-linux',
      conclusion: 'success',
      steps: [{ name: 'a' }],
      runner_id: 2,
      runner_name: 'r2',
    }),
    makeJob({ id: 3, name: 'release', conclusion: 'skipped', steps: [] }),
  ];
  const unacquiredMac = makeJob({ id: 4, name: 'desktop / build-mac' });

  const decision = decideRetryUnacquiredRun({
    run: makeRun(),
    jobs: [...okJobs, unacquiredMac],
    annotationsByJobId: { 4: unacquiredAnnotations },
    recentRuns: [makeRun()],
    maxAttempts: 3,
  });
  assert.deepEqual(decision, {
    retry: true,
    reason: 'all_problem_jobs_unacquired',
    unacquiredJobIds: [4],
  });
});

test('任一真实失败、达到上限、非 failure 结论或已被取代时都拒绝重跑', () => {
  const unacquiredMac = makeJob({ id: 4, name: 'desktop / build-mac' });
  const realFailedWin = makeJob({
    id: 5,
    name: 'desktop / build-windows',
    conclusion: 'failure',
    steps: [{ name: 'Build Windows' }],
    runner_id: 99,
    runner_name: 'GitHub Actions 99',
  });

  // 混入真实失败：绝不吞掉或重跑
  assert.equal(
    decideRetryUnacquiredRun({
      run: makeRun(),
      jobs: [unacquiredMac, realFailedWin],
      annotationsByJobId: { 4: unacquiredAnnotations, 5: [] },
      recentRuns: [makeRun()],
    }).retry,
    false
  );

  // 达到最大尝试次数（默认 3）
  assert.deepEqual(
    decideRetryUnacquiredRun({
      run: makeRun({ run_attempt: 3 }),
      jobs: [unacquiredMac],
      annotationsByJobId: { 4: unacquiredAnnotations },
      recentRuns: [makeRun({ run_attempt: 3 })],
    }),
    { retry: false, reason: 'max_attempts_reached', unacquiredJobIds: [] }
  );

  // 整轮被 concurrency 取消的 run 不重跑
  assert.deepEqual(
    decideRetryUnacquiredRun({
      run: makeRun({ conclusion: 'cancelled' }),
      jobs: [],
      annotationsByJobId: {},
      recentRuns: [],
    }),
    { retry: false, reason: 'run_not_failed', unacquiredJobIds: [] }
  );

  // 已有更新的 Beta 在跑
  assert.deepEqual(
    decideRetryUnacquiredRun({
      run: makeRun(),
      jobs: [unacquiredMac],
      annotationsByJobId: { 4: unacquiredAnnotations },
      recentRuns: [
        makeRun(),
        makeRun({ id: 501, run_number: 147, status: 'in_progress', conclusion: null }),
      ],
    }),
    { retry: false, reason: 'superseded_by_newer_run', unacquiredJobIds: [] }
  );

  // 没有异常 job 的脏数据不重跑
  assert.deepEqual(
    decideRetryUnacquiredRun({
      run: makeRun(),
      jobs: [
        makeJob({
          id: 1,
          conclusion: 'success',
          steps: [{ name: 'a' }],
          runner_id: 1,
          runner_name: 'r1',
        }),
      ],
      annotationsByJobId: {},
      recentRuns: [makeRun()],
    }),
    { retry: false, reason: 'no_problem_jobs', unacquiredJobIds: [] }
  );
});
