import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideRetryUnacquiredRun,
  hasNewerRun,
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
  name: 'desktop / build-mac (arm64)',
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
  // 被 cancel-in-progress 并发组取消（即使零步骤、未分配 runner）
  assert.equal(
    isUnacquiredRunnerJob(makeJob(), [
      {
        annotation_level: 'notice',
        message: "Canceling since a higher priority waiting request for 'beta-build' exists",
      },
    ]),
    false
  );
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

test('只要存在 run_number 更大的更新运行（不论其状态），均视为已被取代', () => {
  const current = makeRun({ id: 500, run_number: 146 });
  assert.equal(hasNewerRun(current, [current]), false);
  // 更旧的运行不算取代
  assert.equal(
    hasNewerRun(current, [current, makeRun({ id: 499, run_number: 145, conclusion: 'success' })]),
    false
  );
  // 更新的运行处于任意状态（排队、运行中、成功、失败、被取消、被跳过）都意味着已有更新的提交，绝不再重跑旧轮次
  for (const newer of [
    makeRun({ id: 501, run_number: 147, status: 'queued', conclusion: null }),
    makeRun({ id: 501, run_number: 147, status: 'in_progress', conclusion: null }),
    makeRun({ id: 501, run_number: 147, status: 'completed', conclusion: 'success' }),
    makeRun({ id: 501, run_number: 147, status: 'completed', conclusion: 'failure' }),
    makeRun({ id: 501, run_number: 147, status: 'completed', conclusion: 'cancelled' }),
    makeRun({ id: 501, run_number: 147, status: 'completed', conclusion: 'skipped' }),
  ]) {
    assert.equal(hasNewerRun(current, [current, newer]), true);
  }
});

test('双机并行中一台已成功、另一台未拿到 runner 且未被新 run 取代时，仅重跑缺失架构', () => {
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
    makeJob({
      id: 21,
      name: 'desktop / build-mac (x64)',
      conclusion: 'success',
      steps: [{ name: 'Build macOS (x64)' }],
      runner_id: 21,
      runner_name: 'mac-x64',
    }),
    makeJob({ id: 3, name: 'release', conclusion: 'skipped', steps: [] }),
  ];
  const unacquiredMac = makeJob({ id: 4, name: 'desktop / build-mac (arm64)' });

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
  const unacquiredMac = makeJob({ id: 4, name: 'desktop / build-mac (arm64)' });
  const realFailedWin = makeJob({
    id: 5,
    name: 'desktop / build-windows',
    conclusion: 'failure',
    steps: [{ name: 'Build Windows' }],
    runner_id: 99,
    runner_name: 'GitHub Actions 99',
  });
  const concurrencyCancelledX64 = makeJob({
    id: 6,
    name: 'desktop / build-mac (x64)',
    conclusion: 'cancelled',
    steps: [{ name: 'Build macOS (x64)' }],
    runner_id: 100,
    runner_name: 'mac-x64',
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

  // 一台未拿到 runner、另一台被新轮次 concurrency 取消：绝不重跑
  assert.deepEqual(
    decideRetryUnacquiredRun({
      run: makeRun(),
      jobs: [unacquiredMac, concurrencyCancelledX64],
      annotationsByJobId: {
        4: unacquiredAnnotations,
        6: [
          {
            annotation_level: 'notice',
            message: "Canceling since a higher priority waiting request for 'beta-build' exists",
          },
        ],
      },
      recentRuns: [makeRun()],
    }),
    { retry: false, reason: 'real_failure_or_manual_cancel', unacquiredJobIds: [] }
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

  // 已有更新的 Beta 存在（即使新轮次自己失败或被更更新的取消），也不回头重跑旧轮次
  assert.deepEqual(
    decideRetryUnacquiredRun({
      run: makeRun(),
      jobs: [unacquiredMac],
      annotationsByJobId: { 4: unacquiredAnnotations },
      recentRuns: [
        makeRun(),
        makeRun({ id: 501, run_number: 147, status: 'completed', conclusion: 'failure' }),
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
