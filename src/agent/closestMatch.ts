const MAX_SHOWN = 40;
const MAX_OCCURRENCES = 64;

/**
 * 匹配失败时文件里最接近的区域：每条非空期望行按去空白后相同投票给候选起点，
 * 票数最多的起点即最接近处。返回带行号的原文提示，找不到任何相同行时为空串。
 */
export function closestMatchHint(fileLines: readonly string[], wanted: readonly string[]): string {
  const positions = new Map<string, number[]>();
  fileLines.forEach((line, index) => {
    const key = line.trim();
    if (!key) return;
    const list = positions.get(key);
    if (!list) positions.set(key, [index]);
    else if (list.length < MAX_OCCURRENCES) list.push(index);
  });
  const votes = new Map<number, number>();
  wanted.forEach((line, offset) => {
    for (const index of positions.get(line.trim()) ?? []) {
      const start = index - offset;
      votes.set(start, (votes.get(start) ?? 0) + 1);
    }
  });
  let best: number | undefined;
  let bestVotes = 0;
  for (const [start, count] of votes) {
    if (count > bestVotes || (count === bestVotes && best !== undefined && start < best)) {
      best = start;
      bestVotes = count;
    }
  }
  if (best === undefined) return '';
  const from = Math.max(0, best - 1);
  const to = Math.min(fileLines.length, best + wanted.length + 1, from + MAX_SHOWN);
  const shown = fileLines
    .slice(from, to)
    .map((line, index) => `${String(from + index + 1).padStart(6)}| ${line}`);
  return `Closest match in the current file (lines ${from + 1}-${to}); copy the old text from here:\n${shown.join('\n')}`;
}
