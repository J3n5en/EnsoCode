interface KoffiLib {
  func(name: string, ret: string, args: unknown[]): () => boolean;
}

type ScreenCaptureApi = { preflight: () => boolean; request: () => boolean };

let cached: Promise<ScreenCaptureApi | null> | undefined;

function loadScreenCaptureApi(): Promise<ScreenCaptureApi | null> {
  cached ??= (async () => {
    if (process.platform !== 'darwin') return null;
    try {
      const koffi = (await import('koffi')).default as { load(path: string): KoffiLib };
      const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
      return {
        preflight: cg.func('CGPreflightScreenCaptureAccess', 'bool', []),
        request: cg.func('CGRequestScreenCaptureAccess', 'bool', []),
      };
    } catch {
      return null;
    }
  })();
  return cached;
}

export async function preflightScreenCaptureAccess(): Promise<boolean> {
  const api = await loadScreenCaptureApi();
  try {
    return Boolean(api?.preflight());
  } catch {
    return false;
  }
}

/** 会阻塞等待 macOS 屏幕录制 TCC 授权弹窗，并把本进程加入系统设置。 */
export async function requestScreenCaptureAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    const api = await loadScreenCaptureApi();
    if (!api) return false;
    if (api.preflight()) return true;
    return Boolean(api.request());
  } catch {
    return false;
  }
}
