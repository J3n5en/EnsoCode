/** `/compact [自定义摘要指令]` 的解析结果；null 表示这条文本不是 compact 命令 */
export interface CompactCommand {
  instructions?: string;
}

const COMPACT_RE = /^\/compact(?:\s+([\s\S]+))?$/i;

/** 句首 `/compact`（可带自定义摘要指令）。非命令返回 null，供 send() 直接透传给 agent。 */
export function parseCompactCommand(text: string): CompactCommand | null {
  const match = COMPACT_RE.exec(text.trim());
  if (!match) return null;
  const instructions = match[1]?.trim();
  return instructions ? { instructions } : {};
}
