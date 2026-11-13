import * as React from 'react';
import { type ComponentType, createElement, type ReactElement } from 'react';
import { type DraftRequest, type DraftResult, handleDraftRequest } from './draftBridge';
import {
  allocateSlotGeneration,
  clearPluginSlots,
  type PluginSlotEntry,
  registerPluginSlot,
} from './registry';

export interface PluginRendererDeps {
  importModule(pluginId: string, rel: string): Promise<{ onLoad?: (enso: unknown) => unknown }>;
  react: unknown;
  sessionId(): string | null;
  call(pluginId: string, method: string, args: unknown, sessionId: string | null): Promise<unknown>;
  draft(request: DraftRequest): DraftResult;
}

async function importAssetModule(
  pluginId: string,
  rel: string
): Promise<{ onLoad?: (enso: unknown) => unknown }> {
  const res = await window.electronAPI.extensionPlugins.asset(pluginId, rel);
  if (!res.ok) throw new Error(res.error);
  const bytes = Uint8Array.from(atob(res.base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  try {
    return (await import(/* @vite-ignore */ url)) as { onLoad?: (enso: unknown) => unknown };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 渲染进程里的默认依赖：从 Main 取模块源码，调用经 extensionPlugins.call 回去 */
export function createRendererDeps(sessionId: () => string | null): PluginRendererDeps {
  return {
    react: React,
    sessionId,
    importModule: importAssetModule,
    draft: handleDraftRequest,
    call: async (pluginId, method, args, sid) => {
      const result = await window.electronAPI.extensionPlugins.call({
        pluginId,
        method: 'renderer.call',
        payload: { method, args },
        sessionId: sid,
      });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
  };
}

const codedError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** 渲染模块与界面同权，草稿直接走本窗口的草稿桥；仍受内容指纹、引用与组字检查约束 */
function rendererComposer(deps: PluginRendererDeps) {
  const run = async (op: DraftRequest['op'], payload: Record<string, unknown>) => {
    const sessionId = deps.sessionId();
    if (!sessionId) throw codedError('NO_SESSION', '当前没有会话');
    const result = deps.draft({ sessionId, op, payload });
    if (!result.ok) throw codedError(result.code, result.error);
    return result.value;
  };
  return Object.freeze({
    readDraft: () => run('readDraft', {}),
    insertText: (input: { text: string }) => run('insertText', { text: input?.text }),
    replaceDraft: (input: { text: string; expect?: unknown }) =>
      run('replaceDraft', {
        text: input?.text,
        ...(input?.expect !== undefined ? { expect: input.expect } : {}),
      }),
  });
}

/**
 * 加载一个插件的渲染模块。模块在宿主页面里运行（完全信任，见设计第 1 节），
 * `onLoad` 里用 `enso.slots.register` 登记挂点；卸载时全部收回。
 */
export async function loadPluginRenderer(
  pluginId: string,
  rel: string,
  deps: PluginRendererDeps,
  options: { draft?: boolean } = {}
): Promise<{ dispose(): void }> {
  const mod = await deps.importModule(pluginId, rel);
  if (typeof mod.onLoad !== 'function') throw new Error('插件渲染模块没有导出 onLoad');
  const generation = allocateSlotGeneration();
  const disposers: (() => void)[] = [];
  let disposed = false;
  // 逐个收回：插件自己的清理函数可能抛错，不能跳过其后的挂点与 clearPluginSlots，
  // 也不能抛给宿主（宿主在 effect 清理里卸载，没有错误边界兜底会白屏）
  const release = () => {
    try {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch (error) {
          console.warn(`[plugin] ${pluginId} 渲染模块清理失败`, error);
        }
      }
    } finally {
      clearPluginSlots(pluginId, generation);
    }
  };
  const enso = {
    React: deps.react,
    slots: {
      register: (registration: Omit<PluginSlotEntry, 'pluginId' | 'uid'>) => {
        if (disposed) return () => {};
        const dispose = registerPluginSlot({ ...registration, pluginId, generation });
        disposers.push(dispose);
        return dispose;
      },
    },
    dispatch: (action: string, payload: Record<string, unknown>) => {
      if (action !== 'plugin.call') throw new Error(`未知动作 ${action}`);
      return deps.call(pluginId, String(payload.method ?? ''), payload.args, deps.sessionId());
    },
    ...(options.draft ? { composer: rendererComposer(deps) } : {}),
  };
  try {
    const returned = await mod.onLoad(enso);
    if (typeof returned === 'function') disposers.push(returned as () => void);
  } catch (error) {
    disposed = true;
    release();
    throw error;
  }
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      release();
    },
  };
}

export function PluginSlotView({
  entry,
  props,
}: {
  entry: PluginSlotEntry;
  props: Record<string, unknown>;
}): ReactElement {
  return createElement(entry.component as ComponentType<Record<string, unknown>>, props);
}
