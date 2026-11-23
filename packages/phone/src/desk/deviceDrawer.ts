import { linkTone } from '@shared/pair/linkLabel';
import type { RemoteLinkStatus } from '@shared/remoteBridge';
import { CONN_STATE_LABEL, formatOnlineConnectionLabel } from '../connectionLabel';
import type { StoredDevice } from '../deviceList';
import { pushHints } from '../pushToggle';
import type { DeskDevices } from './devices';
import type { DeskTheme } from './drawerTheme';

/**
 * 完整版「电脑与通知」底部抽屉：画在壳页面里（纯 DOM，不进 React），
 * 推送订阅与配对凭据都只在手机本地，renderer 只能打开它。
 */

export interface DeviceDrawerHost {
  doc: Document;
  currentId: string;
  devices: DeskDevices;
  link(): RemoteLinkStatus;
  onLink(listener: () => void): () => void;
  togglePush(): void;
  theme(): DeskTheme | null;
  watchTheme(listener: () => void): () => void;
  /** 复制给开发者排查卡顿的诊断文本 */
  diagnostics(): string;
}

const ICONS = {
  laptop:
    '<path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z"/><path d="M20.054 15.987H3.946"/>',
  pencil:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  unplug:
    '<path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clipboard:
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
} as const;

const STYLE = `
.dd-root{--dd-bg:#fff;--dd-fg:#18181b;--dd-muted:#f4f4f5;--dd-muted-fg:#71717a;--dd-border:#e4e4e7;--dd-primary:#18181b;--dd-primary-fg:#fafafa;--dd-destructive:#dc2626;--dd-success:#16a34a;--dd-warning:#d97706;--dd-ring:#a1a1aa;--dd-radius:.5rem;
position:fixed;inset:0;z-index:30;display:flex;flex-direction:column;justify-content:flex-end;
padding:0 env(safe-area-inset-right) 0 env(safe-area-inset-left);color:var(--dd-fg);color-scheme:light;
font:14px/1.5 var(--dd-font,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);-webkit-text-size-adjust:100%}
.dd-root.dd-dark{--dd-bg:#27272a;--dd-fg:#fafafa;--dd-muted:#3f3f46;--dd-muted-fg:#a1a1aa;--dd-border:#3f3f46;--dd-primary:#fafafa;--dd-primary-fg:#18181b;--dd-destructive:#f87171;--dd-success:#4ade80;--dd-warning:#fbbf24;color-scheme:dark}
html.kb-open .dd-root{bottom:auto;top:var(--kb-top,0px);height:var(--kb-height,100%)}
.dd-scrim{position:absolute;inset:0;background:rgba(0,0,0,.4);opacity:0;transition:opacity .2s ease-out}
.dd-sheet{position:relative;box-sizing:border-box;width:min(100%,480px);margin:0 auto;
max-height:calc(100% - env(safe-area-inset-top) - 12px);overflow-y:auto;overscroll-behavior:contain;
background:var(--dd-bg);border:1px solid var(--dd-border);border-bottom:0;border-radius:16px 16px 0 0;
padding:6px 12px calc(12px + env(safe-area-inset-bottom));box-shadow:0 -8px 32px rgba(0,0,0,.18);
transform:translateY(100%);transition:transform .26s cubic-bezier(.32,.72,0,1)}
html.kb-open .dd-sheet{padding-bottom:12px}
.dd-open .dd-scrim{opacity:1}.dd-open .dd-sheet{transform:none}
@media (prefers-reduced-motion:reduce){.dd-scrim,.dd-sheet{transition:none}}
.dd-grab{width:36px;height:4px;border-radius:2px;background:var(--dd-border);margin:0 auto 6px}
.dd-head{display:flex;align-items:center;padding:2px 4px 6px 8px}
.dd-title{flex:1;font-weight:600;font-size:16px}
:where(.dd-root) button{font:inherit;color:inherit;background:none;border:0;margin:0;padding:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.dd-root button:disabled{cursor:default;opacity:.5}
.dd-root button:focus-visible,.dd-root input:focus-visible{outline:2px solid var(--dd-ring);outline-offset:1px}
.dd-icon{width:36px;height:36px;display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:var(--dd-radius);color:var(--dd-muted-fg)}
.dd-icon:active{background:var(--dd-muted)}
.dd-line{display:flex;align-items:center;gap:8px;padding:9px 8px;border-radius:var(--dd-radius);width:100%;box-sizing:border-box;text-align:left}
.dd-line svg,.dd-icon svg{flex-shrink:0}
.dd-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dd-dim{color:var(--dd-muted-fg)}
.dd-hint{margin:0;padding:0 8px 2px 32px;font-size:11px;color:var(--dd-muted-fg)}
.dd-hint.dd-err{color:var(--dd-destructive)}
.dd-label{padding:12px 8px 4px;font-size:12px;font-weight:600;color:var(--dd-muted-fg)}
.dd-row{display:flex;align-items:center;gap:2px}
.dd-row>.dd-line{flex:1;min-width:0}
.dd-current{background:var(--dd-muted)}
.dd-status{flex-shrink:0;font-size:11px;color:var(--dd-muted-fg);white-space:nowrap}
.dd-dot{width:6px;height:6px;border-radius:999px;flex-shrink:0;background:var(--dd-success)}
.dd-dot.dd-pending{background:var(--dd-warning)}.dd-dot.dd-error{background:var(--dd-destructive)}
.dd-switch{position:relative;width:36px;height:20px;flex-shrink:0;border-radius:999px;background:color-mix(in oklab,var(--dd-fg) 22%,transparent);transition:background .15s}
.dd-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.dd-switch[aria-checked=true]{background:var(--dd-primary)}
.dd-switch[aria-checked=true]::after{transform:translateX(16px);background:var(--dd-primary-fg)}
.dd-box{margin:2px 0;padding:10px;border:1px dashed var(--dd-border);border-radius:var(--dd-radius)}
.dd-box p{margin:0 0 8px;font-size:12px}
.dd-input{flex:1;min-width:0;height:36px;box-sizing:border-box;padding:0 10px;font:inherit;font-size:16px;color:inherit;background:var(--dd-bg);border:1px solid var(--dd-border);border-radius:var(--dd-radius);outline:none}
.dd-input:focus{border-color:var(--dd-ring)}
.dd-actions{display:flex;justify-content:flex-end;gap:8px}
.dd-btn{height:32px;padding:0 12px;border-radius:var(--dd-radius);font-size:13px;border:1px solid var(--dd-border)}
.dd-btn.dd-danger{background:var(--dd-destructive);color:#fff;border-color:transparent}
.dd-sep{border-top:1px solid var(--dd-border);margin:8px 0 4px}
`;

