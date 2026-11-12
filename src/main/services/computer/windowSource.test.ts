import { describe, expect, it } from 'vitest';
import {
  findCapturerWindowSource,
  findCaptureWindow,
  isListedCgWindowLayer,
  thumbnailCropForWindow,
} from './windowSource';

describe('isListedCgWindowLayer', () => {
  it('普通窗和 modal sheet 列出，菜单栏不列', () => {
    expect(isListedCgWindowLayer(0)).toBe(true);
    expect(isListedCgWindowLayer(3)).toBe(true);
    expect(isListedCgWindowLayer(8)).toBe(true);
    expect(isListedCgWindowLayer(25)).toBe(false);
  });
});

describe('findCapturerWindowSource', () => {
  it('CG 窗口号能对上 Electron source id', () => {
    const sources = [{ id: 'window:88:0' }, { id: 'window:17519:0' }];
    expect(findCapturerWindowSource(sources, '17519')?.id).toBe('window:17519:0');
    expect(findCapturerWindowSource(sources, '9')).toBeUndefined();
  });
});

describe('findCaptureWindow', () => {
  // 审计发现：按子串匹配时，排在前面的 "141" 会被当成 "31415" 的几何，后续点击映射到错误坐标
  it('窗口号只按完整值匹配，前面的窗口号是目标的子串时不误取', () => {
    const windows = [
      { id: '141', x: 0, y: 0 },
      { id: '31415', x: 500, y: 300 },
    ];
    expect(findCaptureWindow(windows, '31415')).toEqual({ id: '31415', x: 500, y: 300 });
  });
});

describe('thumbnailCropForWindow', () => {
  it('把窗口矩形映到桌面缩略图像素', () => {
    expect(
      thumbnailCropForWindow({
        window: { x: 100, y: 50, width: 200, height: 80 },
        display: { x: 0, y: 0, width: 1000, height: 500 },
        thumbnailWidth: 100,
        thumbnailHeight: 50,
      })
    ).toEqual({ x: 10, y: 5, width: 20, height: 8 });
  });
});
