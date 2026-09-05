import type { Element, Root } from 'hast';
import { defaultSchema, type Schema } from 'hast-util-sanitize';
import { visit } from 'unist-util-visit';

/**
 * data: URL 只允许这些位图/图像 mime 子类型。含 svg：虽然 SVG 是可执行 XML，但
 * `img.src` 最终只会被 react-markdown 渲染成真实 `<img>` DOM 元素（不用
 * dangerouslySetInnerHTML），而 `<svg>` 标签本身不在 `tagNames` 白名单里（不会以
 * 存活 DOM 节点形式出现）——浏览器对作为图片加载的 SVG 实施“图片上下文”
 * 隔离（禁脚本、禁外部资源拉取、交互失效），因此内容是否带 `<script>`/事件处理
 * 属性不影响安全。
 */
const ALLOWED_DATA_IMAGE_PREFIX = /^data:image\/(png|jpe?g|gif|webp|bmp|x-icon|svg\+xml);/i;

/**
 * Files 面板 Markdown 预览的 HTML 白名单：在 hast-util-sanitize 的 GitHub 风格
 * 默认白名单（已含 p/h1/b/img/details/summary、align/width/height 等布局属性）
 * 基础上：
 * - 放行图片解析后注入的 `data:` src（配合 `rehypeRejectUnsafeImageSrc` 二次校验 mime
 *   子类型，只放行位图与 SVG——SVG 虽可执行，但 `img.src` 总是渲染成真实 `<img>` 元素，
 *   浏览器对图片上下文的 SVG 隔离使内嵌脚本不执行）；
 * - 去掉 `source` 标签的 `srcSet`（响应式图片非本功能所需，收窄攻击面）。
 * 其余协议（href 仍是 http/https/mailto 等，不含 javascript:）维持默认，不放松。
 * 聊天气泡（`components/chat/Markdown.tsx`）不使用这条白名单，不受影响。
 */
export function buildFilePreviewSanitizeSchema(): Schema {
  return {
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      source: [],
    },
    protocols: {
      ...defaultSchema.protocols,
      src: [...(defaultSchema.protocols?.src ?? []), 'data'],
    },
  };
}

/**
 * `rehype-sanitize` 的协议白名单只按 scheme（`data:`）放行，不识别 `data:` 内部的
 * mime 子类型——任意 `data:xxx;base64,...` 都会被当成合法图片放过。这里在 sanitize
 * 之后再过滤一遍 `img.src`，非本功能支持的位图/SVG mime 的 data: URL 一律摘掉
 * （防止把 `data:text/html;base64,...` 之类的奇怪载体当成图片塞进 `img.src`）。
 */
export function rehypeRejectUnsafeImageSrc() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'img') return;
      const src = node.properties?.src;
      if (typeof src !== 'string' || !src.startsWith('data:')) return;
      if (!ALLOWED_DATA_IMAGE_PREFIX.test(src)) delete node.properties.src;
    });
  };
}
