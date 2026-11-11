import type { RemoteBridge, RemoteBridgeFrame } from '@shared/remoteBridge';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { contextBridge, ipcRenderer } from 'electron';

/**
 * 节点设置窗口壳页的 preload：只暴露 `__ensoRemote`（宿主设置页 web-preload 经 parent 调用），
 * 所有调用由 main 按本窗口 sender 限定到该节点的 rpc 隧道。
 */

const listeners = new Map<string, Map<string, Set<(payload: string) => void>>>();
ipcRenderer.on(
  IPC_CHANNELS.NODE_REMOTE_EVENT,
  (_event, cid: string, channel: string, payload: string) => {
    for (const fn of [...(listeners.get(cid)?.get(channel) ?? [])]) fn(payload);
  }
);

function attach(): RemoteBridgeFrame {
  // attach 须同步返回：cid 异步拿到前的调用排在 promise 后
  const cidPromise = ipcRenderer.invoke(IPC_CHANNELS.NODE_REMOTE_ATTACH, 'settings') as Promise<
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

const zh = navigator.language.toLowerCase().startsWith('zh');
const TEXT = {
  connecting: zh ? '正在连接节点…' : 'Connecting to node…',
  loading: zh
    ? '正在从节点加载设置，首次打开可能需要一些时间…'
    : 'Loading settings from node. The first time may take a while…',
  offline: zh ? '节点离线' : 'Node is offline',
  outdated: zh ? '节点版本过旧，不支持远程设置' : 'Node does not support remote settings',
};

function showStatus(text: string, error = false): void {
  const el = document.getElementById('s');
  el?.classList.toggle('err', error);
  const label = el?.querySelector('span');
  if (label) label.textContent = text;
}

window.addEventListener('DOMContentLoaded', async () => {
  showStatus(TEXT.connecting);
  const init = (await ipcRenderer.invoke(IPC_CHANNELS.NODE_REMOTE_INIT)) as
    | { ok: true; platform: string }
    | { ok: false; error: string };
  if (!init.ok) {
    showStatus(init.error === 'offline' ? TEXT.offline : TEXT.outdated, true);
    return;
  }
  const bridge: RemoteBridge = {
    platform: init.platform,
    attach,
    leader: () => false,
    openSettings: () => {},
    closeSettings: () => ipcRenderer.send(IPC_CHANNELS.NODE_REMOTE_CLOSE),
    consumeSettingsLink: () => null,
    exitDesk: () => {},
    // 不提供 linkStatus / onLinkStatus / vapidPublicKey / setPushSubscription / setPushPending：
    // 节点设置窗口没有「手机→桌面」链路与浏览器推送，宿主设置页按缺省隐藏这组入口。
  };
  contextBridge.exposeInMainWorld('__ensoRemote', bridge);
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
});
