/** auto-pop 信号由哪个顶栏消费。SidePanelHeaderActions 同时挂在空态水印（无 group）
 *  和每个有 tab 的分组 tab 条上；只有空态水印该弹。分组顶栏一挂载就说明面板已经
 *  建出来了（秘书面板自动打开、全局标签补进来、用户点了类型），此时再弹就是新建菜单
 *  盖在刚出现的 tab 上。秘书会话展开总会自动建秘书面板，也不弹。 */
export function headerNewTabPromptAt(input: {
  prompt: { conversationId: string; at: number } | null;
  conversationId: string | undefined;
  inGroup: boolean;
  secretary: boolean;
}): number | null {
  const { prompt, conversationId } = input;
  if (input.inGroup || input.secretary || !prompt || !conversationId) return null;
  return prompt.conversationId === conversationId ? prompt.at : null;
}

/** auto-pop（无 tab 展开自动弹出新建菜单）的放行判断。
 *
 *  菜单挂载首帧 floating-ui 就以当时的锚点几何定下位置与 --available-height。
 *  展开动画途中几何全是中途值；真机实测一旦撞进去，位置就停留在那里不再修正
 *  （底部/右侧被窗口裁掉、点击落空），窗口 resize 才触发重算。所以动画结束
 *  前一律按住不弹，等结束后再放，测量条件与手动点 + 一致——那条路径从不裁。
 *
 *  anchorLive：触发按钮还挂在 document 上。关掉最后一个 tab 后 dockview 会把空
 *  group 的 DOM 摘掉，但其中的水印 React 实例仍然挂着、仍订阅同一个信号；它若
 *  弹出，锚点 rect 全 0，弹层漂到窗口左上角，且没人卸载它就一直留着——就是
 *  「快速点几次出现两个、之后一直存在」。只让真正在页面上的那个实例响应。 */
export function newTabAutoPopOpen(input: {
  promptAt: number | null | undefined;
  layoutAnimating: boolean;
  anchorLive: boolean;
}): boolean {
  return input.promptAt != null && !input.layoutAnimating && input.anchorLive;
}

/** 顶栏右端「+ / 全屏 / 收起」平时收纳成一个「…」，hover 才展开。
 *  新建菜单开着或 auto-pop 信号待弹时必须强制展开：+ 是弹层锚点，被藏起
 *  （display:none）后 rect 归零，弹层就漂到窗口左上角；鼠标移进弹层时也已
 *  离开按钮组，单靠 hover 撑不住。 */
export function headerActionsPinned(input: {
  menuOpen: boolean;
  promptAt: number | null | undefined;
}): boolean {
  return input.menuOpen || input.promptAt != null;
}
