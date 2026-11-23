import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullRunReason, planNodeTests, selectTests } from './test-changed.mjs';

const deps = {
  'src/a.test.ts': ['src/a.ts', 'src/shared/util.ts'],
  'src/b.test.ts': ['src/b.ts', 'src/shared/util.ts'],
  'src/c.test.ts': ['src/c.ts'],
  'src/d.test.ts': ['src/d.ts'],
  'src/e.test.ts': ['src/e.ts'],
};
const testFiles = Object.keys(deps);
const depsOf = (file) => new Set(deps[file]);
const plan = (changed) => selectTests({ changed, testFiles, depsOf });

test('只改测试文件：只跑它自己', () => {
  assert.deepEqual(
    [...plan(['src/c.test.ts']).entries()],
    [['src/c.test.ts', ['测试文件本身改动']]]
  );
});

test('改共享模块：跑所有依赖它的测试，并写明原因', () => {
  assert.deepEqual(
    [...plan(['src/shared/util.ts', 'src/a.test.ts']).entries()],
    [
      ['src/a.test.ts', ['测试文件本身改动', '依赖 src/shared/util.ts']],
      ['src/b.test.ts', ['依赖 src/shared/util.ts']],
    ]
  );
});

test('没有测试依赖的改动（文档等）：不跑任何测试', () => {
  assert.equal(plan(['docs/x.md', 'README.md']).size, 0);
});

test('配置、依赖、测试基建改动：退回全量', () => {
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'vitest.config.ts',
    'tsconfig.node.json',
    '.nvmrc',
    'test/setup.ts',
    'test/stubs/electron.ts',
    'patches/foo.patch',
    'packages/pair/package.json',
  ]) {
    assert.match(
      fullRunReason(['src/a.ts', file]) ?? '',
      new RegExp(file.replace('.', '\\.')),
      file
    );
  }
  assert.equal(fullRunReason(['src/a.ts', 'docs/x.md', 'scripts/rtk.mjs']), undefined);
});

test('node --test 脚本：改了脚本或它的测试就跑对应测试', () => {
  const nodeTests = ['scripts/rtk.test.mjs', 'scripts/beta-release.test.mjs'];
  assert.deepEqual(planNodeTests(['scripts/rtk.mjs', 'src/a.ts'], nodeTests), [
    'scripts/rtk.test.mjs',
  ]);
  assert.deepEqual(planNodeTests(['scripts/beta-release.test.mjs'], nodeTests), [
    'scripts/beta-release.test.mjs',
  ]);
  assert.deepEqual(planNodeTests(['scripts/other.mjs'], nodeTests), []);
});
