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

/** Cursor 同款：CDP 给调试，不给点击/Cookie/导航/标签管理。 */
export function assertAllowedCdpMethod(method: string): void {
  const name = method.trim();
  if (!name || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error(`Invalid CDP method: ${method}`);
  }
  if (DENY_EXACT.has(name) || DENY_PREFIX.some((prefix) => name.startsWith(prefix))) {
    throw new Error(
      `CDP method ${name} is not allowed. Use dedicated browser tools for click/type/navigate; cookies, downloads, and tab control are denied.`
    );
  }
}
