import type { DropShelfLayout } from '@shared/dropShelf';

export interface DropShelfCopy {
  title: string;
  idle: string;
  over: string;
  attach: string;
  attachHint: string;
  project: string;
  projectHint: string;
}

export const DROP_SHELF_WINDOW: Record<DropShelfLayout, { width: number; height: number }> = {
  single: { width: 364, height: 96 },
  choice: { width: 364, height: 140 },
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const DROP_ICON =
  '<path class="arrow" d="M12 3.5v10m-4-4 4 4 4-4"/><path d="M4.5 14.5v2a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-2"/>';
const FOLDER_ICON =
  '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path class="arrow" d="M12 11v5m-2.5-2.5h5"/>';

/** 浮窗是纯展示页：状态与拖放由 preload 驱动，页面本身不跑脚本 */
export function dropShelfPageUrl(copy: DropShelfCopy, accentHex: string): string {
  const accent = /^[0-9a-f]{6}$/i.test(accentHex) ? `#${accentHex}` : '#0a84ff';
  const zone = (id: string, icon: string, label: string, hint: string) =>
    `<div class="zone" data-zone="${id}"><div class="tile"><svg viewBox="0 0 24 24">${icon}</svg></div>
<div class="label">${escapeHtml(label)}</div><div class="hint">${escapeHtml(hint)}</div></div>`;
  const html = `<!doctype html><html data-layout="single"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root{--accent:${accent};color-scheme:light dark;
--surface:rgba(252,252,253,.96);--ring:rgba(0,0,0,.07);--title:#1d1d1f;--muted:rgba(60,60,67,.6);
--well:rgba(0,0,0,.035);--tile:color-mix(in srgb,var(--accent) 11%,transparent);
--shadow:0 12px 28px -10px rgba(0,0,0,.28),0 2px 6px -1px rgba(0,0,0,.08)}
@media (prefers-color-scheme:dark){:root{--surface:rgba(38,38,42,.96);--ring:rgba(255,255,255,.09);
--title:#f5f5f7;--muted:rgba(235,235,245,.55);--well:rgba(255,255,255,.045);
--tile:color-mix(in srgb,var(--accent) 22%,transparent);
--shadow:0 14px 32px -10px rgba(0,0,0,.65),0 2px 6px -1px rgba(0,0,0,.35)}}
*{box-sizing:border-box;margin:0}
html,body{height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;cursor:default}
body{padding:12px;font:13px/1.3 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;-webkit-font-smoothing:antialiased}
.shell{height:100%;opacity:0}
[data-phase=in] .shell,[data-phase=done] .shell{animation:enter .32s cubic-bezier(.16,1,.3,1) forwards}
[data-phase=out] .shell{opacity:1;animation:leave .16s cubic-bezier(.4,0,1,1) forwards}
@keyframes enter{from{opacity:0;transform:translateY(-10px) scale(.96)}to{opacity:1;transform:none}}
@keyframes leave{to{opacity:0;transform:translateY(-6px) scale(.98)}}
.card{height:100%;display:flex;align-items:center;border-radius:18px;
background:var(--surface);box-shadow:var(--shadow),inset 0 0 0 1px var(--ring);
transition:box-shadow .2s ease,transform .2s cubic-bezier(.16,1,.3,1)}
[data-layout=single][data-over] .card{transform:scale(1.025);box-shadow:var(--shadow),inset 0 0 0 1.5px var(--accent),
0 0 0 4px color-mix(in srgb,var(--accent) 16%,transparent)}
svg{width:22px;height:22px;grid-area:1/1;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.tile{flex:none;width:44px;height:44px;border-radius:13px;display:grid;place-items:center;
background:var(--tile);color:var(--accent);transition:background .2s ease,color .2s ease}
@keyframes bob{50%{transform:translateY(2px)}}
.single{flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:0 18px 0 12px}
[data-layout=single][data-over] .single .tile,[data-phase=done] .single .tile{background:var(--accent);color:#fff}
[data-layout=single][data-over] .single .arrow{animation:bob .9s ease-in-out infinite}
.check{display:none}
[data-phase=done] .drop{display:none}
[data-phase=done] .check{display:block}
[data-phase=done] .check path{stroke-dasharray:22;stroke-dashoffset:22;animation:draw .36s .05s cubic-bezier(.65,0,.35,1) forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.text{min-width:0;flex:1}
.title{font-size:13.5px;font-weight:600;letter-spacing:-.01em;color:var(--title);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{margin-top:3px;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub span{display:none}
.sub .idle{display:inline}
[data-over] .sub .idle{display:none}
[data-over] .sub .over{display:inline}
[data-phase=done] .sub span{display:none}
[data-phase=done] .sub .done{display:inline}
.zones{display:none;flex:1;height:100%;gap:8px;padding:10px}
[data-layout=choice] .single{display:none}
[data-layout=choice] .zones{display:flex}
[data-layout=choice][data-phase=done] .single{display:flex}
[data-layout=choice][data-phase=done] .zones{display:none}
.zone{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
border-radius:12px;background:var(--well);text-align:center;padding:0 8px;
transition:background .2s ease,box-shadow .2s ease,transform .2s cubic-bezier(.16,1,.3,1)}
.zone .tile{width:38px;height:38px;border-radius:11px;margin-bottom:8px}
.zone svg{width:20px;height:20px}
.zone *{pointer-events:none}
.label{max-width:100%;font-size:13px;font-weight:600;letter-spacing:-.01em;color:var(--title);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hint{max-width:100%;margin-top:2px;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-over=attach] [data-zone=attach],[data-over=project] [data-zone=project]{transform:scale(1.03);
background:color-mix(in srgb,var(--accent) 12%,transparent);box-shadow:inset 0 0 0 1.5px var(--accent)}
[data-over=attach] [data-zone=attach] .tile,[data-over=project] [data-zone=project] .tile{background:var(--accent);color:#fff}
[data-over=attach] [data-zone=attach] .arrow,[data-over=project] [data-zone=project] .arrow{animation:bob .9s ease-in-out infinite}
</style></head><body><div class="shell"><div class="card">
<div class="single"><div class="tile">
<svg class="drop" viewBox="0 0 24 24">${DROP_ICON}</svg>
<svg class="check" viewBox="0 0 24 24"><path d="M5.5 12.5l4.2 4.2 8.8-9.2"/></svg>
</div>
<div class="text"><div class="title" id="title">${escapeHtml(copy.title)}</div>
<div class="sub"><span class="idle">${escapeHtml(copy.idle)}</span><span class="over">${escapeHtml(copy.over)}</span><span class="done" id="detail"></span></div></div></div>
<div class="zones">${zone('attach', DROP_ICON, copy.attach, copy.attachHint)}${zone('project', FOLDER_ICON, copy.project, copy.projectHint)}</div>
</div></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
