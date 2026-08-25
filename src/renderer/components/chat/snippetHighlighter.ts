import { createHighlighter, type Highlighter } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/** 聊天正文代码块的常用语言；未列出的语言回退纯文本 */
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
] as const;

let instance: Promise<Highlighter> | null = null;

/** 独立的 shiki 单例：JS 正则引擎（顶层 shorthand 走 oniguruma WASM，会被 CSP script-src 'self' 拦截） */
function getHighlighter(): Promise<Highlighter> {
  instance ??= createHighlighter({
    themes: ['github-dark', 'github-light'],
    langs: [...LANGS],
    engine: createJavaScriptRegexEngine(),
  });
  return instance;
}

/** 代码转高亮 HTML（dual-theme，深色经 .dark CSS 变量切换）；语言不支持/失败返回 null */
export async function codeToHtml(code: string, language: string): Promise<string | null> {
  try {
    const highlighter = await getHighlighter();
    const lang = highlighter.getLoadedLanguages().includes(language) ? language : 'text';
    return highlighter.codeToHtml(code, {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: 'light',
    });
  } catch (error) {
    console.error('snippet highlight failed:', error);
    return null;
  }
}
