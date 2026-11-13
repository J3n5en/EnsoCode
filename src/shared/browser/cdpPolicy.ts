const DENY_PREFIX = [
  'Input.',
  'Browser.',
  'Storage.',
  'SystemInfo.',
  'Target.',
  'Tethering.',
  'PWA.',
  'Cast.',
  'Inspector.',
];

const DENY_EXACT = new Set([
  'Network.setCookie',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
  'Page.navigate',
  'Page.reload',
  'Page.navigateToHistoryEntry',
  'Page.setDownloadBehavior',
  'DOM.setFileInputFiles',
]);

/**
 * Network 域里所有读写 cookie 的方法（getAllCookies / getCookies / setCookies 等）一律拒绝：
 * 浏览器分区被所有会话共用，放行任意一个都能导出或篡改全部站点的登录态（含 HttpOnly）。
 */
function isNetworkCookieMethod(name: string): boolean {
  return name.startsWith('Network.') && /cookie/i.test(name);
}

/** Cursor 同款：CDP 给调试，不给点击/Cookie/导航/标签管理。 */
export function assertAllowedCdpMethod(method: string): void {
  const name = method.trim();
  if (!name || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error(`Invalid CDP method: ${method}`);
  }
  if (
    DENY_EXACT.has(name) ||
    DENY_PREFIX.some((prefix) => name.startsWith(prefix)) ||
    isNetworkCookieMethod(name)
  ) {
    throw new Error(
      `CDP method ${name} is not allowed. Use dedicated browser tools for click/type/navigate; cookies, downloads, and tab control are denied.`
    );
  }
}
