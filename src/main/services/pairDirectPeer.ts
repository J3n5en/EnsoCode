import type {
  DirectCandidate,
  DirectChannelKind,
  DirectPeer,
  DirectPeerFactory,
  IceServerEntry,
} from '@enso/pair';
import { app } from '@platform';

/**
 * Electron main 侧的 WebRTC 对端：node-datachannel（libdatachannel N-API 绑定）。
 * 懒加载：原生模块缺失/加载失败只记一次日志，工厂返回 null → host 不声明直连能力，退化为纯中继。
 */

type Ndc = typeof import('node-datachannel');
type NdcChannel = import('node-datachannel').DataChannel;

let ndc: Ndc | null | undefined;
let loading: Promise<void> | null = null;

export function preloadDirectPeer(): Promise<void> {
  if (ndc !== undefined) return Promise.resolve();
  loading ??= import('node-datachannel')
    .then((mod) => {
      ndc = mod;
      app.on('will-quit', () => {
        try {
          mod.cleanup();
        } catch {}
      });
    })
    .catch((error) => {
      ndc = null;
      console.warn('[pair] node-datachannel unavailable, direct link disabled', error);
    });
  return loading;
}

export function isDirectPeerAvailable(): boolean {
  return Boolean(ndc);
}

function toNdcIceServers(entries: IceServerEntry[]): string[] {
  return entries.flatMap((e) => e.urls);
}

export const mainDirectPeerFactory: DirectPeerFactory = (iceServers) => {
  if (!ndc) return null;
  return createPeer(ndc, iceServers);
};

