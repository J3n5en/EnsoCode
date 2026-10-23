import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertBuildArtifactsAbsent,
  createBuildEnvironment,
  parseBuildOptions,
} from './build-win-local.mjs';

const root = path.resolve('example-repository');
const now = new Date('2026-07-23T12:34:56.789Z');
const extensions = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

test('拒绝覆盖已存在的安装包或应用目录，允许仅含日志的新目录', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'enso-build-output-'));
  try {
    writeFileSync(path.join(output, 'build.log'), '');
    assert.doesNotThrow(() => assertBuildArtifactsAbsent(output, '0.2.8'));
    const installer = path.join(output, 'EnsoCode-Setup-0.2.8.exe');
    writeFileSync(installer, 'existing installer');
    assert.throws(() => assertBuildArtifactsAbsent(output, '0.2.8'));
    rmSync(installer);
    mkdirSync(path.join(output, 'win-unpacked'));
    assert.throws(() => assertBuildArtifactsAbsent(output, '0.2.8'));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('默认产物位于独立且包含时间的 dist 子目录', () => {
  const { output } = parseBuildOptions([], root, now);
  assert.equal(output, path.join(root, 'dist', 'win-local-2026-07-23T12-34-56-789Z'));
  assert.notEqual(output, parseBuildOptions([], root, new Date(now.getTime() + 1)).output);
});

test('接受仓库内 dist 子目录的相对路径和绝对路径', () => {
  const output = path.join(root, 'dist', 'local build');
  assert.equal(parseBuildOptions(['--output', 'dist/local build'], root, now).output, output);
  assert.equal(parseBuildOptions(['--output', output], root, now).output, output);
});

test('拒绝不完整、重复和未知参数', () => {
  for (const args of [
    ['--output'],
    ['--output', ''],
    ['--output', '--publish'],
    ['--publish', 'always'],
    ['--output', 'dist/a', '--output', 'dist/b'],
    ['dist/local'],
  ]) {
    assert.throws(() => parseBuildOptions(args, root, now), undefined, JSON.stringify(args));
  }
});

test('拒绝 dist 根目录、路径穿越及 Windows 特殊路径片段', () => {
  for (const output of [
    'dist',
    '.',
    '../outside',
    'dist/../../outside',
    'dist-other/local',
    'dist/../out/local',
    'dist/.. /outside',
    'dist/local:stream',
    'dist/local.',
    'dist/NUL',
    'dist/CON.txt',
    path.resolve(root, '../outside'),
  ]) {
    assert.throws(() => parseBuildOptions(['--output', output], root, now), undefined, output);
  }
});

test('缺少 PATHEXT 时仅在克隆的环境中补齐并前插 Node 与 pnpm shim', () => {
  const source = Object.freeze({ Path: 'C:\\system', KEEP: 'retained' });
  const env = createBuildEnvironment(source, 'C:\\node', 'C:\\shim');
  assert.equal(env.PATHEXT, extensions);
  assert.equal(env.Path, 'C:\\shim;C:\\node;C:\\system');
  assert.equal(env.KEEP, 'retained');
  assert.equal(source.Path, 'C:\\system');
  assert.equal(source.PATHEXT, undefined);
});

test('保留已有正常 PATHEXT，兼容环境键名大小写', () => {
  for (const key of ['PATH', 'Path', 'path']) {
    const env = createBuildEnvironment({ [key]: 'original', PathExt: '.EXE;.CMD' }, 'node');
    assert.equal(env[key], 'node;original');
    assert.equal(env.PathExt, '.EXE;.CMD');
    assert.equal(Object.keys(env).filter((name) => name.toLowerCase() === 'pathext').length, 1);
  }
});

test('缺少 PATH 或 PATHEXT 为空时可恢复命令发现', () => {
  assert.equal(createBuildEnvironment({}, 'node').PATH, 'node');
  for (const value of ['', '  ', undefined]) {
    const env = createBuildEnvironment({ pathext: value }, 'node');
    assert.equal(env.pathext, extensions);
  }
});

test('重复大小写 PATH 键合并为一个可传给 Windows 子进程的键', () => {
  const env = createBuildEnvironment({ PATH: 'first', Path: 'second' }, 'node', 'shim');
  assert.equal(Object.keys(env).filter((key) => key.toLowerCase() === 'path').length, 1);
  assert.equal(env.PATH, 'shim;node;first');
});
