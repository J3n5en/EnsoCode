import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledRtkPath } from './rtkBinary';

describe('内置 RTK 路径', () => {
  const base = {
    packaged: false,
    appPath: '/app',
    resourcesPath: '/installed/resources',
    platform: 'darwin',
    arch: 'arm64',
  };
  it('开发态从应用根目录找当前平台架构，不依赖项目 cwd 或 PATH', () => {
    expect(bundledRtkPath(base)).toBe(path.join('/app', 'resources/rtk/darwin-arm64/rtk'));
  });
  it('安装态使用 resourcesPath 的已打包目标', () => {
    expect(bundledRtkPath({ ...base, packaged: true })).toBe(
      path.join('/installed/resources', 'rtk/rtk')
    );
  });
  it('Windows 使用 exe，保留含空格路径', () => {
    expect(
      bundledRtkPath({
        ...base,
        packaged: true,
        platform: 'win32',
        resourcesPath: '/Program Files/Enso/resources',
      })
    ).toBe(path.join('/Program Files/Enso/resources', 'rtk/rtk.exe'));
  });
});
