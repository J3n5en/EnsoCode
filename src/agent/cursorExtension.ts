import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

// @rahularya01/pi-cursor 是标准 pi extension：default 导出接收 ExtensionAPI，
// 内部调 api.registerProvider('cursor', config)（config 即 pi ProviderConfigInput，带 oauth）。
// 这里传一个最小 shim，把注册转发到 enso 的 runtime；其余 TUI 能力 no-op。
let loaded = false;

/** 幂等加载 Cursor 扩展，向 runtime 注册 cursor 订阅 provider。best-effort：缺包/加载失败静默。 */
export async function loadCursorProvider(runtime: ModelRuntime): Promise<void> {
  if (loaded) return;
  loaded = true;
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
    console.warn('[cursor] extension load failed:', error);
  }
}
