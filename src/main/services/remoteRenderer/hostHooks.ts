import type { HostToPhone, RemoteToHost } from '@enso/pair';

export interface RemoteLink {
  pairId: string;
  /** 浏览器已声明能解 gzip（估算首次下载量用） */
  readonly gzip?: boolean;
  /** 浏览器已声明支持二进制加密帧 v2（零 Base64 / 原生压缩） */
  readonly v2?: boolean;
  send(message: HostToPhone): void;
}

interface RemoteHostHooks {
  command(link: RemoteLink, command: RemoteToHost): Promise<void>;
  linkDown(pairId: string): void;
  linkRevoked(pairId: string): void;
}

/** pairHost 只依赖这层轻量钩子；实现由 setupRemoteRenderer 注入，未启用时远程帧直接忽略 */
let hooks: RemoteHostHooks | null = null;

export function setRemoteHostHooks(next: RemoteHostHooks): void {
  hooks = next;
}

export const handleRemoteCommand = async (link: RemoteLink, command: RemoteToHost): Promise<void> =>
  hooks?.command(link, command);
export const remoteLinkDown = (pairId: string): void => hooks?.linkDown(pairId);
export const remoteLinkRevoked = (pairId: string): void => hooks?.linkRevoked(pairId);
