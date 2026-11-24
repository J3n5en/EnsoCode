import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { betaTagsToPrune, parseReleases, supersedingBeta } from './beta-release.mjs';

const SCRIPT = fileURLToPath(new URL('./beta-release.mjs', import.meta.url));

/** 临时 git 仓库模拟 main：release() 提交 chore(release) 并打正式 tag，commit() 普通提交，version() 跑 CI 同款命令 */
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'beta-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  git('init', '-q', '-b', 'main');
  let n = 0;
  const commit = (msg = `fix: ${++n}`) => git('commit', '-q', '--allow-empty', '-m', msg);
  return {
    commit,
    release(version, tag = true) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
      git('add', 'package.json');
      commit(`chore(release): ${version}`);
      if (tag) git('tag', `v${version}`);
    },
    version: (runNumber) =>
      execFileSync('node', [SCRIPT, 'version', String(runNumber)], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
  };
}

test('beta 序号：每个正式版之后从 1 重新数，同一基线内随提交严格递增，与 run_number 无关', (t) => {
  const r = repo(t);
  r.release('0.3.15');
  r.commit();
  assert.equal(r.version(301), '0.3.16-beta.1');
  r.commit();
  r.commit();
  assert.equal(r.version(302), '0.3.16-beta.3');
  // 重跑同一提交：编号不变，由发布前的 supersedingBeta 跳过
  assert.equal(r.version(999), '0.3.16-beta.3');
  // 新正式版：基线切换，回到 1
  r.release('0.3.16');
  r.commit();
  assert.equal(r.version(303), '0.3.17-beta.1');
});

test('0.3.15 这一轮已按 run_number 发到 beta.19x，沿用 run_number 保持单调', (t) => {
  const r = repo(t);
  r.release('0.3.14');
  r.commit();
  assert.equal(r.version(201), '0.3.15-beta.201');
  for (const bad of [0, -1, '1.5', '']) assert.throws(() => r.version(bad));
});

test('基线正式 tag 不存在或 HEAD 就是发版提交时报错，不发出错号', (t) => {
  const r = repo(t);
  r.release('0.3.15');
  assert.throws(() => r.version(1));
  const s = repo(t);
  s.release('0.3.15', false);
  s.commit();
  assert.throws(() => s.version(1));
});

const rel = (tag_name, prerelease = true, draft = false) => ({ tag_name, prerelease, draft });

test('发布前：同基线已有不小于本次编号的已发布 beta 就跳过（重跑、乱序），被取消只会跳号', () => {
  const releases = [
    rel('v0.3.16', false),
    rel('v0.3.17-beta.3'),
    rel('v0.3.17-beta.9', true, true),
    rel('v0.3.16-beta.40'),
  ];
  assert.equal(supersedingBeta(releases, '0.3.17-beta.3'), 'v0.3.17-beta.3');
  assert.equal(supersedingBeta(releases, '0.3.17-beta.2'), 'v0.3.17-beta.3');
  // 中间 .4 的轮次被取消：.5 照常发
  assert.equal(supersedingBeta(releases, '0.3.17-beta.5'), null);
  assert.equal(supersedingBeta(releases, '0.3.18-beta.1'), null);
  assert.equal(supersedingBeta([], '0.3.17-beta.1'), null);
  assert.throws(() => supersedingBeta(releases, '0.3.17'));
});

test('清理只动已发布的 -beta. 预发布，按版本保留最新几个', () => {
  const releases = [
    rel('v0.3.12', false),
    rel('v0.3.11', false),
    rel('v0.3.10', false, true),
    rel('v0.3.13-beta.9'),
    rel('v0.3.13-beta.10'),
    rel('v0.3.13-beta.2'),
    rel('v0.3.14-beta.11'),
    rel('v0.3.13-beta.1'),
    rel('v0.3.13-beta.3'),
    rel('v0.3.13-beta.4', true, true),
    rel('v0.3.13-beta.5', false),
    rel('v0.3.13-rc.1'),
    rel('v0.3.13-beta.6-hotfix'),
  ];
  assert.deepEqual(betaTagsToPrune(releases, 5), ['v0.3.13-beta.1']);
  assert.deepEqual(betaTagsToPrune(releases, 2), [
    'v0.3.13-beta.9',
    'v0.3.13-beta.3',
    'v0.3.13-beta.2',
    'v0.3.13-beta.1',
  ]);
  assert.deepEqual(betaTagsToPrune(releases.slice(0, 3), 5), []);
  assert.throws(() => betaTagsToPrune(releases, 0));
});

test('releases 输入支持 JSON 数组与 JSON Lines', () => {
  assert.deepEqual(parseReleases('[{"tag_name":"v1"}]'), [{ tag_name: 'v1' }]);
  assert.deepEqual(parseReleases('{"tag_name":"v1"}\n{"tag_name":"v2"}\n'), [
    { tag_name: 'v1' },
    { tag_name: 'v2' },
  ]);
  assert.deepEqual(parseReleases('  '), []);
});
