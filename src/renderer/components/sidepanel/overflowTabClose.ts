export function overflowTabList(from: Element): Element | null {
  return from.closest('.dv-tabs-overflow-container');
}

/** 关面板前记下溢出行。关完之后行内的 React 节点可能已经卸掉。 */
export function snapshotOverflowRows(list: Element): Map<string, Element> {
  const rows = new Map<string, Element>();
  for (const child of list.children) {
    if (!child.classList.contains('dv-tab')) continue;
    const id = child.querySelector('[data-panel-id]')?.getAttribute('data-panel-id');
    if (id) rows.set(id, child);
  }
  return rows;
}

function hasOverflowTab(list: Element): boolean {
  for (const child of list.children) {
    if (child.classList.contains('dv-tab')) return true;
  }
  return false;
}

function dismissOverflowList(list: Element): void {
  const anchor = list.closest('.dv-popover-anchor');
  const popover = list.parentElement;
  if (anchor && popover && popover.parentElement === anchor) {
    popover.remove();
    return;
  }
  list.remove();
}

/** 溢出下拉是打开瞬间的 DOM 快照，关面板不会刷新它。空了就卸下弹出层。 */
export function removeOverflowRows(list: Element, rows: readonly Element[]): void {
  for (const row of rows) {
    if (row.parentElement === list) row.remove();
  }
  if (!hasOverflowTab(list)) dismissOverflowList(list);
}
