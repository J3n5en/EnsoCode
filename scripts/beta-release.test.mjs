import assert from 'node:assert/strict';
import { test } from 'node:test';
import { betaTagsToPrune, betaVersion, parseReleases } from './beta-release.mjs';

test('beta 版本号：下一个 patch 加 run_number，夹在当前与下一个正式版之间', () => {
  assert.equal(betaVersion('0.3.12', 12), '0.3.13-beta.12');
  assert.equal(betaVersion('1.9.99', '3'), '1.9.100-beta.3');
  for (const bad of ['0.3.12-beta.1', 'v0.3.12', '0.3']) {
    assert.throws(() => betaVersion(bad, 1));
  }
  for (const bad of [0, -1, '1.5', '', undefined]) {
    assert.throws(() => betaVersion('0.3.12', bad));
  }
});

const rel = (tag_name, prerelease = true, draft = false) => ({ tag_name, prerelease, draft });

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
