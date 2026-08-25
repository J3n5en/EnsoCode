import { preloadHighlighter } from '@pierre/diffs';

export const CODE_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const;

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