function createPeer(mod: Ndc, iceServers: IceServerEntry[]): DirectPeer {
  const pc = new mod.PeerConnection('pair', {
    iceServers: toNdcIceServers(iceServers),
    iceTransportPolicy: 'all',
  });
  let dc: NdcChannel | null = null;
  let bulkDc: NdcChannel | null = null;
  let bulkOpened = false;
  let closed = false;
  let remoteSet = false;
  const queuedCandidates: DirectCandidate[] = [];
  const iceCbs: ((c: DirectCandidate) => void)[] = [];
  const openCbs: (() => void)[] = [];
  const messageCbs: ((b: Uint8Array, channel?: DirectChannelKind) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  let closeEmitted = false;

  const emitClose = (): void => {
    if (closed || closeEmitted) return;
    closeEmitted = true;
    for (const cb of closeCbs) cb();
  };

  const attach = (channel: NdcChannel, kind: DirectChannelKind): void => {
    if (kind === 'bulk') bulkDc = channel;
    else dc = channel;
    channel.onOpen(() => {
      if (closed) return;
      if (kind === 'bulk') {
        bulkOpened = true;
        return;
      }
      // 真机验收靠这一行分辨 LAN（host↔host）、STUN 打洞（srflx/prflx）与地址族（v6 无 NAT）
      try {
        const pair = pc.getSelectedCandidatePair();
        if (pair) {
          const fam = (a: string) => (a.includes(':') ? 'v6' : 'v4');
          console.log(
            `[pair] direct open via ${pair.local.type}/${fam(pair.local.address)}↔${pair.remote.type}/${fam(pair.remote.address)}`
          );
        }
      } catch {}
      for (const cb of openCbs) cb();
    });
    channel.onMessage((msg) => {
      if (closed) return;
      const bytes =
        typeof msg === 'string'
          ? new TextEncoder().encode(msg)
          : msg instanceof ArrayBuffer
            ? new Uint8Array(msg)
            : new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
      for (const cb of messageCbs) cb(bytes, kind);
    });
    if (kind === 'ctrl') {
      channel.onClosed(emitClose);
      channel.onError(emitClose);
    } else {
      channel.onClosed(() => {
        if (bulkDc === channel) {
          bulkDc = null;
          bulkOpened = false;
        }
      });
      channel.onError(() => {
        if (bulkDc === channel) {
          bulkDc = null;
          bulkOpened = false;
        }
      });
    }
  };

  pc.onLocalCandidate((candidate, mid) => {
    if (closed) return;
    for (const cb of iceCbs) cb({ candidate, sdpMid: mid });
  });
  pc.onStateChange((state) => {
    if (state === 'disconnected' || state === 'failed' || state === 'closed') emitClose();
  });
  pc.onDataChannel((channel) => {
    if (closed) return;
    const kind: DirectChannelKind = channel.getLabel() === 'pair-bulk' ? 'bulk' : 'ctrl';
    attach(channel, kind);
    if (kind === 'bulk' && channel.isOpen()) bulkOpened = true;
  });

  const flushCandidates = (): void => {
    remoteSet = true;
    for (const c of queuedCandidates.splice(0)) {
      try {
        pc.addRemoteCandidate(c.candidate, c.sdpMid ?? '0');
      } catch {}
    }
  };

  /** libdatachannel 自动协商：建通道 / 收 offer 后 onLocalDescription 吐本地 SDP */
  const waitLocalDescription = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pc.onLocalDescription(() => {});
        reject(new Error('local description timeout'));
      }, 5_000);
      pc.onLocalDescription((sdp) => {
        clearTimeout(timer);
        // 单槽回调：用过即解绑，免得日后重协商再触发时误把旧 resolve 捕住
        pc.onLocalDescription(() => {});
        resolve(sdp);
      });
    });

  return {
    async createOffer() {
      const pending = waitLocalDescription();
      attach(pc.createDataChannel('pair'), 'ctrl');
      attach(pc.createDataChannel('pair-bulk'), 'bulk');
      return pending;
    },
    async acceptOffer(sdp) {
      const pending = waitLocalDescription();
      pc.setRemoteDescription(sdp, 'offer');
      flushCandidates();
      return pending;
    },
    async acceptAnswer(sdp) {
      pc.setRemoteDescription(sdp, 'answer');
      flushCandidates();
    },
    async addIceCandidate(c) {
      // 候选可能先于 answer 到达：远端描述未设前先排队
      if (!remoteSet) {
        queuedCandidates.push(c);
        return;
      }
      pc.addRemoteCandidate(c.candidate, c.sdpMid ?? '0');
    },
    onIceCandidate(cb) {
      iceCbs.push(cb);
      return () => void iceCbs.splice(iceCbs.indexOf(cb), 1);
    },
    onOpen(cb) {
      openCbs.push(cb);
      return () => void openCbs.splice(openCbs.indexOf(cb), 1);
    },
    onMessage(cb) {
      messageCbs.push(cb);
      return () => void messageCbs.splice(messageCbs.indexOf(cb), 1);
    },
    onClose(cb) {
      closeCbs.push(cb);
      return () => void closeCbs.splice(closeCbs.indexOf(cb), 1);
    },
    send(bytes) {
      if (closed || !dc?.isOpen()) return false;
      // 背压：缓冲超过 1MB 就拒，调用方改走中继
      if (dc.bufferedAmount() > 1_048_576) return false;
      try {
        // libdatachannel 的 sendMessageBinary 返回 false 仅表示数据进了发送缓冲（仍会发出），
        // 真正失败（未开/已关/超限）会抛异常；忽略返回值以免触发 DirectLink 误拆直连
        dc.sendMessageBinary(bytes);
        return true;
      } catch {
        return false;
      }
    },
    sendBulk(bytes) {
      if (closed || !bulkOpened || !bulkDc?.isOpen()) return false;
      if (bulkDc.bufferedAmount() > 1_048_576) return false;
      try {
        bulkDc.sendMessageBinary(bytes);
        return true;
      } catch {
        return false;
      }
    },
    buffered: () => (dc && !closed && dc.isOpen() ? dc.bufferedAmount() : 0),
    bufferedBulk: () => (bulkDc && !closed && bulkDc.isOpen() ? bulkDc.bufferedAmount() : 0),
    isBulkOpen: () => !closed && bulkOpened && Boolean(bulkDc?.isOpen()),
    close() {
      if (closed) return;
      closed = true;
      bulkOpened = false;
      try {
        bulkDc?.close();
      } catch {}
      try {
        dc?.close();
      } catch {}
      try {
        pc.close();
      } catch {}
    },
  };
}
