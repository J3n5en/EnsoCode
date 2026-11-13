import type { DropShelfAction, DropShelfLayout } from '@shared/dropShelf';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { ipcRenderer, webUtils } from 'electron';

/** 拖放浮窗 preload：不向页面暴露任何 API，拖放与状态切换都在这里完成 */

interface ShelfState {
  phase: 'in' | 'out' | 'done';
  layout?: DropShelfLayout;
  title?: string;
  detail?: string;
}

let depth = 0;
let idleTitle: string | null = null;
const root = () => document.documentElement;

/** single 整张卡都是「引用」；choice 按指针所在区域，落在缝隙里不算 */
function zoneAt(target: EventTarget | null): DropShelfAction | null {
  if (root().dataset.layout !== 'choice') return 'attach';
  const zone = target instanceof Element ? target.closest('[data-zone]') : null;
  const id = zone?.getAttribute('data-zone');
  return id === 'attach' || id === 'project' ? id : null;
}

function setOver(zone: DropShelfAction | null): void {
  if (zone) root().dataset.over = zone;
  else delete root().dataset.over;
}

ipcRenderer.on(IPC_CHANNELS.DROP_SHELF_STATE, (_event, state: ShelfState) => {
  const title = document.getElementById('title');
  idleTitle ??= title?.textContent ?? '';
  if (state.phase === 'in') {
    depth = 0;
    setOver(null);
    if (title) title.textContent = idleTitle;
    root().dataset.layout = state.layout ?? 'single';
    // 重新挂一次属性才能重播入场动画
    delete root().dataset.phase;
    void root().offsetWidth;
  }
  if (state.phase === 'done') {
    if (title && state.title) title.textContent = state.title;
    const detail = document.getElementById('detail');
    if (detail) detail.textContent = state.detail ?? '';
  }
  root().dataset.phase = state.phase;
});

window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  depth += 1;
  setOver(zoneAt(event.target));
});
window.addEventListener('dragleave', () => {
  depth = Math.max(0, depth - 1);
  if (depth === 0) setOver(null);
});
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  const zone = zoneAt(event.target);
  setOver(zone);
  if (event.dataTransfer) event.dataTransfer.dropEffect = zone ? 'copy' : 'none';
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  const action = zoneAt(event.target);
  depth = 0;
  setOver(null);
  const paths = action
    ? Array.from(event.dataTransfer?.files ?? [])
        .map((file) => webUtils.getPathForFile(file))
        .filter(Boolean)
    : [];
  ipcRenderer.send(IPC_CHANNELS.DROP_SHELF_DROP, { action, paths });
});
