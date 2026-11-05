/** 选中下划线相对滚动视口的位置。负 x 表示标签已滚出左缘，由轨道裁掉。 */
export function indicatorOffset(
  chip: { left: number; width: number },
  viewportLeft: number
): { x: number; width: number } {
  return { x: chip.left - viewportLeft, width: Math.max(0, chip.width) };
}
