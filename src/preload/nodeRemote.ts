import { type NodeShellPage, nodeMainRendererPath, nodeShellRoute } from '@shared/nodeSettings';
import type { RemoteBridge, RemoteBridgeFrame, RemoteFrameKind } from '@shared/remoteBridge';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { contextBridge, ipcRenderer } from 'electron';

/**
 * 远程节点界面的 preload（主窗口节点层与节点设置窗口共用）：只暴露 `__ensoRemote`，
 * 宿主 renderer 的 web-preload 经它调用；所有调用由 main 按本页 sender 限定到该节点的 rpc 隧道。
 */

const listeners = new Map<string, Map<string, Set<(payload: string) => void>>>();
ipcRenderer.on(
  IPC_CHANNELS.NODE_REMOTE_EVENT,
  (_event, cid: string, channel: string, payload: string) => {
    for (const fn of [...(listeners.get(cid)?.get(channel) ?? [])]) fn(payload);
  }
);

function attach(kind: RemoteFrameKind): RemoteBridgeFrame {
  // attach 须同步返回：cid 异步拿到前的调用排在 promise 后
  const cidPromise = ipcRenderer.invoke(IPC_CHANNELS.NODE_REMOTE_ATTACH, kind) as Promise<
    string | null
  >;
  const local = new Map<string, Set<(payload: string) => void>>();
  void cidPromise.then((cid) => {
    if (cid) listeners.set(cid, local);
  });
  const withCid = async () => {
    const cid = await cidPromise;
    if (!cid) throw new Error('remote-frame-closed');
    return cid;
  };
  return {
    invoke: async (channel, payload) =>
      ipcRenderer.invoke(IPC_CHANNELS.NODE_REMOTE_INVOKE, await withCid(), channel, payload),
    send: (channel, payload) => {
      void withCid().then(
        (cid) => ipcRenderer.send(IPC_CHANNELS.NODE_REMOTE_SEND, cid, channel, payload),
        () => {}
      );
    },
    on: (channel, listener) => {
      let set = local.get(channel);
      if (!set) {
        set = new Set();
        local.set(channel, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    close: () => {
      void cidPromise.then((cid) => {
        if (!cid) return;
        listeners.delete(cid);
        ipcRenderer.send(IPC_CHANNELS.NODE_REMOTE_DETACH, cid);
      });
    },
  };
}

function remoteBridge(platform: string, settingsLink: unknown = null): RemoteBridge {
  let link = settingsLink;
  return {
    platform,
    attach,
    leader: () => false,
    openSettings: () => {},
    closeSettings: () => ipcRenderer.send(IPC_CHANNELS.NODE_REMOTE_CLOSE),
    consumeSettingsLink: () => {
      const value = link;
      link = null;
      return value;
    },
    // 不提供 exitDesk / linkStatus / vapidPublicKey / setPush* 等手机壳专属方法：
    // 节点界面没有手机版、「手机→桌面」链路与浏览器推送，宿主界面按缺省隐藏这组入口。
  };
}

/** 主界面里交给本机 main 的调用（本机窗口、节点切换、系统通知），由 main 按白名单裁决 */
function nativeLocal(): RemoteBridge['local'] {
  const localListeners = new Map<string, Set<(payload: string) => void>>();
  ipcRenderer.on(
    IPC_CHANNELS.NODE_REMOTE_LOCAL_EVENT,
    (_event, channel: string, payload: string) => {
      for (const fn of [...(localListeners.get(channel) ?? [])]) fn(payload);
    }
  );
  return {
    invoke: (channel, payload) =>
      ipcRenderer.invoke(IPC_CHANNELS.NODE_REMOTE_LOCAL_INVOKE, channel, payload),
    send: (channel, payload) =>
      ipcRenderer.send(IPC_CHANNELS.NODE_REMOTE_LOCAL_SEND, channel, payload),
    on: (channel, listener) => {
      let set = localListeners.get(channel);
      if (!set) {
        set = new Set();
        localListeners.set(channel, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
  };
}

const zh = navigator.language.toLowerCase().startsWith('zh');
const TEXT = {
  connecting: zh ? '正在连接节点…' : 'Connecting to node…',
  loading: zh
    ? '正在从节点加载设置，首次打开可能需要一些时间…'
    : 'Loading settings from node. The first time may take a while…',
  offline: zh ? '节点离线' : 'Node is offline',
  outdated: zh ? '节点版本过旧，不支持远程界面' : 'Node is too old for the remote interface',
  back: zh ? '返回本机' : 'Back to this computer',
};

function showStatus(text: string, error = false): void {
  const el = document.getElementById('s');
  el?.classList.toggle('err', error);
  const label = el?.querySelector('span');
  if (label) label.textContent = text;
}

async function runShell(page: NodeShellPage): Promise<void> {
  if (page === 'main') document.documentElement.classList.add('drag');
  showStatus(TEXT.connecting);
  const init = (await ipcRenderer.invoke(IPC_CHANNELS.NODE_REMOTE_INIT)) as
    | { ok: true; platform: string; link?: unknown }
    | { ok: false; error: string };
  if (!init.ok) {
    showStatus(init.error === 'offline' ? TEXT.offline : TEXT.outdated, true);
    const back = document.getElementById('b');
    if (page === 'main' && back) {
      back.textContent = TEXT.back;
      back.hidden = false;
      back.onclick = () => ipcRenderer.send(IPC_CHANNELS.NODE_REMOTE_CLOSE);
    }
    return;
  }
  if (page === 'main') {
    // 整页拖拽区在换文档后仍留在窗口上，新页若没声明区域（没跑起来）就整窗只能拖不能点；先撤掉并等它生效
    document.documentElement.classList.remove('drag');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    location.replace(nodeMainRendererPath(init.platform));
    return;
  }
  contextBridge.exposeInMainWorld('__ensoRemote', remoteBridge(init.platform, init.link ?? null));
  showStatus(TEXT.loading);
  const frame = document.createElement('iframe');
  // 资源下完、页面跑起来后再露出，期间保留 loading
  frame.addEventListener(
    'load',
    () => {
      frame.classList.add('on');
      setTimeout(() => document.getElementById('s')?.remove(), 200);
    },
    { once: true }
  );
  frame.src = 'r/settings.html';
  document.body.append(frame);
}

const route = nodeShellRoute(location.href);
if (route?.kind === 'main') {
  // 主界面是顶层文档：web-preload 同步读 __ensoRemote，必须在页面脚本之前挂上
  contextBridge.exposeInMainWorld('__ensoRemote', {
    ...remoteBridge(route.platform),
    local: nativeLocal(),
    localPlatform: process.platform,
  });
} else if (route?.kind === 'shell') {
  const { page } = route;
  window.addEventListener('DOMContentLoaded', () => void runShell(page));
}