type Child = Node | string | null | false | undefined;

export function createDeviceDrawer(host: DeviceDrawerHost) {
  const { doc } = host;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {},
    ...children: Child[]
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    for (const child of children) if (child) node.append(child);
    return node;
  };
  const icon = (name: keyof typeof ICONS, size = 16) => {
    const span = el('span', { 'aria-hidden': 'true', style: 'display:flex' });
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
  };
  const button = (
    attrs: Record<string, string>,
    onClick: () => void,
    ...children: Child[]
  ): HTMLButtonElement => {
    const node = el('button', { type: 'button', ...attrs }, ...children);
    node.addEventListener('click', onClick);
    return node;
  };

  let root: HTMLDivElement | null = null;
  let pushBox: HTMLDivElement | null = null;
  let list: HTMLDivElement | null = null;
  let currentStatus: HTMLSpanElement | null = null;
  let currentDot: HTMLSpanElement | null = null;
  let editing: string | null = null;
  let confirming: string | null = null;
  let unpairing: string | null = null;
  let cleanups: (() => void)[] = [];

  const statusText = (link: RemoteLinkStatus) =>
    link.state === 'online'
      ? formatOnlineConnectionLabel(link.transport, link.rttMs)
      : CONN_STATE_LABEL[link.state];

  const applyTheme = () => {
    if (!root) return;
    const theme = host.theme();
    root.classList.toggle(
      'dd-dark',
      theme ? theme.dark : matchMedia('(prefers-color-scheme: dark)').matches
    );
    for (const name of [...root.style])
      if (name.startsWith('--dd-')) root.style.removeProperty(name);
    for (const [name, value] of Object.entries(theme?.vars ?? {}))
      root.style.setProperty(name, value);
  };

  const renderPush = () => {
    if (!pushBox) return;
    const link = host.link();
    const online = link.state === 'online';
    const disabled =
      link.pushBusy ||
      link.pushAvailability !== 'ok' ||
      !link.pushReady ||
      (!online && !link.pushEnabled);
    const toggle = button(
      {
        class: 'dd-switch',
        role: 'switch',
        'aria-checked': String(link.pushEnabled),
        'aria-label': '推送通知',
      },
      () => host.togglePush()
    );
    toggle.disabled = disabled;
    const hints = pushHints({
      busy: link.pushBusy,
      error: link.pushError,
      availability: link.pushAvailability,
      connected: online,
      configReady: link.pushReady,
    });
    if (hints.length === 0)
      hints.push({ text: '有需要你处理的事时推送到这台手机。', error: false });
    pushBox.replaceChildren(
      el(
        'div',
        { class: 'dd-line' },
        el('span', { class: 'dd-dim', style: 'display:flex' }, icon('bell')),
        el('span', { class: 'dd-grow' }, '推送通知'),
        toggle
      ),
      ...hints.map((hint) =>
        el('p', { class: hint.error ? 'dd-hint dd-err' : 'dd-hint' }, hint.text)
      )
    );
  };

  const renderStatus = () => {
    const link = host.link();
    if (currentStatus) currentStatus.textContent = statusText(link);
    if (currentDot) currentDot.className = `dd-dot dd-${linkTone(link.state)}`;
  };

  const renameRow = (d: StoredDevice) => {
    const input = el('input', {
      class: 'dd-input',
      value: d.label,
      maxlength: '40',
      enterkeyhint: 'done',
      'aria-label': `给「${d.label}」改名`,
    });
    const save = () => {
      host.devices.rename(d.pairId, input.value);
      editing = null;
      renderList();
    };
    const cancel = () => {
      editing = null;
      renderList();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        save();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        cancel();
      }
    });
    const row = el(
      'div',
      { class: 'dd-row', style: 'padding:4px 0 4px 8px;gap:4px' },
      input,
      button({ class: 'dd-icon', 'aria-label': '取消' }, cancel, icon('x')),
      button(
        { class: 'dd-icon', 'aria-label': '保存', style: 'color:var(--dd-fg)' },
        save,
        icon('check')
      )
    );
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return row;
  };

  const confirmRow = (d: StoredDevice) => {
    const busy = unpairing === d.pairId;
    const cancel = button(
      { class: 'dd-btn' },
      () => {
        confirming = null;
        renderList();
      },
      '取消'
    );
    const ok = button(
      { class: 'dd-btn dd-danger' },
      () => {
        unpairing = d.pairId;
        renderList();
        void host.devices.unpair(d.pairId).then(() => {
          if (d.pairId !== host.currentId) {
            unpairing = null;
            confirming = null;
            renderList();
          }
        });
      },
      busy ? '正在解绑…' : '确定解绑'
    );
    cancel.disabled = busy;
    ok.disabled = busy;
    return el(
      'div',
      { class: 'dd-box' },
      el('p', {}, `解绑「${d.label}」后需重新扫码才能连接，确定吗？`),
      el('div', { class: 'dd-actions' }, cancel, ok)
    );
  };

  const deviceRow = (d: StoredDevice) => {
    if (editing === d.pairId) return renameRow(d);
    if (confirming === d.pairId) return confirmRow(d);
    const current = d.pairId === host.currentId;
    const status = el('span', { class: 'dd-status' });
    if (current) {
      currentStatus = status;
      currentDot = el('span', { class: 'dd-dot' });
    } else if (d.scope === 'read') status.textContent = '只读 · 精简版';
    const main = button(
      {
        class: current ? 'dd-line dd-current' : 'dd-line dd-dim',
        ...(current ? { 'aria-current': 'true' } : {}),
      },
      () => {
        if (current) return;
        host.devices.switchTo(d.pairId);
      },
      icon('laptop'),
      el('span', { class: 'dd-grow', style: current ? 'color:var(--dd-fg)' : '' }, d.label),
      current && currentDot,
      status
    );
    return el(
      'div',
      { class: 'dd-row' },
      main,
      button(
        { class: 'dd-icon', 'aria-label': `重命名 ${d.label}` },
        () => {
          editing = d.pairId;
          confirming = null;
          renderList();
        },
        icon('pencil', 15)
      ),
      button(
        { class: 'dd-icon', 'aria-label': `解绑 ${d.label}` },
        () => {
          confirming = d.pairId;
          editing = null;
          renderList();
        },
        icon('unplug', 15)
      )
    );
  };

  function renderList(): void {
    if (!list) return;
    currentStatus = null;
    currentDot = null;
    list.replaceChildren(...host.devices.list().map(deviceRow));
    renderStatus();
  }

  const close = () => {
    const node = root;
    if (!node) return;
    root = pushBox = list = null;
    editing = confirming = null;
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    // 输入框随抽屉移除时不一定有 focusout：先失焦，让键盘避让复原
    (doc.activeElement as HTMLElement | null)?.blur?.();
    node.classList.remove('dd-open');
    setTimeout(() => node.remove(), 260);
  };

  /** clipboard API 不可用（非安全上下文、权限）时退回选中文本框复制 */
  const copyText = async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = el('textarea', { readonly: '', style: 'position:fixed;opacity:0' });
      area.value = text;
      doc.body.append(area);
      area.select();
      const ok = doc.execCommand('copy');
      area.remove();
      return ok;
    }
  };

  const diagnosticsButton = () => {
    const label = el('span', { class: 'dd-grow' }, '复制诊断信息');
    return button(
      { class: 'dd-line dd-dim' },
      () =>
        void copyText(host.diagnostics()).then((ok) => {
          label.textContent = ok ? '已复制，发给开发者即可' : '复制失败';
          setTimeout(() => {
            label.textContent = '复制诊断信息';
          }, 2000);
        }),
      icon('clipboard'),
      label
    );
  };

  const open = () => {
    if (root) return;
    if (!doc.getElementById('dd-style')) doc.head.append(el('style', { id: 'dd-style' }, STYLE));
    pushBox = el('div');
    list = el('div');
    const sheet = el(
      'div',
      { class: 'dd-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': '电脑与通知' },
      el('div', { class: 'dd-grab' }),
      el(
        'div',
        { class: 'dd-head' },
        el('span', { class: 'dd-title' }, '电脑与通知'),
        button({ class: 'dd-icon', 'aria-label': '关闭' }, close, icon('x', 20))
      ),
      pushBox,
      el('div', { class: 'dd-label' }, '已配对的电脑'),
      list,
      button(
        { class: 'dd-line dd-dim' },
        () => host.devices.pairNew(),
        icon('plus'),
        el('span', { class: 'dd-grow' }, '配对新电脑')
      ),
      el('div', { class: 'dd-sep' }),
      button(
        { class: 'dd-line dd-dim' },
        () => host.devices.exitDesk(),
        icon('phone'),
        el('span', { class: 'dd-grow' }, '切换到精简版')
      ),
      diagnosticsButton()
    );
    const scrim = el('div', { class: 'dd-scrim' });
    scrim.addEventListener('click', close);
    root = el('div', { class: 'dd-root' }, scrim, sheet);
    applyTheme();
    renderPush();
    renderList();
    doc.body.append(root);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    doc.addEventListener('keydown', onKey);
    cleanups = [
      () => doc.removeEventListener('keydown', onKey),
      host.onLink(() => {
        renderPush();
        renderStatus();
      }),
      host.watchTheme(applyTheme),
    ];
    // 先以收起态排版一帧，再加 dd-open 才有滑入
    void root.offsetHeight;
    root.classList.add('dd-open');
  };

  return { open, close, isOpen: () => root !== null };
}
