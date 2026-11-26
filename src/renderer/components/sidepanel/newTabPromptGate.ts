/** auto-pop（无 tab 展开自动弹出新建菜单）的放行判断。
 *
 *  菜单挂载首帧 floating-ui 就以当时的锚点几何定下位置与 --available-height。
 *  展开动画途中几何全是中途值；真机实测一旦撞进去，位置就停留在那里不再修正
 *  （底部/右侧被窗口裁掉、点击落空），窗口 resize 才触发重算。所以动画结束
 *  前一律按住不弹，等结束后再放，测量条件与手动点 + 一致——那条路径从不裁。 */
export function newTabAutoPopOpen(input: {
  promptAt: number | null | undefined;
  layoutAnimating: boolean;
}): boolean {
  return input.promptAt != null && !input.layoutAnimating;
}
