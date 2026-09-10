import { EDIT_REPLACE_GUIDELINE } from '../editTool';

export const HASHLINE_READ_GUIDELINES = [
  'When Hashline is on, read returns a [path#TAG] header followed by numbered lines. To edit that file with a hashline patch, put the header as the first line of the edit `input` string.',
];

export const HASHLINE_GREP_GUIDELINES = [
  'When Hashline is on, grep prefixes hit files with a [path#TAG] header; that header can be the first line of a hashline edit `input`.',
];

/** 唯一支持的 op 语法；也是报错时回给模型的纠正样例 */
export const HASHLINE_PUT_RULE =
  'PUT <start>.=<end>: replaces lines start..end (inclusive, 1-based numbers from the read) with the following lines, each prefixed with "+".';
export const HASHLINE_PUT_EXAMPLE = '[src/a.ts#1A2B]\nPUT 3.=4:\n+const a = 1;\n+const b = 2;';

export const HASHLINE_EDIT_DESCRIPTION =
  'Edit a single file in one of two mutually exclusive modes — never send both in one call. ' +
  '(1) Hashline: only `input`, a patch whose first line is the exact [path#TAG] header from the latest read/grep/write of that file, followed by one or more PUT blocks. ' +
  '(2) Replace: exact, unique text replacements. Use replace when you have no fresh tag. Mixed calls are rejected. ' +
  EDIT_REPLACE_GUIDELINE;

export const HASHLINE_EDIT_GUIDELINES = [
  'edit has two exclusive modes: hashline `input` (header line + PUT blocks) or replace `path` + `edits`. Do not put the [path#TAG] header in `input` and the change in `edits` — pick one mode. Sending both is rejected.',
  `Hashline supports only PUT. ${HASHLINE_PUT_RULE} To delete lines, PUT a wider range and re-emit the lines you keep. Never invent or fabricate a tag.`,
];

export const HASHLINE_WRITE_GUIDELINES = [
  'When Hashline is on, a successful write returns [path#TAG] plus numbered lines of the written file; that header can be the first line of a later hashline edit `input`.',
];

export const EDIT_INVALID_MESSAGE =
  'edit needs exactly one mode: hashline `input` ([path#TAG] header line + PUT blocks), or replace `path` + `edits` [{oldText, newText}]. Do not send both.';

export const EDIT_MIXED_MESSAGE =
  'edit was called with both hashline `input` and replace `edits`/`oldText`. Send exactly one mode in this call: only `input` (header line + PUT blocks), or only `path` + `edits` [{oldText, newText}].';

export function withGuidelines<T>(tool: T, extra: readonly string[]): T {
  const current = tool as T & { promptGuidelines?: string[] };
  const stock = Array.isArray(current.promptGuidelines) ? current.promptGuidelines : [];
  return { ...current, promptGuidelines: [...stock, ...extra] };
}
