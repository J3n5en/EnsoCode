// 侧栏折叠状态只有 App 持有。窗口 keydown 与 macOS View 菜单走同一条订阅，
// 不要在两处各自 setState：菜单加速键和渲染层监听会在同一次按键里各触发一次。

type Toggle = () => void;

const toggles = new Set<Toggle>();

export function subscribeSidebarToggle(toggle: Toggle): () => void {
  toggles.add(toggle);
  return () => toggles.delete(toggle);
}

export function toggleSidebar(): void {
  for (const toggle of toggles) toggle();
}
