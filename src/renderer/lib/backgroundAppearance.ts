/** 壁纸只在全局背景层合成一次；面板不能再次叠加同一档透明度。 */
export function backgroundAppearance(visibility: number) {
  const wallpaperOpacity = Math.min(1, Math.max(0, visibility));
  return {
    wallpaperOpacity,
    panelAlpha: 0,
    popoverAlpha: Math.max(1 - wallpaperOpacity, 0.92),
  };
}
