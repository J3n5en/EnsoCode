import { createContext } from 'react';
import type { MarkdownLinkContextValue } from './Markdown';

/**
 * 只给 EditDiff 读当前文件用的会话标识。Bot 时间线用它，而不是 MarkdownLinkContext：
 * 后者还会让正文里的文件链接去开 Code 侧栏，Bot 视图没有那个侧栏。
 */
export const EditDiffSourceContext = createContext<MarkdownLinkContextValue | null>(null);
