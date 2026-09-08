import type { DirectCandidate, IceServerEntry } from '../protocol';
import type { DirectPeer, DirectPeerFactory } from './peer';

/** 浏览器 / Electron renderer 侧的 DirectPeer：包一层 RTCPeerConnection，只做 DataChannel */

export function createBrowserDirectPeerFactory(): DirectPeerFactory | null {
  if (typeof RTCPeerConnection === 'undefined') return null;
  return (iceServers) => createBrowserPeer(iceServers);
}

function createBrowserPeer(iceServers: IceServerEntry[]): DirectPeer {
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });
  let dc: RTCDataChannel | null = null;
  let closed = false;
  let closeEmitted = false;
  let remoteSet = false;
  const queuedCandidates: DirectCandidate[] = [];
  const iceCbs: ((c: DirectCandidate) => void)[] = [];
  const openCbs: (() => void)[] = [];
  const messageCbs: ((b: Uint8Array) => void)[] = [];
  const closeCbs: (() => void)[] = [];

  const emitClose = (): void => {
    if (closed || closeEmitted) return;
    closeEmitted = true;
    for (const cb of closeCbs) cb();
  };

  const attach = (channel: RTCDataChannel): void => {
    dc = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (!closed) for (const cb of openCbs) cb();
    };
    channel.onmessage = (event) => {
      if (closed) return;
      const data = event.data as ArrayBuffer | string;
      const bytes =
        typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
      for (const cb of messageCbs) cb(bytes);
    };
    channel.onclose = emitClose;
    channel.onerror = emitClose;
  };

  pc.onicecandidate = (event) => {
    if (closed || !event.candidate?.candidate) return;
    for (const cb of iceCbs) {
      cb({ candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid });
    }
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'disconnected' || s === 'failed' || s === 'closed') emitClose();
  };
  pc.ondatachannel = (event) => {
    if (!closed) attach(event.channel);
  };

  const flushCandidates = async (): Promise<void> => {
    remoteSet = true;
    for (const c of queuedCandidates.splice(0)) {
      try {
        await pc.addIceCandidate(c);
      } catch {}
    }
  };

  return {
    async createOffer() {
      attach(pc.createDataChannel('pair', { ordered: true }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      return offer.sdp ?? '';
    },
    async acceptOffer(sdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await flushCandidates();
      return answer.sdp ?? '';
    },
    async acceptAnswer(sdp) {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      await flushCandidates();
    },
    async addIceCandidate(c) {
      // 候选可能先于 answer 到达：远端描述未设前先排队
      if (!remoteSet) {
        queuedCandidates.push(c);
        return;
      }
      await pc.addIceCandidate(c);
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
      if (closed || dc?.readyState !== 'open') return false;
      if (dc.bufferedAmount > 1_048_576) return false;
      try {
        dc.send(bytes.slice().buffer as ArrayBuffer);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        dc?.close();
      } catch {}
      try {
        pc.close();
      } catch {}
    },
  };
}
