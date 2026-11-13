import { describe, expect, it } from 'vitest';
import { assertAllowedCdpMethod } from './cdpPolicy';

describe('assertAllowedCdpMethod', () => {
  it('allows debug/read methods', () => {
    for (const method of [
      'Runtime.evaluate',
      'DOM.getDocument',
      'CSS.getComputedStyleForNode',
      'Profiler.start',
      'Performance.getMetrics',
      'Log.enable',
      'Network.enable',
      'Page.captureScreenshot',
    ]) {
      expect(() => assertAllowedCdpMethod(method)).not.toThrow();
    }
  });

  it('denies input, cookies, navigation, and target control', () => {
    for (const method of [
      'Input.dispatchMouseEvent',
      'Input.insertText',
      'Browser.getVersion',
      'Storage.clearDataForOrigin',
      'Network.setCookie',
      'Network.clearBrowserCookies',
      'Page.navigate',
      'DOM.setFileInputFiles',
      'Target.createTarget',
    ]) {
      expect(() => assertAllowedCdpMethod(method)).toThrow(/not allowed/i);
    }
  });

  // 所有会话共用同一个浏览器分区：任何 cookie 读写方法都能导出/篡改全部站点的登录态（含 HttpOnly）
  it('denies every Network cookie read/write method', () => {
    for (const method of [
      'Network.getAllCookies',
      'Network.getCookies',
      'Network.setCookies',
      'Network.setCookie',
      'Network.deleteCookies',
    ]) {
      expect(() => assertAllowedCdpMethod(method)).toThrow(/not allowed/i);
    }
  });
});
