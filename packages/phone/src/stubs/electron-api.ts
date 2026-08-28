/**
 * PWA 侧的 electronAPI 降级实现。
 * 复用的桌面组件里有少量直接调用（EditDiff 读原文件、TaskNoteRow 读日志、
 * Composer 的 @ 文件搜索），它们都写有降级分支：返回空即自动退化
 * （diff 退成片段对比、日志不展开、@ 无候选）。装在入口最先执行。
 */

export function installElectronApiShim(): void {
  if ((window as { electronAPI?: unknown }).electronAPI) return;
  Object.defineProperty(window, 'electronAPI', {
    value: {
      files: {
        read: async () => ({ ok: false as const, content: '' }),
        search: async () => [],
        pathForFile: () => null,
      },
      agent: {
        stopTask: async () => ({ ok: false as const, error: 'not supported on phone' }),
      },
      providers: {
        getOauthUsage: async () => null,
      },
    },
    writable: false,
  });
}
