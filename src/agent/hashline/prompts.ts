export const HASHLINE_READ_GUIDELINES = [
  'When Hashline is on, read prefixes text files with [path#TAG] and numbered lines; copy that header into later edit input.',
];

export const HASHLINE_GREP_GUIDELINES = [
  'When Hashline is on, grep prefixes hit files with [path#TAG] header anchors; copy a hit file header into later edit input.',
];

export const HASHLINE_EDIT_GUIDELINES = [
  'Prefer edit input that starts with [path#TAG] from a prior read/grep, then PUT/CUT/MV/REM. If there is no tag, use path + edits replace. Never invent or fabricate a tag.',
];

export function withGuidelines<T extends { promptGuidelines?: string[] }>(
  tool: T,
  extra: readonly string[]
): T {
  const stock = Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines : [];
  return { ...tool, promptGuidelines: [...stock, ...extra] };
}
