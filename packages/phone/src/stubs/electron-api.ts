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
        // 必须返回 null：桌面端契约是 Promise<string | null>，失败即 null。
        // 早先返回 { ok, content } 这种对象，调用方的 `content != null` 判断会通过，
        // 拿着对象去做字符串操作直接抛错，Promise 链断掉、界面永远停在加载态。
        read: async (): Promise<string | null> => null,
        search: async () => [],
        pathForFile: () => null,
      },
      agentRegistry: {
        // Composer 输入 @ 触发 useMentionSearch 拉 agent 注册表；缺这个字段会
        // 直接 TypeError 打崩渲染树（移动端输 @ 白屏）。返回 null 即无 agent 候选。
        list: async (): Promise<null> => null,
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
