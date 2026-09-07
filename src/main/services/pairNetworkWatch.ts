import os from 'node:os';
import { type NetworkInterfaceSnapshot, networkFingerprint } from '@enso/pair';

const DEFAULT_POLL_MS = 3_000;

export function startPairNetworkWatch(opts?: {
  pollMs?: number;
  readNics?: () => NetworkInterfaceSnapshot;
  onChange: () => void;
}): () => void {
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const readNics = opts?.readNics ?? (() => os.networkInterfaces() as NetworkInterfaceSnapshot);
  let last = networkFingerprint(readNics());
  const timer = setInterval(() => {
    const next = networkFingerprint(readNics());
    if (next === last) return;
    last = next;
    opts?.onChange();
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
