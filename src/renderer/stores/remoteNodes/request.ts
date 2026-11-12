import type { HostToPhone, PhoneToHost } from '@enso/pair';

const TIMEOUT_MS = 15_000;

type Requests = {
  'host-dirs': 'host-dirs-result';
  'project-add': 'project-add-result';
};
type ReplyOf<K extends keyof Requests> = Extract<HostToPhone, { type: Requests[K] }>;
type RequestOf<K extends keyof Requests> = Omit<Extract<PhoneToHost, { type: K }>, 'requestId'>;

const REPLY: Requests = { 'host-dirs': 'host-dirs-result', 'project-add': 'project-add-result' };

/** 向远程节点发一条带 requestId 的命令并等应答；发送失败、只读拦截与超时都折成 error（旧 host 不认识命令只会超时） */
export function requestNode(
  nodeId: string,
  command: RequestOf<'host-dirs'>
): Promise<ReplyOf<'host-dirs'>>;
export function requestNode(
  nodeId: string,
  command: RequestOf<'project-add'>
): Promise<ReplyOf<'project-add'>>;
export function requestNode<K extends keyof Requests>(
  nodeId: string,
  command: RequestOf<K>
): Promise<ReplyOf<K>> {
  const type = command.type as K;
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const finish = (error?: string, reply?: ReplyOf<K>) => {
      clearTimeout(timer);
      off();
      resolve(reply ?? ({ type: REPLY[type], requestId, error } as ReplyOf<K>));
    };
    const off = window.electronAPI.nodes.onMessage((message) => {
      if (message.nodeId !== nodeId) return;
      const payload = message.payload as HostToPhone;
      if (payload.type === 'command-rejected' && payload.command === type) {
        finish(payload.error);
      } else if (payload.type === REPLY[type] && payload.requestId === requestId) {
        finish(undefined, payload as ReplyOf<K>);
      }
    });
    const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS);
    void window.electronAPI.nodes
      .send(nodeId, { ...command, requestId } as PhoneToHost)
      .then((result) => {
        if (!result.ok) finish(result.error ?? 'offline');
      });
  });
}
