/**
 * 面板是否升进窗口顶栏行：升出工作区的那段在设置层覆盖范围（内容区 inset-0）之外，
 * 设置打开时工作区只加 invisible，而 dockview 的 .dv-view 自带 visible 打穿继承，
 * tab 条会残留在顶栏。设置开着时回落进工作区，随它一起藏起来。
 */
export function liftsIntoTitleRow(input: {
  titleRow: boolean;
  isMobile: boolean;
  settingsOpen: boolean;
}): boolean {
  return input.titleRow && !input.isMobile && !input.settingsOpen;
}
