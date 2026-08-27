import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { installPiCursorExecHook } from './installHook';

export const CURSOR_PROVIDER_ID = 'cursor';

let loaded = false;

/** 幂等注册 Cursor 订阅 provider（OAuth + catalog）。失败不影响其它 provider。 */
export async function loadCursorProvider(runtime: ModelRuntime): Promise<void> {
  if (loaded) return;
  loaded = true;
  installPiCursorExecHook();
  try {
    const mod = await import('@rahularya01/pi-cursor');
    const shim = {
      registerProvider: (id: string, config: unknown) => {
        (runtime.registerProvider as (id: string, config: unknown) => void)(id, config);
      },
      on: () => () => {},
      registerCommand: () => {},
      ui: {},
    };
    mod.default(shim);
  } catch (error) {
    loaded = false;
    console.warn('[cursor] extension load failed:', error);
  }
}

export function resetCursorProviderLoadForTests(): void {
  loaded = false;
}
