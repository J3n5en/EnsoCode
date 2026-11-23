/** 完整版诊断文本：用户从设备抽屉复制发给开发者，排查手机上的卡顿 */
export function formatDiagnostics(input: {
  now: number;
  bornAt: number;
  build: string;
  userAgent: string;
  visibility: string;
  link: unknown;
  trace: readonly string[];
}): string {
  const clock = (ms: number) => new Date(ms).toISOString().slice(11, 23);
  const lines = input.trace.map((line) => {
    const match = /^(\d+) (.*)$/.exec(line);
    if (!match) return line;
    const offset = Number(match[1]);
    return `${clock(input.bornAt + offset)} +${offset}ms ${match[2]}`;
  });
  return [
    `EnsoCode 完整版诊断 ${new Date(input.now).toISOString()}`,
    `build ${input.build || '-'} · ${input.visibility}`,
    input.userAgent,
    `页面已运行 ${Math.round((input.now - input.bornAt) / 1000)}s`,
    `link ${JSON.stringify(input.link)}`,
    '--- trace (UTC) ---',
    ...lines,
  ].join('\n');
}
