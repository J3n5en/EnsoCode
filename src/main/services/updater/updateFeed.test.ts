import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ensureFallbackUpdateConfig, UPDATE_FEED } from './updateFeed';

const ROOT = path.resolve(__dirname, '../../../..');
const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'enso-update-feed-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('缺 app-update.yml 时退回内置 feed', () => {
  it('内置 feed 与 electron-builder.yml 的 publish 一致', () => {
    const builder = parse(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
    expect(UPDATE_FEED).toEqual(builder.publish);
  });

  it('正式包带 app-update.yml：返回 null，不写任何文件', () => {
    const resources = tempDir();
    const fallback = path.join(tempDir(), 'updater');
    writeFileSync(path.join(resources, 'app-update.yml'), 'provider: github\n');
    expect(ensureFallbackUpdateConfig(resources, fallback)).toBeNull();
    expect(() => readFileSync(path.join(fallback, 'app-update.yml'))).toThrow();
  });

  it('--dir 构建缺 app-update.yml：写出与正式包同内容的配置并返回路径', () => {
    const resources = tempDir();
    const fallback = path.join(tempDir(), 'nested', 'updater');
    const file = ensureFallbackUpdateConfig(resources, fallback);
    expect(file).toBe(path.join(fallback, 'app-update.yml'));
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    // 正式包里 electron-builder 生成的 app-update.yml 就是 publish + updaterCacheDirName
    expect(parse(readFileSync(file as string, 'utf8'))).toEqual({
      ...UPDATE_FEED,
      updaterCacheDirName: `${pkg.name.toLowerCase()}-updater`,
    });
  });

  it('再次启动覆盖旧的回退配置', () => {
    const resources = tempDir();
    const fallback = tempDir();
    writeFileSync(path.join(fallback, 'app-update.yml'), 'provider: generic\nurl: http://x\n');
    const file = ensureFallbackUpdateConfig(resources, fallback) as string;
    expect(parse(readFileSync(file, 'utf8')).provider).toBe('github');
  });
});
