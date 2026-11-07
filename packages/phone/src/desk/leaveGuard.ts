export type LeaveGuardWindow = Pick<
  Window,
  'location' | 'history' | 'confirm' | 'addEventListener'
>;

/**
 * 关闭/刷新与后退前二次确认：压一条守卫历史，后退落在它上面时询问。
 * onBack 返回 true 表示这次后退已被页内处理（如关闭设置层），不离开。
 */
export function installLeaveGuard(
  win: LeaveGuardWindow,
  message: string,
  onBack?: () => boolean
): { release(): void } {
  let released = false;
  const arm = () => win.history.pushState({ ensoLeaveGuard: true }, '', win.location.href);
  arm();
  win.addEventListener('beforeunload', (event) => {
    if (released) return;
    event.preventDefault();
    event.returnValue = '';
  });
  win.addEventListener('popstate', () => {
    if (released) return;
    if (onBack?.() || !win.confirm(message)) {
      arm();
      return;
    }
    released = true;
    win.history.back();
  });
  return {
    release() {
      released = true;
    },
  };
}
