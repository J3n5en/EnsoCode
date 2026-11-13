/** 离屏测量：仍给 800×600 让 mermaid 排版，但 fixed+hidden，避免 iOS 把绝对定位大盒子滚进视口 */
export const MERMAID_OFFSCREEN_HOST_STYLE =
  'position:fixed;left:0;top:0;width:800px;height:600px;overflow:hidden;opacity:0;pointer-events:none;visibility:hidden;contain:strict;';

/** 避免 SVG 插入后成为可聚焦块，iOS 会 scrollIntoView 把聊天滚回图上 */
export function decorateMermaidSvg(svg: string): string {
  if (!svg.includes('<svg') || /\bfocusable=/.test(svg)) return svg;
  return svg.replace('<svg', '<svg focusable="false" tabindex="-1"');
}

/**
 * 图来自助手回复、仓库 README、插件 README 等不可信内容。loose 会跳过 mermaid 最后一步
 * DOMPurify、不过滤 click 链接的 URL；本应用不调用 bindFunctions，也用不到 loose 的点击回调。
 */
export function mermaidConfig(theme: string): Record<string, unknown> {
  return {
    startOnLoad: false,
    theme,
    securityLevel: 'strict',
    fontFamily: 'inherit',
    suppressErrorRendering: true,
    flowchart: { htmlLabels: false, useMaxWidth: true },
  };
}

const LINK_TAG = /<(?:a|area)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const LINK_ATTR = /\s(?:xlink:)?(?:href|target)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi;

/**
 * strict 仍保留 http(s) 的 click 链接（<a xlink:href> 不带 target），点击会让整个窗口跳走。
 * 只摘掉链接元素上的 href / target，图形照常显示；<use> 等图内引用不动。
 */
export function neutralizeMermaidLinks(svg: string): string {
  return svg.replace(LINK_TAG, (tag) => tag.replace(LINK_ATTR, ''));
}
