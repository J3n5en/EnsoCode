export const AGY_SIGNED_OUT_LINE_PREFIXES = [
  'Open the following link to authenticate',
  'https://accounts.google.com/',
] as const;

/** 固定文案。调用方不得把 stdout 原文拼进来。 */
export const AGY_SIGNED_OUT_MESSAGE =
  'agy is not signed in. Run agy in a terminal to sign in, then detect again.';

export const AGY_PROTOCOL_ERROR_MESSAGE =
  'agy returned a non-ACP line. Check the CLI version and sign-in state.';

export type StdoutLine =
  | { kind: 'empty' }
  | { kind: 'json'; value: unknown }
  | { kind: 'signed-out' }
  | { kind: 'protocol-error' };

/** 登录链接行只标 signed-out，不把 URL 留在结果里。其余非 JSON 行是协议错误。 */
export function classifyStdoutLine(line: string): StdoutLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'empty' };
  if (AGY_SIGNED_OUT_LINE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return { kind: 'signed-out' };
  }
  try {
    return { kind: 'json', value: JSON.parse(trimmed) as unknown };
  } catch {
    return { kind: 'protocol-error' };
  }
}
