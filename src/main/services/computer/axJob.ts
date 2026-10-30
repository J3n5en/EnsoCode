import type { AxTreeNode } from '@shared/computer/axTree';
import type { AxWorkerRequest } from './axWorkerClient';

export type AxJobBridge = {
  snapshot(pid: number, maxDepth: number): Promise<AxTreeNode[]>;
  query(
    pid: number,
    query: { role?: string; title?: string; value?: string; description?: string; limit?: number }
  ): Promise<AxTreeNode[]>;
  /** pid 给定时只在该 app 内命中（不受遮挡它的其它窗口影响） */
  elementAt(x: number, y: number, pid?: number): Promise<AxTreeNode | null>;
  focused(): Promise<AxTreeNode | null>;
  node(handle: string): Promise<AxTreeNode>;
  attributes(handle: string): Promise<Array<[string, string]>>;
  children(handle: string): Promise<AxTreeNode[]>;
  perform(handle: string, action: string): Promise<void>;
  setValue(handle: string, value: string): Promise<void>;
  focus(handle: string): Promise<void>;
  /** 以下仅 macOS：句柄所属进程、按 pid 打开/恢复 Chromium/Electron 的 AX 树 */
  pid?(handle: string): Promise<number | undefined>;
  enable?(pid: number, bundleId?: string): Promise<{ changed: string[] }>;
  restoreEnable?(pid: number, attrs: string[]): Promise<void>;
};

function unsupported(op: string): never {
  throw new Error(`AX op '${op}' is not supported on this platform`);
}

export async function dispatchAxJob(ax: AxJobBridge, request: AxWorkerRequest): Promise<unknown> {
  switch (request.op) {
    case 'snapshot':
      return ax.snapshot(request.pid, request.maxDepth);
    case 'query':
      return ax.query(request.pid, request);
    case 'elementAt':
      return ax.elementAt(request.x, request.y, request.pid);
    case 'focused':
      return ax.focused();
    case 'node':
      return ax.node(request.handle);
    case 'attributes':
      return ax.attributes(request.handle);
    case 'children':
      return ax.children(request.handle);
    case 'perform':
      return ax.perform(request.handle, request.action);
    case 'setValue':
      return ax.setValue(request.handle, request.value);
    case 'focus':
      return ax.focus(request.handle);
    case 'pid':
      return ax.pid ? ax.pid(request.handle) : unsupported(request.op);
    case 'enable':
      return ax.enable ? ax.enable(request.pid, request.bundleId) : unsupported(request.op);
    case 'restoreEnable':
      return ax.restoreEnable
        ? ax.restoreEnable(request.pid, request.attrs)
        : unsupported(request.op);
  }
}

export function isAxPressUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bfailed \(-25206\)/.test(message);
}

export function axPressFallbackMessage(role: string, ref: string): string {
  return `AX press unsupported (-25206) on ${role} [${ref}]; no clickable bounds. Click the screenshot or a labeled descendant.`;
}
