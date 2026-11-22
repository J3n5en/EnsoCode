function execCommandCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 复制纯文本。必须在用户点击的同步调用链里调用：iOS Safari 只认手势内同步发起的
 * clipboard.writeText；非 https 或被拒时退回 execCommand('copy')。
 */
export function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.writeText || window.isSecureContext === false) {
    return Promise.resolve(execCommandCopy(text));
  }
  try {
    return Promise.resolve(clipboard.writeText(text)).then(
      () => true,
      () => execCommandCopy(text)
    );
  } catch {
    return Promise.resolve(execCommandCopy(text));
  }
}
