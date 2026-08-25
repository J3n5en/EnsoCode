import { preloadHighlighter } from '@pierre/diffs';

// github 主题对 markdown 内嵌 HTML 也着色（pierre 系不着）。
// 主题 chunk 来自 @shikijs/themes 动态 import——它是传递依赖，需显式安装 vite 才解析得到
export const CODE_THEME = { dark: 'github-dark', light: 'github-light' } as const;

/** 预热覆盖常见源码类型；未列出的语言回退纯文本 */
const LANGS = [
  'markdown',
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'css',
  'html',
  // markdown 内嵌 HTML include 的是 text.html.derivative，缺它则 md 里的 HTML 段整块无色
  'html-derivative',
  'python',
  'rust',
  'go',
  'shellscript',
  'yaml',
  'text',
] as const;

let warmup: Promise<void> | null = null;

/** Shiki 高亮器一次性预热（shiki-js 免 WASM）；失败也 resolve，回退无高亮 */
export function ensureHighlighter(): Promise<void> {
  warmup ??= preloadHighlighter({
    themes: [CODE_THEME.dark, CODE_THEME.light],
    langs: [...LANGS],
    preferredHighlighter: 'shiki-js',
  }).catch((error) => {
    // 失败也 resolve（回退无高亮）；报错留痕便于诊断主题/语言加载问题
    console.error('preloadHighlighter failed:', error);
  });
  return warmup;
}
