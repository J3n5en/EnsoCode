import type { Plugin } from 'vite';

/** 可能落到被替换模块上的导入：末段是这几个名字（含 index、目录本身） */
const CANDIDATE = /(?:^|\/)(?:sessions|settings|i18n|ghosttyTheme|index|\.{1,2})(?:\.tsx?)?$/;

/**
 * 按解析后的真实路径把桌面模块换成 PWA 桩。vite alias 只认 `@/stores/sessions` 这种写法，
 * 桌面源码里的相对导入（如 stores/ 下的 `./sessions`）会绕过它，把真 store 打进精简壳：
 * 真 store 在模块求值时就读 window.electronAPI，整包起不来（#349 引入的「reading 'agent'」）。
 * stubs：真实文件绝对路径 → 桩绝对路径。
 */
export function desktopStubs(stubs: Record<string, string>): Plugin {
  return {
    name: 'enso-desktop-stubs',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !CANDIDATE.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return (resolved && stubs[resolved.id]) ?? null;
    },
  };
}
