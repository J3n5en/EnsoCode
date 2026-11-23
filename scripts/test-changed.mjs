// 只跑和改动相关的测试：相对 origin/main 的 merge-base 找改动文件，用 vitest 的依赖图挑出受影响的测试。
// 改了配置、依赖或测试基建时退回全量（走本机全量锁）。用法：pnpm test:changed [--base <ref>] [--dry]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FULL_RUN_TRIGGERS = [
  /^package\.json$/,
  /^packages\/[^/]+\/package\.json$/,
  /^pnpm-(lock|workspace)\.yaml$/,
  /^\.nvmrc$/,
  /^tsconfig[^/]*\.json$/,
  /^vitest\.config\./,
  /^test\//,
  /^patches\//,
];
const FULL_RUN_SHARE = 0.5;

export function fullRunReason(changed) {
  const hits = changed.filter((file) => FULL_RUN_TRIGGERS.some((pattern) => pattern.test(file)));
  return hits.length ? `改动了配置、依赖或测试基建：${hits.join(', ')}` : undefined;
}

/** 测试文件 → 选中原因；depsOf 返回该测试（递归）依赖的仓库内文件 */
export function selectTests({ changed, testFiles, depsOf }) {
  const changedSet = new Set(changed);
  const selected = new Map();
  for (const test of testFiles) {
    const reasons = changedSet.has(test) ? ['测试文件本身改动'] : [];
    const deps = depsOf(test);
    for (const file of changed) if (file !== test && deps.has(file)) reasons.push(`依赖 ${file}`);
    if (reasons.length) selected.set(test, reasons);
  }
  return selected;
}

export function planNodeTests(changed, nodeTests) {
  return nodeTests.filter(
    (test) => changed.includes(test) || changed.includes(test.replace(/\.test\.mjs$/, '.mjs'))
  );
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function resolveBase(ref) {
  for (const candidate of ref ? [ref] : ['origin/main', 'main']) {
    try {
      return { ref: candidate, sha: git('merge-base', 'HEAD', candidate) };
    } catch {}
  }
  throw new Error(`找不到基准分支（${ref ?? 'origin/main / main'}），请用 --base <ref> 指定`);
}

function changedFiles(baseSha) {
  const diff = git('diff', '--name-only', '--no-renames', '--diff-filter=d', baseSha);
  const untracked = git('ls-files', '--others', '--exclude-standard');
  return [...new Set([...diff.split('\n'), ...untracked.split('\n')].filter(Boolean))].sort();
}

function run(command, args) {
  return spawnSync(command, args, { stdio: 'inherit' }).status ?? 1;
}

async function runFull(reason) {
  console.log(`[test:changed] ${reason} → 退回全量（走本机全量锁）`);
  process.exit(run(process.execPath, ['scripts/test.mjs']));
}

function printList(title, entries) {
  console.log(title);
  for (const [file, why] of entries) console.log(`  ${file}${why ? `  ← ${why}` : ''}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const baseIndex = args.indexOf('--base');
  const base = resolveBase(baseIndex >= 0 ? args[baseIndex + 1] : undefined);
  const changed = changedFiles(base.sha);
  console.log(
    `[test:changed] 基准 ${base.ref}（merge-base ${base.sha.slice(0, 9)}），改动 ${changed.length} 个文件`
  );
  for (const file of changed) console.log(`  ${file}`);

  const reason = fullRunReason(changed);
  if (reason) return dry ? console.log(`[test:changed] ${reason} → 会退回全量`) : runFull(reason);

  const { NODE_TEST_FILES } = await import('./test.mjs');
  const nodeTests = planNodeTests(changed, NODE_TEST_FILES);

  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', { watch: false, run: true, passWithNoTests: true });
  const root = vitest.config.root;
  const rel = (file) => relative(root, file);
  const specs = await vitest.globTestSpecifications();
  const startedAt = Date.now();
  const deps = new Map(
    await Promise.all(
      specs.map(async (spec) => [
        rel(spec.moduleId),
        new Set([...(await vitest.specifications.getTestDependencies(spec))].map(rel)),
      ])
    )
  );
  const present = changed.filter((file) => existsSync(resolve(root, file)));
  const selected = selectTests({
    changed: present,
    testFiles: [...deps.keys()],
    depsOf: (test) => deps.get(test),
  });
  console.log(
    `[test:changed] 依赖图 ${specs.length} 个测试文件，分析 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
  printList(
    `[test:changed] vitest 将运行 ${selected.size} 个测试文件：`,
    [...selected].map(([file, why]) => [
      file,
      why.slice(0, 3).join('；') + (why.length > 3 ? ` 等 ${why.length} 项` : ''),
    ])
  );
  if (nodeTests.length)
    printList(
      `[test:changed] node --test 将运行 ${nodeTests.length} 个：`,
      nodeTests.map((file) => [file, '脚本或其测试改动'])
    );

  if (selected.size >= specs.length * FULL_RUN_SHARE) {
    await vitest.close();
    const message = `受影响测试 ${selected.size}/${specs.length} 超过 ${FULL_RUN_SHARE * 100}%`;
    return dry ? console.log(`[test:changed] ${message} → 会退回全量`) : runFull(message);
  }
  if (dry) return vitest.close();

  let failed = nodeTests.length ? run(process.execPath, ['--test', ...nodeTests]) !== 0 : false;
  if (selected.size) {
    vitest.config.related = present.map((file) => resolve(root, file));
    const result = await vitest.start();
    failed ||=
      result.unhandledErrors.length > 0 || result.testModules.some((module) => !module.ok());
  }
  await vitest.close();
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
